/**
 * ジョブの状態。
 *
 * `running` は「誰かがリースを持っている」という意味で、リースが切れた `running` は
 * 取り直しの対象になる（ワーカーが落ちた場合に仕事が消えないように）。
 */
export const JOB_STATES = ["queued", "running", "succeeded", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobInput {
  /** `analyze.pr` / `backfill.survey` など。種類は増えるので文字列で持つ */
  kind: string;
  /** テナント。テナント表が入るまでは `local` 固定 */
  tenantId: string;
  /**
   * 同じ仕事を二度積まないための鍵。**一意制約**。
   *
   * webhook は 202 を先に返すので GitHub 側から再送されうるし、手動の Redeliver もある。
   * 鍵が同じなら積まない（= PR が2つできない）。
   */
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** この時刻まで実行しない。バックオフ後の再試行にも使う */
  runAfter?: Date;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  kind: string;
  tenantId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  state: JobState;
  /** 実行を開始した回数。`claim` のたびに増える */
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  /** `running` のあいだだけ入る。これを過ぎたら他のワーカーが取り直してよい */
  leaseUntil: Date | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueResult {
  job: Job;
  /** 既に同じ `dedupeKey` の仕事があって積まなかった場合は false */
  created: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
