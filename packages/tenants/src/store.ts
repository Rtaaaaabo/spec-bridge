import type { Tenant, TenantInput } from "./types.ts";

/**
 * テナント（インストール）の置き場所。
 *
 * Postgres 実装（本番）とメモリ実装（テスト）を差し替える。
 */
export interface TenantStore {
  /** インストールを記録する。既にあれば account を更新し、**提出先は消さない** */
  upsert(input: TenantInput): Promise<Tenant>;
  get(installationId: number): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;
  /** 提出先を設定する（null で未設定に戻す） */
  setDocsRepo(installationId: number, docsRepo: string | null): Promise<Tenant | null>;
  /** アンインストールされたとき */
  remove(installationId: number): Promise<void>;
  close(): Promise<void>;
}

/** テストと、DB を用意していないローカル向け */
export class MemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<number, Tenant>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async upsert(input: TenantInput): Promise<Tenant> {
    const existing = this.tenants.get(input.installationId);
    const tenant: Tenant = {
      installationId: input.installationId,
      account: input.account,
      // 再インストールのたびに提出先が消えると、設定し直しになる
      docsRepo: input.docsRepo !== undefined ? input.docsRepo : (existing?.docsRepo ?? null),
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.tenants.set(tenant.installationId, tenant);
    return tenant;
  }

  async get(installationId: number): Promise<Tenant | null> {
    return this.tenants.get(installationId) ?? null;
  }

  async list(): Promise<Tenant[]> {
    return [...this.tenants.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  async setDocsRepo(installationId: number, docsRepo: string | null): Promise<Tenant | null> {
    const existing = this.tenants.get(installationId);
    if (!existing) return null;
    const updated = { ...existing, docsRepo, updatedAt: this.now() };
    this.tenants.set(installationId, updated);
    return updated;
  }

  async remove(installationId: number): Promise<void> {
    this.tenants.delete(installationId);
  }

  async close(): Promise<void> {}
}
