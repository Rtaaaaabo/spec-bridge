import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  DocStore,
  INDEX_PAGE,
  QUESTIONS_PAGE,
  buildDocsPullRequestBody,
  buildDocsPullRequestTitle,
  formatUsageSummary,
  runPipeline,
  type DocChange,
} from "@spec-bridge/core";
import {
  checkoutForAnalysis,
  fetchPullRequest,
  isDocsRepoEvent,
  parseRepoFullName,
  publishDocsAsPullRequest,
  type GitHubAuth,
  type MergedPullRequestEvent,
  type Octokit,
} from "@spec-bridge/github";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";

export interface HandlerConfig {
  /** ドキュメントの提出先 `owner/repo` */
  docsRepo: string;
  docsBaseBranch?: string;
  /**
   * GitHub の認証。App の installation トークンか PAT のどちらか（`resolveGitHubAuth()`）。
   *
   * **リポジトリごとに解決する。** 解析対象と docs リポジトリは別のインストールになりうるので、
   * トークン1本を使い回さない。
   */
  auth: GitHubAuth;
}

export interface HandlerResult {
  status: "skipped" | "published" | "failed";
  detail: string;
  prUrl?: string;
  /** 失敗時に解析結果を退避した場所 */
  preservedPath?: string;
}

/**
 * 失敗した解析結果を退避する。
 *
 * 解析には数分かかる。PR 作成が権限エラーで落ちただけで結果を捨てるのは損失が大きいので、
 * 生成済みのドキュメントだけは残す。**ソースコードのチェックアウトは退避しない**
 * （永続化しないというセキュリティ上の約束を崩さないため）。
 */
async function preserveDocs(
  docsDir: string,
  event: MergedPullRequestEvent,
): Promise<string | null> {
  try {
    const entries = await readdir(join(docsDir, "features")).catch(() => []);
    if (entries.length === 0) return null;

    const slug = `${event.repo.replace("/", "-")}-${event.number}-${Date.now().toString(36)}`;
    const destination = join(homedir(), ".spec-bridge", "failed", slug);
    await mkdir(dirname(destination), { recursive: true });
    await cp(docsDir, destination, { recursive: true });
    return destination;
  } catch {
    return null;
  }
}

/**
 * マージされた PR を1件処理する。
 *
 *   PR取得 → 解析用に浅くクローン → 解析 → docs リポジトリへ PR → クローンを破棄
 *
 * ソースコードは一時ディレクトリにしか置かず、処理後に必ず消す。
 */
