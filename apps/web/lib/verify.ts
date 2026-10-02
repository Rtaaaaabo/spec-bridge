import { DocStore, markVerified, verifiedFiles } from "@spec-bridge/core";
import {
  BranchMovedError,
  commitFilesToBranch,
  ensurePullRequest,
  parseRepoFullName,
  readDocsFromRepo,
  resolveGitHubAuth,
} from "@spec-bridge/github";
import { localDocsPath } from "./config.ts";
import { invalidateDocsCache, viewerDocsRepo } from "./docs.ts";

export type VerifyResult =
  | { kind: "committed"; url: string }
  | { kind: "pull-request"; url: string }
  | { kind: "local" }
  | { kind: "already" };

/** 利用者に返してよい失敗。それ以外は 500 にする */
export class VerifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 機能ドキュメントをレビュー済にする。
 *
 * **docs リポジトリの既定ブランチへ直接コミットする。** レビューは人がその場で下す判断で、
 * さらに PR をマージする手間を挟むと押す意味が薄れる。
 * 既定ブランチが保護されていて直接書けないときだけ、PR を作ってそのリンクを返す。
 *
 * 読むのはキャッシュではなく最新。読んだコミットを起点に書き、その間に誰かが積んでいたら
 * 上書きせずに止める（`BranchMovedError`）。
 */
export async function verifyDoc(id: string, login: string): Promise<VerifyResult> {
  const repo = await viewerDocsRepo();
  if (!repo) return verifyLocal(id, login);

  const { octokit } = await resolveGitHubAuth().forRepo(repo);
  const read = await readDocsFromRepo(octokit, repo);
  const doc = read.docs.find((d) => d.meta.id === id);
  if (!doc) throw new VerifyError(`機能ドキュメントが見つかりません: ${id}`, 404);
  if (doc.meta.status === "verified") return { kind: "already" };

  const verified = markVerified(doc, { login, date: today() });
  const files = verifiedFiles(read.docs, verified);
  const message = `docs: 「${doc.body.title}」をレビュー済にする（@${login}）`;
  const { owner, repo: name } = parseRepoFullName(repo);

  try {
    const commit = await commitFilesToBranch(
      { owner, repo: name },
      { branch: read.ref, files, message, expectedHead: read.commitSha ?? undefined },
      octokit,
    );
    invalidateDocsCache(repo);
    return { kind: "committed", url: `https://github.com/${repo}/commit/${commit.commitSha}` };
  } catch (error) {
    if (error instanceof BranchMovedError) throw new VerifyError(error.message, 409);
    const status = (error as { status?: number }).status;
    // 保護されたブランチ（や、確かめた直後に積まれた早送りでない更新）は直接書けない。PR に回す
    if (status !== 403 && status !== 409 && status !== 422) throw error;
  }

  const branch = `spec-bridge/verify-${id}-${Date.now().toString(36)}`;
  await commitFilesToBranch({ owner, repo: name, baseBranch: read.ref }, { branch, files, message }, octokit);
  const pr = await ensurePullRequest(
    { owner, repo: name, baseBranch: read.ref },
    {
      branch,
      title: message,
      body:
        `@${login} が spec-bridge の画面から「${doc.body.title}」をレビュー済にしました。\n\n` +
        `既定ブランチ（${read.ref}）に直接書き込めなかったため、PR にしています。マージすると反映されます。`,
    },
    octokit,
  );
  return { kind: "pull-request", url: pr.prUrl };
}

/** docs リポジトリが決まっていないローカル開発用。ディレクトリのファイルを書き換える */
async function verifyLocal(id: string, login: string): Promise<VerifyResult> {
  const path = localDocsPath();
  if (!path) throw new VerifyError("書き込む docs リポジトリが決まっていません", 400);
  const store = new DocStore(path);
  const doc = await store.get(id);
  if (!doc) throw new VerifyError(`機能ドキュメントが見つかりません: ${id}`, 404);
  if (doc.meta.status === "verified") return { kind: "already" };
  await store.save(markVerified(doc, { login, date: today() }));
  await store.writeIndexPage();
  return { kind: "local" };
}
