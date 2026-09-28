import type { JobInput } from "@spec-bridge/jobs";
import type { MergedPullRequestEvent } from "@spec-bridge/github";

/** マージされた PR を1件解析するジョブの種類 */
export const ANALYZE_PR = "analyze.pr";

/**
 * 同じ PR を二度解析しないための鍵。
 *
 * マージコミットまで含めるのは、**同じ PR 番号でも内容が変われば別の仕事**だから
 * （PR を revert して再マージした場合など）。GitHub の再送や手動 Redeliver では
 * 同じ SHA が来るので、そちらは弾ける。
 */
export function analyzeDedupeKey(event: MergedPullRequestEvent): string {
  return `${ANALYZE_PR}:${event.repo.toLowerCase()}#${event.number}:${event.mergeCommitSha ?? "no-sha"}`;
}

export function analyzeJob(event: MergedPullRequestEvent, tenantId = "local"): JobInput {
  return {
    kind: ANALYZE_PR,
    tenantId,
    dedupeKey: analyzeDedupeKey(event),
    payload: {
      repo: event.repo,
      number: event.number,
      mergeCommitSha: event.mergeCommitSha,
      installationId: event.installationId,
    },
  };
}

/**
 * ジョブの payload をイベントに戻す。
 *
 * **payload は DB から来る**（別プロセスが書いた、古い形かもしれない値）ので、
 * webhook のペイロードと同じく検証してから使う。壊れていたら再試行しても直らないので、
 * 例外にして `failed` で終わらせる。
 */
export function parseAnalyzePayload(payload: Record<string, unknown>): MergedPullRequestEvent {
  const repo = payload["repo"];
  const number = payload["number"];
  if (typeof repo !== "string" || !repo.includes("/") || typeof number !== "number") {
    throw new Error(`ジョブの payload を解釈できません: ${JSON.stringify(payload)}`);
  }
  const sha = payload["mergeCommitSha"];
  const installationId = payload["installationId"];
  return {
    repo,
    number,
    mergeCommitSha: typeof sha === "string" ? sha : null,
    installationId: typeof installationId === "number" ? installationId : null,
  };
}
