import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ClaimOptions, JobStore } from "./store.ts";
import { DEFAULT_MAX_ATTEMPTS, type EnqueueResult, type Job, type JobInput } from "./types.ts";

/** DB の行。`Job` との変換はこのファイルの中だけに閉じる */
interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  state: Job["state"];
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lease_until: Date | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: row.payload ?? {},
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresJobStore implements JobStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 4 });
  }

  /** 表を作る。マイグレーションの仕組みを増やさず、起動時に流せる形にしておく */
  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, "schema.sql"), "utf8");
    await this.pool.query(sql);
  }

  /**
   * 積む。`dedupe_key` が衝突したら積まない。
   *
   * ただし**失敗して終わった仕事だけは積み直す**（GitHub の Redeliver で拾い直せるように）。
   *
   * 「積んだ」の判定に**実行前の状態が要る**。`xmax = 0`（今回の INSERT で作られた行か）だけでは、
   * 「もともと queued だった」と「failed から queued に戻した」が区別できず、
   * 重複を `created: true` と報告してしまう（実 DB で踏んだ）。
   * CTE は文の実行前のスナップショットを見るので、`previous` で古い状態を取れる。
   */
  async enqueue(input: JobInput): Promise<EnqueueResult> {
    const { rows } = await this.pool.query<JobRow & { previous_state: Job["state"] | null }>(
      `with previous as (
         select state from jobs where dedupe_key = $3
       ), upserted as (
         insert into jobs (tenant_id, kind, dedupe_key, payload, run_after, max_attempts)
         values ($1, $2, $3, $4::jsonb, coalesce($5, now()), $6)
         on conflict (dedupe_key) do update
           set state      = case when jobs.state = 'failed' then 'queued' else jobs.state end,
               attempts   = case when jobs.state = 'failed' then 0 else jobs.attempts end,
               run_after  = case when jobs.state = 'failed' then coalesce($5, now()) else jobs.run_after end,
               last_error = case when jobs.state = 'failed' then null else jobs.last_error end,
               payload    = case when jobs.state = 'failed' then $4::jsonb else jobs.payload end,
               updated_at = now()
         returning *
       )
       select upserted.*, previous.state as previous_state
         from upserted left join previous on true`,
      [
        input.tenantId,
        input.kind,
        input.dedupeKey,
        JSON.stringify(input.payload),
        input.runAfter ?? null,
        input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error("ジョブを積めませんでした");
    // 新規（実行前に行が無かった）か、失敗した仕事を積み直した場合が「積んだ」
    const created = row.previous_state === null || row.previous_state === "failed";
    return { job: toJob(row), created };
  }

  /**
   * 1件ロックして取り出す。
   *
   * `for update skip locked` で、複数のワーカーが同じ行を取らないようにする。
   * リースが切れた `running` も対象に含めるのが要点で、これが無いとワーカーが落ちた瞬間に
   * その仕事が永久に `running` のまま残る。
   */
  async claim(options: ClaimOptions): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(
      `update jobs
          set state       = 'running',
              attempts    = attempts + 1,
              lease_until = now() + make_interval(secs => $1::double precision),
              updated_at  = now()
        where id = (
          select id from jobs
           where (($2::text[] is null) or kind = any($2))
             and ( (state = 'queued'  and run_after <= now())
                or (state = 'running' and lease_until is not null and lease_until < now()) )
           order by run_after
           for update skip locked
           limit 1
        )
        returning *`,
      [options.leaseMs / 1000, options.kinds ?? null],
    );
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  async heartbeat(id: string, leaseMs: number): Promise<void> {
    await this.pool.query(
      `update jobs
          set lease_until = now() + make_interval(secs => $2::double precision),
              updated_at = now()
        where id = $1 and state = 'running'`,
      [id, leaseMs / 1000],
    );
  }

  async succeed(id: string, result?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `update jobs
          set state = 'succeeded', lease_until = null, result = $2::jsonb, updated_at = now()
        where id = $1`,
      [id, result ? JSON.stringify(result) : null],
    );
  }

  async fail(id: string, error: string, retry?: { runAfter: Date }): Promise<void> {
    await this.pool.query(
      `update jobs
          set state       = case when $3::timestamptz is null then 'failed' else 'queued' end,
              run_after   = coalesce($3::timestamptz, run_after),
              lease_until = null,
              last_error  = $2,
              updated_at  = now()
        where id = $1`,
      [id, error, retry?.runAfter ?? null],
    );
  }

  async get(id: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(`select * from jobs where id = $1`, [id]);
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
