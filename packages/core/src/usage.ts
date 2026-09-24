/**
 * エージェント呼び出し1回で消費した量。Agent SDK の result メッセージから取る。
 */
export interface AgentUsage {
  /**
   * API 料金換算の推定額（USD）。SDK が算出した値をそのまま使う。
   * Claude のサブスクリプションで認証している場合は、実際の請求額ではない。
   */
  costUsd: number;
}

/** パイプライン1回ぶんの合計 */
export interface UsageSummary {
  costUsd: number;
  /** エージェントを呼んだ回数（失敗した呼び出しも含む） */
  agentRuns: number;
  /** パイプライン全体の実時間（ミリ秒） */
  elapsedMs: number;
}

/**
 * result メッセージから消費量を取り出す。
 *
 * 失敗した呼び出し（`subtype` が success 以外）でも費用はかかっているので、
 * 成否に関係なく取る。値が欠けていれば 0 として数える（見積もりを水増ししない）。
 */
export function usageFromResult(message: Record<string, unknown>): AgentUsage {
  const cost = message["total_cost_usd"];
  return { costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0 };
}

/** 複数のエージェント呼び出しの消費量を積み上げる */
export class UsageTally {
  private costUsd = 0;
  private agentRuns = 0;
  private readonly startedAt: number;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /** `onUsage` にそのまま渡せるよう、アロー関数で束縛しておく */
  readonly add = (usage: AgentUsage): void => {
    this.costUsd += usage.costUsd;
    this.agentRuns += 1;
  };

  summary(now: number = Date.now()): UsageSummary {
    return {
      costUsd: this.costUsd,
      agentRuns: this.agentRuns,
      elapsedMs: Math.max(0, now - this.startedAt),
    };
  }
}

/** 「12分34秒」の形にする。1分未満は秒だけ、1時間以上は時間から */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** CLI の結果欄に出す1行 */
export function formatUsageSummary(usage: UsageSummary): string {
  return (
    `所要時間 ${formatElapsed(usage.elapsedMs)} / ` +
    `エージェント呼び出し ${usage.agentRuns} 回 / ` +
    `推定コスト $${usage.costUsd.toFixed(2)}`
  );
}
