import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  DocStore,
  buildDocsPullRequestBody,
  buildDocsPullRequestTitle,
  runPipeline,
  type DocChange,
} from "@spec-bridge/core";
import {
  checkoutForAnalysis,
  createOctokit,
  fetchPullRequest,
  isDocsRepoEvent,
  publishDocsAsPullRequest,
  type MergedPullRequestEvent,
} from "@spec-bridge/github";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";

export interface HandlerConfig {
  /** ドキュメントの提出先 `owner/repo` */
  docsRepo: string;
  docsBaseBranch?: string;
  githubToken?: string;
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

  const [owner, repo] = event.repo.split("/");
  if (!owner || !repo) {
    return { status: "failed", detail: `リポジトリ名を解釈できません: ${event.repo}` };
  }

  const octokit = createOctokit(config.githubToken);
  const pr = await fetchPullRequest({ owner, repo, number: event.number }, octokit);
  log(`▸ ${event.repo}#${event.number} ${pr.title}（${pr.changedFiles.length} ファイル）`);

  const checkout = await checkoutForAnalysis({
    repo: event.repo,
    sha: event.mergeCommitSha,
    token: config.githubToken ?? process.env.GITHUB_TOKEN,
  });
  const docsDir = await mkdtemp(join(tmpdir(), "spec-bridge-docs-"));

  try {
    // 既存ドキュメントを docs リポジトリから取り込んでから解析する
    // （そうしないと毎回「新規作成」になり、既存の記述を引き継げない）
    const existingCount = await hydrateExistingDocs(
      octokit,
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

    // インデックスページも更新する
    files.push({
      path: "README.md",
      content: await readFile(join(docsDir, "README.md"), "utf8"),
    });

    const [docsOwner, docsRepoName] = config.docsRepo.split("/");
    if (!docsOwner || !docsRepoName) {
      return { status: "failed", detail: `docs リポジトリ名が不正です: ${config.docsRepo}` };
    }

    const published = await publishDocsAsPullRequest(
      { owner: docsOwner, repo: docsRepoName, baseBranch: config.docsBaseBranch },
      files,
      {
        title: buildDocsPullRequestTitle(pr, changes),
        body: buildDocsPullRequestBody(pr, changes),
        branchSuffix: `${repo}-${event.number}`,
      },
      octokit,
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
  octokit: ReturnType<typeof createOctokit>,
  docsRepo: string,
  destination: string,
  log: (line: string) => void,
): Promise<number> {
  const [owner, repo] = docsRepo.split("/");
  if (!owner || !repo) return 0;

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
