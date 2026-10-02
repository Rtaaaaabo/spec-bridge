import { INDEX_PAGE, QUESTIONS_PAGE, renderIndexPage, renderQuestionsPage } from "./store.ts";
import { renderDocFile } from "./markdown.ts";
import type { FeatureDoc } from "./types.ts";

export interface VerifyInput {
  /** レビューした人の GitHub ログイン名 */
  login: string;
  /** YYYY-MM-DD */
  date: string;
}

/**
 * 人がレビューした印を付ける。`status` を `verified` にし、**誰がいつ確かめたか**を変更履歴に残す。
 *
 * メタデータは人とツールが管理する領域（LLM には触らせない）なので、ここで書き換えてよい。
 * 自動更新が走ると `mergeAnalysis` が `draft` に戻す（コードが変わったら確かめ直す）。
 *
 * `updatedAt` は変えない。これは「内容（仕様）がいつ変わったか」で、レビューは内容を変えない。
 */
export function markVerified(doc: FeatureDoc, input: VerifyInput): FeatureDoc {
  return {
    ...doc,
    meta: { ...doc.meta, status: "verified" },
    changelog: [
      ...doc.changelog,
      { date: input.date, summary: `@${input.login} がレビュー済にした`, pr: null },
    ],
  };
}

/**
 * レビュー済にしたときに docs リポジトリで書き換わるファイル一式。
 *
 * 機能ドキュメント本体に加えて、状態のバッジが載る一覧（README）と確認事項ページも作り直す。
 * 本体だけ変えると、一覧が「AI生成」のまま食い違う。
 *
 * @param all docs リポジトリにある全機能（一覧を作るため）。`verified` に差し替えて使う
 */
export function verifiedFiles(
  all: FeatureDoc[],
  verified: FeatureDoc,
): { path: string; content: string }[] {
  const docs = all.map((d) => (d.meta.id === verified.meta.id ? verified : d));
  return [
    { path: `features/${verified.meta.id}.md`, content: renderDocFile(verified) },
    { path: INDEX_PAGE, content: renderIndexPage(docs) },
    { path: QUESTIONS_PAGE, content: renderQuestionsPage(docs) },
  ];
}
