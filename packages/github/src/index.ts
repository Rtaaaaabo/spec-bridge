import type { PullRequestInput } from "@spec-bridge/core";
import type { Octokit } from "./octokit.ts";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** https://github.com/owner/repo/pull/123 または owner/repo#123 を解釈する */
export function parsePullRequestRef(input: string): PullRequestRef {
  const url = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (url?.[1] && url[2] && url[3]) {
    return { owner: url[1], repo: url[2], number: Number(url[3]) };
  }
  const short = input.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short?.[1] && short[2] && short[3]) {
    return { owner: short[1], repo: short[2], number: Number(short[3]) };
  }
  throw new Error(
    `PR の指定を解釈できません: "${input}"\n` +
      `期待する形式: https://github.com/owner/repo/pull/123 または owner/repo#123`,
  );
}

/** 1ファイルあたりの patch 取り込み上限。巨大な生成物で解析が溺れるのを防ぐ */
const MAX_PATCH_CHARS = 20_000;

/**
 * PR の本文と変更ファイルを取得する。
 *
 * `octokit` は必須。既定で env のトークンを使うと、認証の渡し忘れが
 * 「別テナントの認証情報で読む」に化ける（`octokit.ts` の `createOctokit` 参照）。
 */
export async function fetchPullRequest(
  ref: PullRequestRef,
  octokit: Octokit,
): Promise<PullRequestInput> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  });

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });

  return {
    repo: `${ref.owner}/${ref.repo}`,
    number: ref.number,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    branch: pr.head.ref,
    mergedAt: pr.merged_at,
    changedFiles: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ? f.patch.slice(0, MAX_PATCH_CHARS) : null,
    })),
  };
}

export * from "./octokit.ts";
export * from "./app-auth.ts";
export * from "./docs-repo.ts";
export * from "./webhook.ts";
export * from "./checkout.ts";
