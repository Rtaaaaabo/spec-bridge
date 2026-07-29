import { DocStore } from "@spec-bridge/core";
import { docsPath } from "@/lib/config";
import { buildSampleQuestions } from "@/lib/samples";
import { AskPanel } from "./ask-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_LABEL = {
  draft: { text: "AI生成・未レビュー", cls: "bg-amber-500/15 text-amber-500" },
  verified: { text: "レビュー済", cls: "bg-emerald-500/15 text-emerald-500" },
  stale: { text: "要更新", cls: "bg-rose-500/15 text-rose-500" },
} as const;

export default async function Page() {
  let docs: Awaited<ReturnType<DocStore["list"]>> = [];
  let error: string | null = null;

  try {
    docs = await new DocStore(docsPath()).list();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">CX サポートデスク</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          社内の機能仕様ドキュメントだけを根拠に回答します。根拠を示せない質問には答えません。
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          {error}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
        <aside>
          <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--muted)" }}>
            参照中の仕様（{docs.length}件）
          </h2>
          <ul className="space-y-2">
            {docs.map((doc) => {
              const status = STATUS_LABEL[doc.meta.status];
              return (
                <li
                  key={doc.meta.id}
                  className="rounded-lg border p-3"
                  style={{ borderColor: "var(--border)", background: "var(--panel)" }}
                >
                  <div className="text-sm font-medium">{doc.body.title}</div>
                  <div className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                    {doc.body.summary}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.cls}`}>
                      {status.text}
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--muted)" }}>
                      {doc.meta.updatedAt}
                    </span>
                  </div>
                </li>
              );
            })}
            {docs.length === 0 && !error && (
              <li className="text-xs" style={{ color: "var(--muted)" }}>
                機能ドキュメントがありません。先に spec-bridge の解析を実行してください。
              </li>
            )}
          </ul>
        </aside>

        <AskPanel samples={buildSampleQuestions(docs)} />
      </div>
    </main>
  );
}
