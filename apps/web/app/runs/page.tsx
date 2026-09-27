import { redirect } from "next/navigation";
import { progressLabel, type RunSummary } from "@spec-bridge/backfill";
import { formatElapsed } from "@spec-bridge/core";
import { currentSession } from "@/lib/auth";
import { listAnalyzeJobs, listRuns } from "@/lib/runs";
import { StartRunForm } from "./start-run-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<RunSummary["state"], { text: string; cls: string }> = {
  running: { text: "実行中", cls: "bg-sky-500/15 text-sky-400" },
  succeeded: { text: "完了", cls: "bg-emerald-500/15 text-emerald-400" },
  "over-budget": { text: "予算で打ち切り", cls: "bg-amber-500/15 text-amber-500" },
  failed: { text: "失敗", cls: "bg-rose-500/15 text-rose-400" },
};

/**
 * バックフィルのラン一覧。
 *
 * これまでジョブの状態は SQL でしか見えなかった。
 * **費用と「途中で終わったか」が分かることが要点**で、
 * 予算で打ち切ったランを「完了」と並べて見せない。
 */
export default async function RunsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  let runs: RunSummary[] = [];
  let analyze: Awaited<ReturnType<typeof listAnalyzeJobs>> = [];
  let error: string | null = null;
  try {
    [runs, analyze] = await Promise.all([listRuns(), listAnalyzeJobs()]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">バックフィルのラン</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            いまのコードから機能ドキュメント一式を書き起こした記録です。
          </p>
        </div>
        <a href="/installations" className="text-xs underline" style={{ color: "var(--muted)" }}>
          インストール
        </a>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          {error}
        </div>
      )}

      <StartRunForm />

      <ul className="mt-8 space-y-3">
        {runs.map((run) => {
          const state = STATE_LABEL[run.state];
          return (
            <li
              key={run.runId}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--border)", background: "var(--panel)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${state.cls}`}>
                    {state.text}
                  </span>
                  <span className="font-medium">{run.repo}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    → {run.docsRepo}
                  </span>
                </div>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {run.startedAt.toLocaleString("ja-JP")}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
                <span>{progressLabel(run)}</span>
                {run.failed > 0 && <span className="text-rose-400">失敗 {run.failed} 件</span>}
                {run.skipped > 0 && <span className="text-amber-500">予算で未着手 {run.skipped} 件</span>}
                <span>
                  ${run.costUsd.toFixed(2)}
                  {run.budgetUsd !== null && ` / 上限 $${run.budgetUsd}`}
                </span>
                <span>{formatElapsed(run.updatedAt.getTime() - run.startedAt.getTime())}</span>
                {run.prUrl && (
                  <a href={run.prUrl} className="underline" target="_blank" rel="noreferrer">
                    提出した PR
                  </a>
                )}
              </div>

              {run.lastError && (
                <p className="mt-2 text-xs text-rose-400">最後の失敗: {run.lastError}</p>
              )}
            </li>
          );
        })}
      </ul>

      {runs.length === 0 && !error && (
        <p className="mt-6 text-sm" style={{ color: "var(--muted)" }}>
          まだランがありません。上のフォームから始められます。
        </p>
      )}

      {analyze.length > 0 && (
        <section className="mt-12">
          <h2 className="text-sm font-semibold">最近の PR 解析</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            webhook から積まれたぶんです。「マージしたのに何も起きない」ときはここを見てください。
          </p>
          <ul className="mt-3 space-y-1 text-xs">
            {analyze.map((job) => (
              <li key={job.id} className="flex flex-wrap items-baseline gap-2">
                <span style={{ color: "var(--muted)" }}>{job.createdAt.toLocaleString("ja-JP")}</span>
                <span>{String(job.payload["repo"] ?? "?")}#{String(job.payload["number"] ?? "?")}</span>
                <span style={{ color: "var(--muted)" }}>{job.state}</span>
                {typeof job.result?.["prUrl"] === "string" && (
                  <a href={job.result["prUrl"]} className="underline" target="_blank" rel="noreferrer">
                    PR
                  </a>
                )}
                {job.lastError && <span className="text-rose-400">{job.lastError.slice(0, 60)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
