/**
 * DB に繋がらなかったときの説明。
 *
 * `pg` のメッセージは短く（`Connection terminated unexpectedly`）、
 * **何を確かめればいいかが分からない**。実際に Fly で、DB のマシンが停止していて
 * 40秒ぶら下がってから落ちるのを踏んだ。原因の候補を添えて、探す場所を示す。
 */
export function describeConnectionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;

  const connectionProblem =
    /terminated unexpectedly|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timeout expired/i.test(
      message,
    ) || ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(code ?? "");

  if (!connectionProblem) return `データベースの初期化に失敗しました: ${message}`;

  return [
    `データベースに接続できませんでした: ${message}`,
    "確かめること:",
    "  - DATABASE_URL の宛先が起動しているか（Fly なら `fly status -a <db アプリ>`。",
    "    停止したマシンは内部 DNS では起きない）",
    "  - ホスト名・ポート・認証情報が正しいか",
    "  - ネットワークから到達できるか（Fly の内部ネットワークは IPv6）",
  ].join("\n");
}
