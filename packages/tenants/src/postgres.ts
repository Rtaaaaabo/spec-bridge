import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TenantStore } from "./store.ts";
import type { Tenant, TenantInput } from "./types.ts";

interface TenantRow {
  installation_id: string | number;
  account: string;
  docs_repo: string | null;
  created_at: Date;
  updated_at: Date;
}

function toTenant(row: TenantRow): Tenant {
  return {
    // bigint は pg から文字列で返る
    installationId: Number(row.installation_id),
    account: row.account,
    docsRepo: row.docs_repo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresTenantStore implements TenantStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 2 });
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    await this.pool.query(await readFile(join(here, "schema.sql"), "utf8"));
  }

  /**
   * インストールを記録する。
   *
   * **提出先は上書きしない。** webhook の `installation` イベントは再インストールでも飛ぶので、
   * そのたびに設定が消えると、使う人は毎回入れ直すことになる。
   */
  async upsert(input: TenantInput): Promise<Tenant> {
    const { rows } = await this.pool.query<TenantRow>(
      `insert into installations (installation_id, account, docs_repo)
       values ($1, $2, $3)
       on conflict (installation_id) do update
         set account    = excluded.account,
             docs_repo  = coalesce(excluded.docs_repo, installations.docs_repo),
             updated_at = now()
       returning *`,
      [input.installationId, input.account, input.docsRepo ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error("インストールを保存できませんでした");
    return toTenant(row);
  }

  async get(installationId: number): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      `select * from installations where installation_id = $1`,
      [installationId],
    );
    const row = rows[0];
    return row ? toTenant(row) : null;
  }

  async list(): Promise<Tenant[]> {
    const { rows } = await this.pool.query<TenantRow>(
      `select * from installations order by account`,
    );
    return rows.map(toTenant);
  }

  async setDocsRepo(installationId: number, docsRepo: string | null): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      `update installations set docs_repo = $2, updated_at = now()
        where installation_id = $1
        returning *`,
      [installationId, docsRepo],
    );
    const row = rows[0];
    return row ? toTenant(row) : null;
  }

  async remove(installationId: number): Promise<void> {
    await this.pool.query(`delete from installations where installation_id = $1`, [installationId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
