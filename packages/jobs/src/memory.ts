import { DEFAULT_MAX_ATTEMPTS, type EnqueueResult, type Job, type JobInput } from "./types.ts";
import type { ClaimOptions, JobStore } from "./store.ts";

/**
 * メモリ上のジョブ置き場。
 *
 * 用途は2つ。**テスト**（`Worker` のループを DB 無しで検証する）と、
 * **DB を用意していないローカル実行**（プロセスを落とすと消えることは起動時に警告する）。
 */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  private sequence = 0;
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: JobInput): Promise<EnqueueResult> {
    const existing = [...this.jobs.values()].find((job) => job.dedupeKey === input.dedupeKey);
    if (existing) {
      // 失敗して終わったものだけ積み直す（Redeliver で拾い直せるように）
      if (existing.state !== "failed") return { job: existing, created: false };
      const revived: Job = {
        ...existing,
        state: "queued",
        attempts: 0,
        runAfter: input.runAfter ?? this.now(),
        leaseUntil: null,
        lastError: null,
        payload: input.payload,
        updatedAt: this.now(),
      };
      this.jobs.set(revived.id, revived);
      return { job: revived, created: true };
    }

    const timestamp = this.now();
    const job: Job = {
      id: `job-${++this.sequence}`,
      kind: input.kind,
      tenantId: input.tenantId,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      state: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      runAfter: input.runAfter ?? timestamp,
      leaseUntil: null,
      lastError: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }

  async claim(options: ClaimOptions): Promise<Job | null> {
    const now = this.now();
    const candidates = [...this.jobs.values()]
      .filter((job) => !options.kinds || options.kinds.includes(job.kind))
      .filter((job) => {
        if (job.state === "queued") return job.runAfter <= now;
        // リースが切れた running は、ワーカーが落ちたものとみなして取り直す
        return job.state === "running" && job.leaseUntil !== null && job.leaseUntil < now;
      })
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime());

    const next = candidates[0];
    if (!next) return null;

    const claimed: Job = {
      ...next,
      state: "running",
      attempts: next.attempts + 1,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      updatedAt: now,
    };
    this.jobs.set(claimed.id, claimed);
    return claimed;
  }

  async heartbeat(id: string, leaseMs: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return;
    this.jobs.set(id, {
      ...job,
      leaseUntil: new Date(this.now().getTime() + leaseMs),
      updatedAt: this.now(),
    });
  }

  async succeed(id: string, result?: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.set(id, {
      ...job,
      state: "succeeded",
      leaseUntil: null,
      result: result ?? null,
      updatedAt: this.now(),
    });
  }

  async fail(id: string, error: string, retry?: { runAfter: Date }): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.set(id, {
      ...job,
      state: retry ? "queued" : "failed",
      runAfter: retry?.runAfter ?? job.runAfter,
      leaseUntil: null,
      lastError: error,
      updatedAt: this.now(),
    });
  }

  async get(id: string): Promise<Job | null> {
    return this.jobs.get(id) ?? null;
  }

  async close(): Promise<void> {}

  /** テストと診断用。状態の内訳を数える */
  countByState(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const job of this.jobs.values()) counts[job.state] = (counts[job.state] ?? 0) + 1;
    return counts;
  }
}
