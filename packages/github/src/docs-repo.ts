import type { Octokit } from "./octokit.ts";

export interface DocsRepoTarget {
  owner: string;
  repo: string;
  /** PR のベースブランチ。省略時はリポジトリの既定ブランチ */
  baseBranch?: string;
}

export interface PublishFile {
  /** リポジトリルートからの相対パス */
  path: string;
  content: string;
}

export interface PublishResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  changedFiles: number;
}

const BOOTSTRAP_README = `# 機能仕様ドキュメント

[spec-bridge](https://github.com/Rtaaaaabo/spec-bridge) が PR から自動生成・更新します。

まだドキュメントはありません。最初の PR がマージされると \`features/\` の下に作られます。
`;

/**
 * ベースブランチの SHA を返す。リポジトリが空なら初期コミットを作ってから返す。
 *
 * 作りたてのリポジトリにはコミットが1つもなく、`heads/main` の ref すら存在しない。
 * docs リポジトリを空で用意するのは自然な出発点なので、ここで面倒を見る。
 */
export async function resolveBaseSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
): Promise<string> {
  try {
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
    return ref.data.object.sha;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 409) throw error;
  }

  // 完全に空のリポジトリでは Git Data API（blob / tree / commit）が一切使えず、
  // createBlob すら 409 "Git Repository is empty" になる。
  // 最初の1コミットだけは Contents API で作る必要がある。
  const created = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: "README.md",
    message: "chore: initialize docs repository",
    content: Buffer.from(BOOTSTRAP_README, "utf8").toString("base64"),
    branch: base,
  });

  const sha = created.data.commit.sha;
  if (!sha) throw new Error("docs リポジトリの初期化に失敗しました");
  return sha;
}

/** ブランチ名に使えない文字を落とす */
function sanitizeBranchSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** ブランチの先端 SHA。存在しなければ null */
async function branchHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  try {
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return ref.data.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export interface CommitResult {
  branch: string;
  commitSha: string;
  /** そのブランチを今回作ったか */
  createdBranch: boolean;
}

/**
 * ファイル一式を1コミットにまとめてブランチへ積む。
 *
 * ブランチが無ければベースから作る。**あれば、その先端に積み増す。**
 * バックフィルは機能ごとに別プロセス（別ジョブ）で書くので、
 * 1本のブランチに少しずつ積めることが要る。
 *
 * blob → tree → commit の順に作るので、1コミットに全ファイルが入り、
 * 中途半端な状態が残らない。
 */
export async function commitFilesToBranch(
  target: DocsRepoTarget,
  options: { branch: string; files: PublishFile[]; message: string },
  octokit: Octokit,
): Promise<CommitResult> {
  if (options.files.length === 0) {
    throw new Error("コミットするファイルが1件もありません");
  }
  const { owner, repo } = target;

  let head = await branchHeadSha(octokit, owner, repo, options.branch);
  const createdBranch = head === null;

  if (head === null) {
    const base =
      target.baseBranch ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
    const baseSha = await resolveBaseSha(octokit, owner, repo, base);
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${options.branch}`,
      sha: baseSha,
    });
    head = baseSha;
  }

  const blobs = await Promise.all(
    options.files.map(async (file) => {
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, sha: blob.data.sha };
    }),
  );

  const headCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: head });

  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: headCommit.data.tree.sha,
    tree: blobs.map((b) => ({
      path: b.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: b.sha,
    })),
  });

  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: options.message,
    tree: tree.data.sha,
    parents: [head],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${options.branch}`,
    sha: commit.data.sha,
  });

  return { branch: options.branch, commitSha: commit.data.sha, createdBranch };
}

export interface EnsurePullRequestResult {
  prNumber: number;
  prUrl: string;
  /** 今回作ったか（既にあった PR を使い回した場合は false） */
  created: boolean;
}

/**
 * そのブランチの PR が無ければ作り、あれば本文を更新して使い回す。
 *
 * バックフィルは機能ごとにコミットを積むので、**PR を開くのは最後の1回**にしたい。
 * 途中で中断して再実行した場合に PR が2つできないよう、既存を探してから作る。
 */
export async function ensurePullRequest(
  target: DocsRepoTarget,
  options: { branch: string; title: string; body: string },
  octokit: Octokit,
): Promise<EnsurePullRequestResult> {
  const { owner, repo } = target;
  const base =
    target.baseBranch ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${options.branch}`,
    state: "open",
    per_page: 1,
  });

  const open = existing.data[0];
  if (open) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: open.number,
      title: options.title,
      body: options.body,
    });
    return { prNumber: open.number, prUrl: open.html_url, created: false };
  }

  const created = await octokit.rest.pulls.create({
    owner,
    repo,
    head: options.branch,
    base,
    title: options.title,
    body: options.body,
  });
  return { prNumber: created.data.number, prUrl: created.data.html_url, created: true };
}

/** ブランチ名を作る。同じ接尾辞でも衝突しないよう時刻を混ぜる */
export function docsBranchName(suffix: string): string {
  return `spec-bridge/${sanitizeBranchSegment(suffix)}-${Date.now().toString(36)}`;
}

/**
 * 機能ドキュメントを docs リポジトリへ **PR として** 提出する。
 *
 * 直接 push しないのが要点。生成物は `status: draft`（AI生成・未レビュー）なので、
 * 人間のレビューを経て初めてマージされる。この PR が承認フローそのものになる。
 *
 * `octokit` は必須。**docs リポジトリを触る認証は、解析対象リポジトリのものとは別**で、
 * 既定値で env から作ると取り違えに気づけない（`octokit.ts` の `createOctokit` 参照）。
 */
export async function publishDocsAsPullRequest(
  target: DocsRepoTarget,
  files: PublishFile[],
  pr: { title: string; body: string; branchSuffix: string },
  octokit: Octokit,
): Promise<PublishResult> {
  const branch = docsBranchName(pr.branchSuffix);
  const commit = await commitFilesToBranch(
    target,
    { branch, files, message: pr.title },
    octokit,
  );
  const created = await ensurePullRequest(
    target,
    { branch: commit.branch, title: pr.title, body: pr.body },
    octokit,
  );

  return {
    prNumber: created.prNumber,
    prUrl: created.prUrl,
    branch: commit.branch,
    changedFiles: files.length,
  };
}
