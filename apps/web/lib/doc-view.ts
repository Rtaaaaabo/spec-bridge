import type { DocStatus, SourceRef } from "@spec-bridge/core";

/** 一覧と詳細で同じ見た目にする */
export const STATUS_LABEL: Record<DocStatus, { text: string; cls: string; hint: string }> = {
  draft: {
    text: "AI生成・未レビュー",
    cls: "bg-amber-500/15 text-amber-500",
    hint: "AI がコードから書き起こしたままで、人はまだ確かめていません。",
  },
  verified: {
    text: "レビュー済",
    cls: "bg-emerald-500/15 text-emerald-500",
    hint: "人が確かめた内容です。コードが変わって自動更新されると、未レビューに戻ります。",
  },
  stale: {
    text: "要更新",
    cls: "bg-rose-500/15 text-rose-500",
    hint: "コードの変更に追いついていない可能性があります。",
  },
};

/**
 * 出典の GitHub 上の URL。リポジトリが分からない出典（単一リポジトリで省略されたもの）は null。
 * ブランチは決め打ちせず `HEAD`（既定ブランチ）を見る。
 */
export function sourceUrl(source: SourceRef): string | null {
  if (!source.repo) return null;
  const line = source.line ? `#L${source.line}` : "";
  return `https://github.com/${source.repo}/blob/HEAD/${source.file}${line}`;
}

export function sourceLabel(source: SourceRef): string {
  return source.line ? `${source.file}:${source.line}` : source.file;
}

/** docs リポジトリ上の、この機能ドキュメントの URL。提出先が分からなければ null */
export function docFileUrl(docsRepo: string | undefined, id: string): string | null {
  return docsRepo ? `https://github.com/${docsRepo}/blob/HEAD/features/${id}.md` : null;
}
