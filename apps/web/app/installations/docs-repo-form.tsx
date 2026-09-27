"use client";

import { useState } from "react";

/**
 * インストールごとの提出先を設定するフォーム。
 *
 * **保存時に「その App が触れるリポジトリか」をサーバー側で確かめる。**
 * 触れない提出先を保存できてしまうと、失敗するのは数分後の解析の最後になる。
 */
export function DocsRepoForm(props: {
  installationId: number;
  account: string;
  current: string | null;
  /** 設定が無いときに使われる値（環境変数） */
  fallback: string | null;
}) {
  const [value, setValue] = useState(props.current ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(props.current);

  async function save(formData: FormData) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/installations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installationId: props.installationId,
          account: props.account,
          docsRepo: String(formData.get("docsRepo") ?? ""),
        }),
      });
      const body = (await response.json()) as { error?: string; docsRepo?: string | null };
      if (!response.ok) throw new Error(body.error ?? `失敗しました（${response.status}）`);
      setSaved(body.docsRepo ?? null);
      setMessage(body.docsRepo ? "保存しました" : "未設定に戻しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={save} className="mt-3 flex flex-wrap items-end gap-2">
      <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
        生成物の提出先（org/repo）
        <input
          name="docsRepo"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={props.fallback ?? "acme/product-specs"}
          className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
          style={{ borderColor: "var(--border)", color: "inherit" }}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded px-3 py-1.5 text-sm disabled:opacity-50"
        style={{ border: "1px solid var(--border)" }}
      >
        {pending ? "確認中…" : "保存"}
      </button>
      <p className="w-full text-xs" style={{ color: "var(--muted)" }}>
        {saved
          ? `このインストールの生成物は ${saved} に出ます。`
          : props.fallback
            ? `未設定です。いまは環境変数の ${props.fallback} に出ます。`
            : "未設定です。設定するまで、このインストールの解析は提出先が無く失敗します。"}
        {message && <span className="ml-2">{message}</span>}
      </p>
    </form>
  );
}