export async function handleMergedPullRequest(
  event: MergedPullRequestEvent,
  config: HandlerConfig,
  log: (line: string) => void = () => {},
): Promise<HandlerResult> {
  // docs リポジトリ自身の PR を解析すると、マージのたびに次の PR を生む無限ループになる
  if (isDocsRepoEvent(event.repo, config.docsRepo)) {
    return {
      status: "skipped",
      detail: "docs リポジトリ自身の PR のため処理しません（自己ループ防止）",
    };
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoFullName(event.repo));
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }

  // 解析対象リポジトリの認証。webhook が installation id を運んでくるので、
  // App 運用ではそれをそのまま使える（リポジトリから引き直す API 呼び出しを省ける）
  const source = await config.auth.forRepo(event.repo, event.installationId);
  const pr = await fetchPullRequest({ owner, repo, number: event.number }, source.octokit);
  log(`▸ ${event.repo}#${event.number} ${pr.title}（${pr.changedFiles.length} ファイル）`);

  // docs リポジトリは別のインストールになりうるので、ここで一度解決して**設定ミスを先に落とす**。
  // 数分かけて解析したあとに「App が docs リポジトリに入っていない」と分かるのは高すぎる。
  const docsAuthCheck = await config.auth.forRepo(config.docsRepo);
  log(`  docs リポジトリの認証を確認（${config.auth.kind}）`);

  const checkout = await checkoutForAnalysis({
    repo: event.repo,
    sha: event.mergeCommitSha,
    token: source.token,
  });
  const docsDir = await mkdtemp(join(tmpdir(), "spec-bridge-docs-"));

  try {
    // 既存ドキュメントを docs リポジトリから取り込んでから解析する
    // （そうしないと毎回「新規作成」になり、既存の記述を引き継げない）
    const existingCount = await hydrateExistingDocs(
      docsAuthCheck.octokit,
      config.docsRepo,
      docsDir,
      log,
    );
    log(`  docs リポジトリから ${existingCount} 件のドキュメントを取得`);

    const result = await runPipeline(pr, {
      repoPath: checkout.path,
      docsPath: docsDir,
      log,
    });
    log(`  ${formatUsageSummary(result.usage)}`);

    if (result.skipped) {
      return { status: "skipped", detail: result.classification.reason };
    }
    if (result.updated.length === 0) {
      return { status: "failed", detail: "更新されたドキュメントがありません" };
    }

    const store = new DocStore(docsDir);
    const changes: DocChange[] = [];
    const files: Array<{ path: string; content: string }> = [];

    for (const updated of result.updated) {
      const doc = await store.get(updated.id);
      if (!doc) continue;
      changes.push({ doc, breakdown: updated.breakdown, warnings: updated.warnings });
      files.push({
        path: relative(docsDir, updated.path),
        content: await readFile(updated.path, "utf8"),
      });
    }

    // インデックスページと確認事項の一覧も更新する（`writeIndexPage` が一緒に書いている）
    for (const page of [INDEX_PAGE, QUESTIONS_PAGE]) {
      files.push({ path: page, content: await readFile(join(docsDir, page), "utf8") });
    }

    const { owner: docsOwner, repo: docsRepoName } = parseRepoFullName(config.docsRepo);

    // 解析に数分かかっており、最初に取ったトークンは失効に近づいている。
    // 取り直す（有効なら同じものが返る）
    const docs = await config.auth.forRepo(config.docsRepo);

    const published = await publishDocsAsPullRequest(
      { owner: docsOwner, repo: docsRepoName, baseBranch: config.docsBaseBranch },
      files,
      {
        title: buildDocsPullRequestTitle(pr, changes),
        body: buildDocsPullRequestBody(pr, changes),
        branchSuffix: `${repo}-${event.number}`,
      },
      docs.octokit,
    );

    log(`  ✓ PR 作成: ${published.prUrl}`);
    return {
      status: "published",
      detail: `${published.changedFiles} ファイルを提出しました`,
      prUrl: published.prUrl,
    };
  } catch (error) {
    // 解析結果まで到達していれば退避する。数分の処理を権限エラーひとつで捨てない
    const preservedPath = await preserveDocs(docsDir, event);
    const message = error instanceof Error ? error.message : String(error);
    if (preservedPath) {
      log(`  ⚠ 解析結果を退避しました: ${preservedPath}`);
    }
    return {
      status: "failed",
      detail: message,
      ...(preservedPath ? { preservedPath } : {}),
    };
  } finally {
    // ソースコードのチェックアウトは失敗時も必ず消す（永続化しない約束のため）
    await checkout.cleanup();
    await rm(docsDir, { recursive: true, force: true });
  }
}

/** docs リポジトリの既存ドキュメントをローカルの作業ディレクトリへ展開する */
async function hydrateExistingDocs(
  octokit: Octokit,
  docsRepo: string,
  destination: string,
  log: (line: string) => void,
): Promise<number> {
  const { owner, repo } = parseRepoFullName(docsRepo);

  try {
    const listing = await octokit.rest.repos.getContent({ owner, repo, path: "features" });
    if (!Array.isArray(listing.data)) return 0;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(destination, "features"), { recursive: true });

    let count = 0;
    for (const entry of listing.data) {
      if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
      const file = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: entry.path,
      });
      if (Array.isArray(file.data) || file.data.type !== "file") continue;
      await writeFile(
        join(destination, "features", entry.name),
        Buffer.from(file.data.content, "base64").toString("utf8"),
        "utf8",
      );
      count += 1;
    }
    return count;
  } catch {
    // features ディレクトリがまだ無い（初回）
    log("  docs リポジトリに既存ドキュメントはありません");
    return 0;
  }
}
