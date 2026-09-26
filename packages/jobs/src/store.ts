import type { EnqueueResult, Job, JobInput, JobState } from "./types.ts";

export interface ClaimOptions {
  /** 取得したジョブを何ミリ秒ぶん占有するか。処理中は `heartbeat` で延長する */
  leaseMs: number;
  /** 指定した種類だけを取る。省略すると全種類 */
  kinds?: string[];
}

export interface JobQuery {
  kinds?: string[];
  states?: JobState[];
  /**
   * payload がこの組を含むジョブだけを返す（部分一致）。
   *
   * 用途は「同じランの兄弟ジョブを探す」こと。バックフィルは機能ごとにジョブを分けるので、
   * 予算の積み上げと、最後の仕上げを待ち合わせるのに要る。
   */
  payloadMatch?: Record<string, unknown>;
  limit?: number;
}

/**
 * ジョブの置き場所。
 *
 * Postgres 実装（本番）とメモリ実装（テストと、DB を用意していないローカル）で入れ替える。
 * **ロジックは `Worker` 側に寄せ、ここは素直な永続化に留める。**
 */
export interface JobStore {
  /**
   * 積む。同じ `dedupeKey` の仕事があれば積まない（`created: false`）。
   *
   * ただし**失敗して終わった仕事だけは積み直す**。GitHub の Redeliver で
   * 「前回落ちた解析をもう一度」ができないと、手で直す手段が無くなるため。
   */
  enqueue(input: JobInput): Promise<EnqueueResult>;

  /** 実行できるジョブを1件ロックして取り出す。無ければ null */
  claim(options: ClaimOptions): Promise<Job | null>;

  /** リースを延長する。解析は数分〜30分かかるので、処理中に取り上げられないようにする */
  heartbeat(id: string, leaseMs: number): Promise<void>;

  succeed(id: string, result?: Record<string, unknown>): Promise<void>;

  /** `retry` を渡すと `queued` に戻す。渡さなければ `failed` で終える */
  fail(id: string, error: string, retry?: { runAfter: Date }): Promise<void>;

  get(id: string): Promise<Job | null>;

  /** 条件に合うジョブを返す。並びは作成順 */
  find(query: JobQuery): Promise<Job[]>;

  close(): Promise<void>;
}
