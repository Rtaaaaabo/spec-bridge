"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Result =
  | { kind: "committed"; url: string }
  | { kind: "pull-request"; url: string }
  | { kind: "local" }
  | { kind: "already" };

/**
 * レビュー済にするボタン。
 *
 * docs リポジトリにコミットが積まれる操作なので、**1回押しただけでは実行しない。**
 * 「確かめましたか？」を挟んで、もう一度押したときに実行する。
 */
export function VerifyButton({ id }: { id: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirm" | "pending">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setStep("pending");
    setError(null);
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(id)}/verify`, { method: "POST" });
      const body = (await response.json()) as Result & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `失敗しました（${response.status}）`);
      setResult(body);
      // 直接コミットできたときは、画面をレビュー済の表示に切り替える
      if (body.kind !== "pull-request") router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep("idle");
    }
  }

  if (result?.kind === "pull-request") {
    return (
      <p className="text-xs leading-relaxed">
        既定ブランチに直接書き込めなかったため、PR を作りました。
        <a href={result.url} target="_blank" rel="noreferrer" className="ml-1 underline">
          PR を開く
        </a>
        （マージすると反映されます）
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {step === "confirm" ? (
          <>
            <span className="text-xs">内容を確かめましたか？</span>
            <button
              type="button"
              onClick={verify}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            >
              確かめた。レビュー済にする
            </button>
            <button
              type="button"
              onClick={() => setStep("idle")}
              className="rounded px-3 py-1.5 text-xs"
              style={{ color: "var(--muted)" }}
            >
              やめる
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={step === "pending"}
            onClick={() => setStep("confirm")}
            className="rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            {step === "pending" ? "書き込んでいます…" : "レビュー済にする"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
