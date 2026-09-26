/**
 * 待てば直るエラーか。
 *
 * バックフィルの実測で、7機能を連続実行して4件目で Claude の利用上限に当たった。
 * ああいう「待てば通る」ものだけ再試行したい。**プロンプトのバグや権限不足を
 * 何度も再試行すると、直らないものに課金し続けることになる。**
 */
export function isTransient(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  // 429 はレート制限、5xx は向こう側の一時障害
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;

  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return [
    "rate limit",
    "secondary rate",
    "429",
    "overloaded",
    "usage limit",
    "session limit", // Claude の利用上限（実測で踏んだ文言）
    "timeout",
    "etimedout",
    "econnreset",
    "socket hang up",
    "service unavailable",
    "bad gateway",
  ].some((needle) => message.includes(needle));
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** ジッタ用。テストから固定値を渡せるようにする */
  random?: () => number;
}

/**
 * 再試行までの待ち時間。指数バックオフ + ジッタ。
 *
 * ジッタを入れるのは、複数のジョブが同じ上限に当たったときに、
 * 揃って同じ瞬間に再試行して再び全滅するのを避けるため。
 */
export function backoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 30_000;
  const max = options.maxMs ?? 30 * 60_000;
  const random = options.random ?? Math.random;

  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // ±25% のジッタ
  const jitter = exponential * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}
