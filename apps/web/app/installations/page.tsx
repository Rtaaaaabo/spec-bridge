import { redirect } from "next/navigation";
import {
  inspectApp,
  listInstallationRepositories,
  readAppCredentials,
} from "@spec-bridge/github";
import { currentSession } from "@/lib/auth";
import { SiteNav } from "../site-nav";
import { fallbackDocsRepo } from "@/lib/config";
import { tenantsByInstallation } from "@/lib/tenants";
import { DocsRepoForm } from "./docs-repo-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InstallationView {
  id: number;
  account: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  repositories: string[];
}

/**
 * spec-bridge が読めるリポジトリの一覧。
 *
 * **App の資格情報で引く。** いまは単一テナント（`SPEC_BRIDGE_DOCS_REPO` が唯一のテナント設定）なので、
 * 「この App が入っている先」がそのまま「この環境が触れる範囲」になる。
 * 利用者ごとに見える範囲を変えるのは、テナント表を入れるときに一緒にやる。
 */
async function loadInstallations(): Promise<{ items: InstallationView[]; error: string | null }> {
  try {
    const credentials = readAppCredentials();
    if (!credentials) {
      return { items: [], error: "GitHub App が設定されていません（PAT 運用では一覧を出せません）" };
    }
    const info = await inspectApp(credentials);
    const items = await Promise.all(
      info.installations.map(async (installation) => ({
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        repositories: await listInstallationRepositories(credentials, installation.id),
      })),
    );
    return { items, error: null };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export default async function InstallationsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { items, error } = await loadInstallations();

  // 提出先の設定はテナント表にある。DB が無い環境でも画面は出す（未設定として扱う）
  let tenants = new Map<number, { docsRepo: string | null }>();
  try {
    tenants = await tenantsByInstallation();
  } catch {
    tenants = new Map();
  }
  const fallback = fallbackDocsRepo() ?? null;

  return (
    <>
      <SiteNav current="installations" login={session.login} />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <header className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">インストール</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
              spec-bridge が読めるリポジトリです。ここに無いリポジトリは解析できません。
            </p>
          </div>
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
            {error}
          </div>
        )}

        <ul className="space-y-4">
          {items.map((installation) => (
            <li
              key={installation.id}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--border)", background: "var(--panel)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{installation.account}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  installation {installation.id} · 対象 {installation.repositorySelection} ·{" "}
                  Contents: {installation.permissions["contents"] ?? "なし"} / Pull requests:{" "}
                  {installation.permissions["pull_requests"] ?? "なし"}
                </span>
              </div>
              <DocsRepoForm
                installationId={installation.id}
                account={installation.account}
                current={tenants.get(installation.id)?.docsRepo ?? null}
                fallback={fallback}
              />

              <ul className="mt-3 space-y-1">
                {installation.repositories.map((repo) => (
                  <li key={repo} className="text-sm">
                    {repo}
                  </li>
                ))}
                {installation.repositories.length === 0 && (
                  <li className="text-xs" style={{ color: "var(--muted)" }}>
                    リポジトリが選ばれていません
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>

        {items.length === 0 && !error && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            インストールがありません。GitHub App を対象リポジトリに追加してください。
          </p>
        )}
      </main>
    </>
  );
}
