import type { Job, JobInput, JobStore } from "@spec-bridge/jobs";
import type { SurveyedFeature } from "@spec-bridge/core";

/** ランの開始（機能の列挙） */
export const BACKFILL_SURVEY = "backfill.survey";
/** 機能1件の書き起こし */
export const BACKFILL_FEATURE = "backfill.feature";
/** 一覧ページの再生成と PR の作成 */
export const BACKFILL_FINISH = "backfill.finish";

export const BACKFILL_KINDS = [BACKFILL_SURVEY, BACKFILL_FEATURE, BACKFILL_FINISH] as const;

/** ランごとに1つ。ブランチ名とジョブの紐づけに使う */
export interface BackfillRun {
  runId: string;
  /** 解析対象 `org/repo` */
  repo: string;
  /** 提出先 `org/repo` */
  docsRepo: string;
  /** 提出先のブランチ。機能ごとのコミットを積み増す */
  branch: string;
  /** 列挙する機能数の上限 */
  limit: number;
  /**
   * このランで使ってよい額（USD）。超えたら残りの機能を書かずに終える。
   *
   * バックフィルは1機能あたり約 $1.7。12機能で $20 を超える。
   * **誰かに触らせる前に要る歯止め**で、無ければ1回のクリックで青天井になる。
   */
  budgetUsd: number;
}

export function surveyJob(run: BackfillRun, tenantId = "local"): JobInput {
  return {
    kind: BACKFILL_SURVEY,
    tenantId,
    dedupeKey: `${BACKFILL_SURVEY}:${run.runId}`,
    payload: { ...run },
  };
}

export function featureJob(
  run: BackfillRun,
  feature: SurveyedFeature,
  position: { index: number; total: number },
  sha: string | null,
  tenantId = "local",
): JobInput {
  const id = feature.docId ?? feature.newDocId ?? `feature-${position.index}`;
  return {
    kind: BACKFILL_FEATURE,
    tenantId,
    // 同じランで同じ機能を二度書かない
    dedupeKey: `${BACKFILL_FEATURE}:${run.runId}:${id}`,
    payload: { ...run, feature, index: position.index, total: position.total, sha },
  };
}

export function finishJob(
  run: BackfillRun,
  summary: { surveyed: number; sha: string | null },
  tenantId = "local",
): JobInput {
  return {
    kind: BACKFILL_FINISH,
    tenantId,
    dedupeKey: `${BACKFILL_FINISH}:${run.runId}`,
    payload: { ...run, ...summary },
  };
}

/** payload からランの情報を取り出す。DB から来る値なので検証する */
export function parseRun(payload: Record<string, unknown>): BackfillRun {
  const { runId, repo, docsRepo, branch, limit, budgetUsd } = payload as Partial<BackfillRun>;
  if (
    typeof runId !== "string" ||
    typeof repo !== "string" ||
    typeof docsRepo !== "string" ||
    typeof branch !== "string"
  ) {
    throw new Error(`バックフィルの payload を解釈できません: ${JSON.stringify(payload)}`);
  }
  return {
    runId,
    repo,
    docsRepo,
    branch,
    limit: typeof limit === "number" ? limit : 20,
    budgetUsd: typeof budgetUsd === "number" ? budgetUsd : DEFAULT_BUDGET_USD,
  };
}

/** 指定が無いときの予算。1機能 約 $1.7 の実測から、12〜14機能ぶん */
export const DEFAULT_BUDGET_USD = 25;

export interface RunProgress {
  /** 終わった機能（成功） */
  done: number;
  /** 失敗して終わった機能 */
  failed: number;
  /** まだ終わっていない機能（queued / running） */
  pending: number;
  /**
   * ここまでに使った額。**列挙（survey）のぶんも含む。**
   *
   * 機能ジョブだけを足すと、実測として外に出す数字が過少になる
   * （実際に踏んだ: 列挙 $0.27 が PR 本文に載っていなかった）。
   */
  costUsd: number;
  /** エージェントを呼んだ回数。ジョブ数ではない */
  agentRuns: number;
  /** ランの開始時刻（列挙ジョブが積まれた時刻）。所要時間の起点 */
  startedAt: Date | null;
  /**
   * 最後に仕事が動いた時刻。所要時間の終点。
   *
   * 「いま」を終点にすると、仕上げが待ち合わせや再試行で遅れたぶんだけ所要時間が水増しされる
   * （実際に踏んだ: 手で仕上げを回し直したら 4分24秒 が 12分27秒 になった）。
   */
  finishedAt: Date | null;
}

/**
 * ランの進み具合を、兄弟ジョブから集計する。
 *
 * ラン専用の表を持たず、ジョブ表だけで済ませている。
 * 機能ジョブが成功時に `costUsd` を結果へ入れるので、それを足すだけで予算が分かる。
 */
export async function runProgress(store: JobStore, runId: string): Promise<RunProgress> {
  // 件数は機能ジョブだけを数え、消費量はランの全ジョブから足す
  const jobs = await store.find({
    kinds: [BACKFILL_SURVEY, BACKFILL_FEATURE],
    payloadMatch: { runId },
  });

  let done = 0;
  let failed = 0;
  let pending = 0;
  let costUsd = 0;
  let agentRuns = 0;
  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;

  for (const job of jobs) {
    costUsd += numberOr(job.result?.["costUsd"], 0);
    agentRuns += numberOr(job.result?.["agentRuns"], 0);
    if (!finishedAt || job.updatedAt > finishedAt) finishedAt = job.updatedAt;

    if (job.kind === BACKFILL_SURVEY) {
      startedAt = job.createdAt;
      continue;
    }
    if (job.state === "succeeded") done += 1;
    else if (job.state === "failed") failed += 1;
    else pending += 1;
  }
  return { done, failed, pending, costUsd, agentRuns, startedAt, finishedAt };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * この機能を書き始めてよいか。
 *
 * 予算は**着手前**に見る。走らせてから超過に気づいても、その1件の費用はもう出ている。
 */
export function withinBudget(progress: RunProgress, budgetUsd: number): boolean {
  return progress.costUsd < budgetUsd;
}

/**
 * 仕上げに入ってよいか（まだ動いている機能が無いか）。
 *
 * ワーカーが複数いる場合、機能ジョブの完了順は保証されない。
 * **終わっていない兄弟がいるあいだは、仕上げを後ろへずらす**（自分を積み直す）。
 */
export function readyToFinish(progress: RunProgress): boolean {
  return progress.pending === 0;
}

/** 仕上げを待たせる間隔 */
export const FINISH_RETRY_MS = 30_000;

/** ランの実時間。起点も終点も分からなければ 0 */
export function runElapsedMs(progress: RunProgress): number {
  if (!progress.startedAt || !progress.finishedAt) return 0;
  return Math.max(0, progress.finishedAt.getTime() - progress.startedAt.getTime());
}

/** ジョブの結果に入れる、機能1件ぶんの記録 */
export interface FeatureJobResult extends Record<string, unknown> {
  docId: string;
  costUsd: number;
  confidence: number;
  skipped?: "over-budget";
}

/** そのジョブが「予算超過で書かずに終えた」ものか */
export function wasSkippedForBudget(job: Job): boolean {
  return job.result?.["skipped"] === "over-budget";
}
