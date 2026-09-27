import { PostgresTenantStore, type Tenant } from "@spec-bridge/tenants";
import { databaseUrl } from "./config.ts";

/** テナント表を読み書きする入口。画面は接続の面倒を見ない */
export async function withTenants<T>(run: (store: PostgresTenantStore) => Promise<T>): Promise<T> {
  const store = new PostgresTenantStore(databaseUrl());
  try {
    await store.migrate();
    return await run(store);
  } finally {
    await store.close();
  }
}

/** installation id → テナント。画面で設定を引くときに使う */
export async function tenantsByInstallation(): Promise<Map<number, Tenant>> {
  const tenants = await withTenants((store) => store.list());
  return new Map(tenants.map((tenant) => [tenant.installationId, tenant]));
}
