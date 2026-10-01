import { redirect } from "next/navigation";
import { DocStore } from "@spec-bridge/core";
import { currentSession } from "@/lib/auth";
import { docsPath } from "@/lib/config";
import { buildSampleQuestions } from "@/lib/samples";
import { STATUS_LABEL } from "@/lib/doc-view";
import { AskPanel } from "./ask-panel";
import { SiteNav } from "./site-nav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  // 機能ドキュメントには内部のファイルパスと仕様が載る。署名を検証してから描く
  const session = await currentSession();
  if (!session) redirect("/login");

  let docs: Awaited<ReturnType<DocStore["list"]>> = [];
  let error: string | null = null;

  try {
    docs = await new DocStore(docsPath()).list();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <SiteNav current="ask" login={session.login} />
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
                  <li key={doc.meta.id}>
                    <a
                      href={`/docs/${encodeURIComponent(doc.meta.id)}`}
                      className="group block rounded-lg border p-3 transition-colors hover:border-[var(--accent)]"
                      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
                    >
                      <div className="flex items-start justify-between gap-2 text-sm font-medium">
                        <span className="group-hover:underline">{doc.body.title}</span>
                        <span aria-hidden style={{ color: "var(--muted)" }}>›</span>
                      </div>
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
                    </a>
                  </li>
                );
              })}
              {docs.length === 0 && !error && (
                <li className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  機能ドキュメントがまだありません。
                  <a href="/runs" className="underline" style={{ color: "var(--text)" }}>
                    解析
                  </a>
                  の画面で、対象のリポジトリから書き起こしてください。
                </li>
              )}
            </ul>
          </aside>

          <AskPanel samples={buildSampleQuestions(docs)} />
        </div>
      </main>
    </>
  );
}
