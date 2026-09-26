import { backoffMs, isTransient } from "./retry.ts";
import type { JobStore } from "./store.ts";
import type { Job } from "./types.ts";

export interface JobContext {
  log: (line: string) => void;
  /** 長い処理の途中でリースを延ばす。`Worker` が自動でも延ばすが、明示的にも呼べる */
  heartbeat: () => Promise<void>;
}

export type JobHandler = (job: Job, context: JobContext) => Promise<Record<string, unknown> | void>;

export interface WorkerOptions {
  store: JobStore;
  /** 種類ごとの処理。ここに無い種類は取りに行かない */
  handlers: Record<string, JobHandler>;
  /** 1回の占有時間。処理中は自動で延長する */
  leaseMs?: number;
  /** リース延長の間隔。`leaseMs` より十分短くする */
  heartbeatMs?: number;
  /** 仕事が無いときの待ち時間 */
  idleMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
  /** テスト用。待ち時間を差し替える */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * ジョブを1件ずつ処理するワーカー。
 *
 * **同時実行は1。** 解析は1件あたり数分・LLM の利用上限に当たりうるので、
 * 並列に走らせても速くならず、上限に当たる確率だけが上がる。
 * 台数を増やしたくなったら、プロセスを増やす（`claim` が行ロックで競合を捌く）。
 */
export class Worker {
  private readonly store: JobStore;
  private readonly handlers: Record<string, JobHandler>;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly idleMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private running = false;

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.handlers = options.handlers;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
    this.idleMs = options.idleMs ?? 5_000;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? sleepDefault;
    this.random = options.random ?? Math.random;
  }

  /**
   * 1件だけ処理する。処理したら true、仕事が無ければ false。
   *
   * ループと1件ぶんの処理を分けておくと、テストからは `runOnce` だけを叩ける。
   */
  async runOnce(): Promise<boolean> {
    const job = await this.store.claim({
      leaseMs: this.leaseMs,
      kinds: Object.keys(this.handlers),
    });
    if (!job) return false;

    const handler = this.handlers[job.kind];
    if (!handler) {
      // claim で種類を絞っているので通常は起きない
      await this.store.fail(job.id, `未対応の種類です: ${job.kind}`);
      return true;
    }

    this.log(`▸ ${job.kind} ${job.dedupeKey}（${job.attempts} 回目）`);
    const timer = setInterval(() => {
      void this.store.heartbeat(job.id, this.leaseMs).catch(() => {});
    }, this.heartbeatMs);
    // ワーカーの終了をハートビートが引き止めないようにする
    timer.unref?.();

    try {
      const result = await handler(job, {
        log: this.log,
        heartbeat: () => this.store.heartbeat(job.id, this.leaseMs),
      });
      await this.store.succeed(job.id, result ?? undefined);
      this.log(`  ✓ 完了`);
    } catch (error) {
      await this.handleFailure(job, error);
    } finally {
      clearInterval(timer);
    }
    return true;
  }

  /**
   * 失敗の後始末。
   *
   * 待てば直るものだけ、回数の上限まで積み直す。それ以外はその場で終わらせる。
   */
  private async handleFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const retriable = isTransient(error) && job.attempts < job.maxAttempts;

    if (!retriable) {
      await this.store.fail(job.id, message);
      this.log(`  ✗ 失敗（再試行しません）: ${message}`);
      return;
    }

    const delay = backoffMs(job.attempts, { random: this.random });
    await this.store.fail(job.id, message, {
      runAfter: new Date(this.now().getTime() + delay),
    });
    this.log(
      `  ↻ ${Math.round(delay / 1000)} 秒後に再試行（${job.attempts}/${job.maxAttempts}）: ${message}`,
    );
  }

  /** 仕事が尽きたら待ち、また取りに行く。`stop()` まで回り続ける */
  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        // claim 自体の失敗（DB 断など）。ここで落とすとワーカーが死ぬので待って続ける
        this.log(`  ⚠ ジョブの取得に失敗: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!worked) await this.sleep(this.idleMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
