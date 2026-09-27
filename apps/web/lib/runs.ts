import { BACKFILL_KINDS, summarizeRuns, type RunSummary } from "@spec-bridge/backfill";
import { PostgresJobStore, type Job } from "@spec-bridge/jobs";
import { ANALYZE_PR_KIND } from "./kinds.ts";
import { databaseUrl } from "./config.ts";

/**
 * ジョブ表を読むだけの入口。
 *
 * 画面は**読むだけ**で、ジョブの意味づけ（ランへのまとめ方）は
 * `@spec-bridge/backfill` に置く。表示のために状態を別に持たない。
 */
async function withStore<T>(run: (store: PostgresJobStore) => Promise<T>): Promise<T> {
  const store = new PostgresJobStore(databaseUrl());
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  const jobs = await withStore((store) => store.find({ kinds: [...BACKFILL_KINDS], limit: 500 }));
  return summarizeRuns(jobs).slice(0, limit);
}

/** webhook から積まれた PR 解析。「マージしたのに何も起きない」の切り分けに使う */
export async function listAnalyzeJobs(limit = 10): Promise<Job[]> {
  const jobs = await withStore((store) => store.find({ kinds: [ANALYZE_PR_KIND], limit: 200 }));
  return jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}
