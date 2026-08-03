"use client";

import { useState } from "react";
import type { AskAnswer } from "@spec-bridge/core";

const VERDICT = {
  spec: {
    label: "仕様どおり",
    hint: "ドキュメントに書かれた仕様と一致しています",
    cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  },
  bug: {
    label: "バグの可能性",
    hint: "ドキュメントの仕様と食い違っています",
    cls: "bg-rose-500/15 text-rose-500 border-rose-500/30",
  },
  unknown: {
    label: "判断できない",
    hint: "根拠となる記述がないため、開発チームへの確認が必要です",
    cls: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  },
} as const;

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border p-4 ${className}`}
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      {children}
    </div>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded border px-2 py-0.5 text-xs transition-colors hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function AskPanel({ samples }: { samples: string[] }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [scope, setScope] = useState<{ docCount: number; consultedCount: number; narrowed: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(text: string) {
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const data = (await res.json()) as {
        answer?: AskAnswer;
        docCount?: number;
        consultedCount?: number;
        narrowed?: boolean;
        error?: string;
      };
      if (!res.ok || !data.answer) throw new Error(data.error ?? "回答の取得に失敗しました");
      setAnswer(data.answer);
      setScope({
        docCount: data.docCount ?? 0,
        consultedCount: data.consultedCount ?? 0,
        narrowed: data.narrowed ?? false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const verdict = answer ? VERDICT[answer.verdict] : null;

  return (
    <section className="space-y-5">
      <Panel>
        <label htmlFor="q" className="mb-2 block text-sm font-medium">
          問い合わせ内容
        </label>
        <textarea
          id="q"
          rows={4}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="お客様からの問い合わせをそのまま貼り付けてください"
          className="w-full resize-y rounded-lg border bg-transparent p-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          style={{ borderColor: "var(--border)" }}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void ask(question)}
            disabled={loading || !question.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          >
            {loading ? "仕様を照会中…" : "仕様を照会する"}
          </button>
          {loading && (
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              機能ドキュメントを読んでいます（30秒ほどかかります）
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {samples.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                void ask(s);
              }}
              disabled={loading}
              className="rounded-full border px-3 py-1 text-xs transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            >
              {s.length > 28 ? `${s.slice(0, 28)}…` : s}
            </button>
          ))}
        </div>
      </Panel>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          {error}
        </div>
      )}

      {answer && verdict && (
        <div className="space-y-4">
          <Panel className={`border ${verdict.cls}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-md border px-2 py-1 text-xs font-bold ${verdict.cls}`}>
                {verdict.label}
              </span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {verdict.hint} ・ 確度 {Math.round(answer.confidence * 100)}%
                {scope?.narrowed && (
                  <>
                    {" ・ "}
                    <span title="件数が多いため、索引で関係するドキュメントを絞り込んでから回答しています">
                      {scope.docCount} 件中 {scope.consultedCount} 件を参照
                    </span>
                  </>
                )}
              </span>
            </div>
            <p className="mt-3 text-base font-medium">{answer.headline}</p>
          </Panel>

          {answer.answerForCustomer && (
            <Panel className="border-l-4 border-l-blue-500">
              <CopyBlock label="顧客への回答（そのまま送れます）" text={answer.answerForCustomer} />
            </Panel>
          )}

          <Panel>
            <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
              CS 向けの説明
            </h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{answer.explanation}</p>
          </Panel>

          <Panel>
            <h3 className="mb-3 text-xs font-semibold" style={{ color: "var(--muted)" }}>
              根拠（{answer.citations.length}件）
            </h3>
            {answer.citations.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                根拠となる記述が見つかりませんでした。
              </p>
            ) : (
              <ul className="space-y-3">
                {answer.citations.map((c, i) => (
                  <li
                    key={i}
                    className="border-l-2 pl-3 text-sm"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <p className="leading-relaxed">{c.quote}</p>
                    <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                      {c.docTitle || c.docId}
                      {c.file && <span className="ml-2 font-mono">{c.file}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {answer.devRequest && (
            <Panel className="border-l-4 border-l-rose-500">
              <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
                開発チームへの依頼文（このまま起票できます）
              </h3>
              <p className="mb-3 text-sm font-medium">{answer.devRequest.title}</p>
              <CopyBlock
                label="本文"
                text={`${answer.devRequest.title}\n\n${answer.devRequest.body}`}
              />
            </Panel>
          )}

          {answer.followUp.length > 0 && (
            <Panel className="border-l-4 border-l-amber-500">
              <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
                開発チームに確認すべきこと
              </h3>
              <ul className="space-y-1.5 text-sm">
                {answer.followUp.map((f, i) => (
                  <li key={i} className="flex gap-2">
                    <span style={{ color: "var(--muted)" }}>･</span>
                    <span className="leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </section>
  );
}
