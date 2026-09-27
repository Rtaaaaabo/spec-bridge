import type { TenantStore } from "./store.ts";

export interface DocsRepoResolution {
  docsRepo: string;
  /** どこから決まったか。ログと切り分けに使う */
  source: "installation" | "env";
}

/**
 * このインストールの提出先を決める。
 *
 * テナント表に設定があればそれを使い、無ければ環境変数へ落ちる。
 * **env は単一テナント運用のための後方互換**で、設定済みのテナントより優先されることはない。
 *
 * どちらも無ければ投げる。**提出先の無いまま数分〜30分の解析を走らせない。**
 */
export async function resolveDocsRepo(
  store: TenantStore,
  installationId: number | null,
  fallback: string | undefined,
): Promise<DocsRepoResolution> {
  if (installationId !== null) {
    const tenant = await store.get(installationId);
    if (tenant?.docsRepo) return { docsRepo: tenant.docsRepo, source: "installation" };
  }
  if (fallback?.trim()) return { docsRepo: fallback.trim(), source: "env" };

  throw new Error(
    installationId === null
      ? "提出先が決まりません（installation id が無く、SPEC_BRIDGE_DOCS_REPO も未設定です）"
      : `提出先が設定されていません（installation ${installationId}）。画面で docs リポジトリを指定してください。`,
  );
}
