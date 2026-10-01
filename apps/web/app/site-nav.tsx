/**
 * 全画面で共通のナビ。
 *
 * これまで画面どうしのリンクがほぼ無く、トップから「解析を始める」「提出先を設定する」画面に
 * 辿り着けなかった。**何をどこでするか**が分かる名前にする。
 */
const ITEMS = [
  { href: "/", key: "ask", label: "問い合わせ" },
  { href: "/runs", key: "runs", label: "解析" },
  { href: "/installations", key: "installations", label: "設定" },
] as const;

export type NavKey = (typeof ITEMS)[number]["key"];

export function SiteNav({ current, login }: { current: NavKey; login: string }) {
  return (
    <nav
      className="border-b"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
      aria-label="メイン"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-6">
          <a href="/" className="py-3 text-sm font-bold">
            spec-bridge
          </a>
          <ul className="flex items-center gap-1">
            {ITEMS.map((item) => {
              const active = item.key === current;
              return (
                <li key={item.key}>
                  <a
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className="block border-b-2 px-3 py-3 text-sm transition-colors hover:opacity-100"
                    style={{
                      borderColor: active ? "var(--accent)" : "transparent",
                      color: active ? "var(--text)" : "var(--muted)",
                    }}
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
        <form action="/api/github/logout" method="post">
          <button type="submit" className="text-xs underline" style={{ color: "var(--muted)" }}>
            {login} · ログアウト
          </button>
        </form>
      </div>
    </nav>
  );
}
