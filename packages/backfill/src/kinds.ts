/**
 * ジョブの種類。
 *
 * **定義だけを別ファイルに置く。** ここを `index.ts` に置くと、
 * `summary.ts` が `index.ts` を読み、`index.ts` が `summary.ts` を再輸出する循環になり、
 * 評価順によって「初期化前の参照」で落ちる（実際に踏んだ）。
 */

/** ランの開始（機能の列挙） */
export const BACKFILL_SURVEY = "backfill.survey";
/** 機能1件の書き起こし */
export const BACKFILL_FEATURE = "backfill.feature";
/** 一覧ページの再生成と PR の作成 */
export const BACKFILL_FINISH = "backfill.finish";

export const BACKFILL_KINDS = [BACKFILL_SURVEY, BACKFILL_FEATURE, BACKFILL_FINISH] as const;
