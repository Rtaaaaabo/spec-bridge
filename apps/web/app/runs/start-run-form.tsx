"use client";

import { useState } from "react";

/**
 * ランを始めるフォーム。
 *
 * **1機能 約 $1.7 かかる。** 予算を必ず入力させ、押した直後に上限が見えるようにする。
 */
export function StartRunForm() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start(formData: FormData) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: String(formData.get("repo") ?? "").trim(),
          limit: Number(formData.get("limit") ?? 5),
          budgetUsd: Number(formData.get("budget") ?? 10),
        }),
      });
      const body = (await response.json()) as { error?: string; runId?: string };
      if (!response.ok) throw new Error(body.error ?? `失敗しました（${response.status}）`);
      setMessage(`積みました（run ${body.runId?.slice(0, 8)}）。worker が拾うと進みます。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      action={start}
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
          解析対象（org/repo）
          <input
            name="repo"
            required
            placeholder="acme/backend"
            className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "inherit" }}
          />
        </label>
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          機能数の上限
          <input
            name="limit"
            type="number"
            min={1}
            defaultValue={5}
            className="mt-1 w-24 rounded border bg-transparent px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "inherit" }}
          />
        </label>
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          予算（USD）
          <input
            name="budget"
            type="number"
            min={1}
            step="0.5"
            defaultValue={10}
            className="mt-1 w-24 rounded border bg-transparent px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "inherit" }}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ border: "1px solid var(--border)" }}
        >
          {pending ? "積んでいます…" : "ランを始める"}
        </button>
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        1機能あたり数分・約 $1.7 かかります。予算を超えたぶんは書かずに仕上げへ進みます。
      </p>
      {message && <p className="mt-2 text-xs">{message}</p>}
    </form>
  );
}
