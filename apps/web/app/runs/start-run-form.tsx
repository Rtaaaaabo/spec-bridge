"use client";

import { useState } from "react";

/**
 * 書き起こし（バックフィル）を始めるフォーム。
 *
 * 機能数と予算は聞かない。利用者に原価の話をさせないため、上限はサーバーの既定値でかける
 * （`/api/runs`）。
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
        }),
      });
      const body = (await response.json()) as { error?: string; runId?: string };
      if (!response.ok) throw new Error(body.error ?? `失敗しました（${response.status}）`);
      setMessage(`受け付けました（${body.runId?.slice(0, 8)}）。順番が来ると始まり、進み具合は下の履歴に出ます。`);
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
          対象のリポジトリ（org/repo）
          <input
            name="repo"
            required
            placeholder="acme/backend"
            className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "inherit" }}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ border: "1px solid var(--border)" }}
        >
          {pending ? "受け付けています…" : "書き起こしを始める"}
        </button>
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        機能の数によって、数分〜数十分かかります。終わると docs リポジトリに PR が届きます。
      </p>
      {message && <p className="mt-2 text-xs">{message}</p>}
    </form>
  );
}
