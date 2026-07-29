import { Octokit } from "octokit";
import { createOctokit } from "./index.ts";

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

/** ブランチ名に使えない文字を落とす */
function sanitizeBranchSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * 機能ドキュメントを docs リポジトリへ **PR として** 提出する。
 *
 * 直接 push しないのが要点。生成物は `status: draft`（AI生成・未レビュー）なので、
 * 人間のレビューを経て初めてマージされる。この PR が承認フローそのものになる。
 */
export async function publishDocsAsPullRequest(
  target: DocsRepoTarget,
  files: PublishFile[],
  pr: { title: string; body: string; branchSuffix: string },
  octokit: Octokit = createOctokit(),
): Promise<PublishResult> {
  if (files.length === 0) {
    throw new Error("公開するファイルが1件もありません");
  }

  const { owner, repo } = target;

  const base =
    target.baseBranch ??
    (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  const baseSha = baseRef.data.object.sha;

  const branch = `spec-bridge/${sanitizeBranchSegment(pr.branchSuffix)}-${Date.now().toString(36)}`;

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  // blob → tree → commit の順に作る。1コミットに全ファイルが入るので中途半端な状態が残らない
  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, sha: blob.data.sha };
    }),
  );

  const baseCommit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
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
    message: pr.title,
    tree: tree.data.sha,
    parents: [baseSha],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });

  const created = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base,
    title: pr.title,
    body: pr.body,
  });

  return {
    prNumber: created.data.number,
    prUrl: created.data.html_url,
    branch,
    changedFiles: files.length,
  };
}
