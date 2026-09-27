export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ログイン画面。
 *
 * GitHub App の user-to-server OAuth を使う。**ログインと App のインストールの主体が揃う**ので、
 * 「この人が見てよいインストール」を GitHub 側に聞けば済む（対応表を自前で持たない）。
 */
export default function LoginPage() {
  const configured = Boolean(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">spec-bridge</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
        機能仕様ドキュメントには内部のファイルパスと仕様が含まれます。閲覧にはログインが必要です。
      </p>

      {configured ? (
        <a
          href="/api/github/login"
          className="mt-8 rounded-lg px-4 py-3 text-center text-sm font-medium"
          style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
        >
          GitHub でログイン
        </a>
      ) : (
        <div
          className="mt-8 rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--panel)" }}
        >
          <p className="font-medium">ログインが設定されていません</p>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            GitHub App の設定で Callback URL に{" "}
            <code>{process.env.SPEC_BRIDGE_BASE_URL ?? "http://localhost:3000"}/api/github/callback</code>{" "}
            を登録し、<code>.env</code> に <code>GITHUB_APP_CLIENT_ID</code> /{" "}
            <code>GITHUB_APP_CLIENT_SECRET</code> / <code>SPEC_BRIDGE_SESSION_SECRET</code> を設定してください。
            手順は <code>docs/github-app-setup.ja.md</code> にあります。
          </p>
        </div>
      )}
    </main>
  );
}
