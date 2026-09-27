import { BACKFILL_FEATURE, BACKFILL_FINISH, BACKFILL_KINDS } from "./kinds.ts";
import { BACKFILL_SURVEY } from "./kinds.ts";
import type { Job } from "@spec-bridge/jobs";

/** ランの見え方。**ジョブの状態から導くだけで、ラン専用の表は持たない** */
export type RunState = "running" | "succeeded" | "failed" | "over-budget";

export interface RunSummary {
  runId: string;
  /** 解析対象 `org/repo` */
  repo: string;
  docsRepo: string;
  branch: string;
  state: RunState;
  /** 列挙された機能数。列挙がまだなら null */
  surveyed: number | null;
  done: number;
  failed: number;
  pending: number;
  /** 予算超過で書かずに終えた機能 */
  skipped: number;
  costUsd: number;
  budgetUsd: number | null;
  prUrl: string | null;
  startedAt: Date;
  updatedAt: Date;
  /** 最後に起きた失敗。困っているランを見分けるのに使う */
  lastError: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * ジョブの並びをラン単位にまとめる。
 *
 * **画面のためにラン表を作らない。** 状態を二重に持つと必ず食い違うので、
 * 唯一の事実であるジョブ表から毎回導く。並びは新しいランが先。
 */
export function summarizeRuns(jobs: Job[]): RunSummary[] {
  const runs = new Map<string, RunSummary>();

  for (const job of jobs) {
    const runId = text(job.payload["runId"]);
    if (!runId) continue;
    if (!BACKFILL_KINDS_SET.has(job.kind)) continue;

    const summary = runs.get(runId) ?? {
      runId,
      repo: text(job.payload["repo"]) ?? "?",
      docsRepo: text(job.payload["docsRepo"]) ?? "?",
      branch: text(job.payload["branch"]) ?? "?",
      state: "running" as RunState,
      surveyed: null,
      done: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      costUsd: 0,
      budgetUsd: num(job.payload["budgetUsd"]),
      prUrl: null,
      startedAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastError: null,
    };

    // 費用を足すのは**実際に LLM を呼ぶ2種類だけ**。
    // 仕上げジョブの結果にはラン全体の集計が入るので、足すと二重計上になる（実データで踏んだ）
    if (job.kind === BACKFILL_SURVEY || job.kind === BACKFILL_FEATURE) {
      summary.costUsd += num(job.result?.["costUsd"]) ?? 0;
    }
    if (job.createdAt < summary.startedAt) summary.startedAt = job.createdAt;
    if (job.updatedAt > summary.updatedAt) summary.updatedAt = job.updatedAt;
    if (job.state === "failed" && job.lastError) summary.lastError = job.lastError;

    if (job.kind === BACKFILL_SURVEY) {
      summary.surveyed = num(job.result?.["surveyed"]);
      // 列挙に失敗したランは、機能ジョブが1つも積まれない
      if (job.state === "failed") summary.state = "failed";
    } else if (job.kind === BACKFILL_FEATURE) {
      if (job.state === "succeeded") {
        summary.done += 1;
        if (job.result?.["skipped"] === "over-budget") summary.skipped += 1;
      } else if (job.state === "failed") summary.failed += 1;
      else summary.pending += 1;
    } else if (job.kind === BACKFILL_FINISH) {
      summary.prUrl = text(job.result?.["prUrl"]) ?? summary.prUrl;
      if (job.state !== "succeeded" && summary.state !== "failed") summary.state = "running";
    }

    runs.set(runId, summary);
  }

  for (const summary of runs.values()) {
    if (summary.state === "failed") continue;
    // PR まで出ていれば終わり。予算で打ち切ったランは、そうと分かるようにする
    if (summary.prUrl) summary.state = summary.skipped > 0 ? "over-budget" : "succeeded";
    else summary.state = "running";
  }

  return [...runs.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

const BACKFILL_KINDS_SET = new Set<string>(BACKFILL_KINDS);

/** 「3/8 機能」のような進み具合の文字列 */
export function progressLabel(run: RunSummary): string {
  const total = run.surveyed ?? run.done + run.failed + run.pending;
  if (total === 0) return run.state === "running" ? "列挙中…" : "対象なし";
  return `${run.done + run.failed} / ${total} 機能`;
}
