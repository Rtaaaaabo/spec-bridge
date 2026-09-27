/**
 * PR 解析ジョブの種類。
 *
 * 定義は `apps/webhook` にあるが、そちらは Node 専用の処理（クローン・ファイル操作）を
 * 抱えているので画面から import しない。**文字列1つのために依存を増やさない。**
 * 値がずれると一覧に出なくなるだけで、解析は動く。
 */
export const ANALYZE_PR_KIND = "analyze.pr";
