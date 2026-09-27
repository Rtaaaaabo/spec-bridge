/**
 * 解析前の見積もり。
 *
 * 分類は安い（実測 $0.27・42秒）。**その時点で機能数が分かる**ので、
 * 高くつく PR は走らせる前に知らせられる。
 * 「安くする」より「高い PR を事前に知らせる」ほうが、判断を人に残せる。
 */

/**
 * 機能1件あたりの費用。**gitea #38966 の実測（6機能・$15）が根拠。**
 *
 * リポジトリの大きさで変わる（小さい例示リポジトリでは約 $0.4 だった）ので、
 * あくまで桁を知るための値。`SPEC_BRIDGE_COST_PER_FEATURE_USD` で上書きできる。
 */
export const COST_PER_FEATURE_USD = 2.5;

/** 機能1件あたりの所要（分）。同じく実測から */
export const MINUTES_PER_FEATURE = 4.5;

export interface RunEstimate {
  /** 解析する機能の数 */
  features: number;
  estimatedUsd: number;
  estimatedMinutes: number;
  /** 予算に達して書けない見込みの機能数 */
  willSkip: number;
  /** 見積もりの根拠（そのまま表示できる文言） */
  basis: string;
}

export interface EstimateOptions {
  budgetUsd?: number;
  costPerFeatureUsd?: number;
  minutesPerFeature?: number;
  /** 分類にかかったぶん（すでに使った額） */
  spentUsd?: number;
}

/**
 * 機能数から費用と時間を見積もる。
 *
 * **予測ではなく「実測の平均 × 機能数」。** 精度を装わないよう、根拠を文言で添える。
 */
export function estimateRun(features: number, options: EstimateOptions = {}): RunEstimate {
  const perFeature = options.costPerFeatureUsd ?? COST_PER_FEATURE_USD;
  const perFeatureMinutes = options.minutesPerFeature ?? MINUTES_PER_FEATURE;
  const spent = options.spentUsd ?? 0;

  const estimatedUsd = spent + features * perFeature;

  // 予算があるなら、何件目で止まるか。上限は着手前に見るので、超える1件までは走る
  let willSkip = 0;
  if (options.budgetUsd !== undefined) {
    let running = spent;
    let written = 0;
    for (let i = 0; i < features; i += 1) {
      if (running >= options.budgetUsd) break;
      running += perFeature;
      written += 1;
    }
    willSkip = features - written;
  }

  return {
    features,
    estimatedUsd: Math.round(estimatedUsd * 100) / 100,
    estimatedMinutes: Math.round(features * perFeatureMinutes * 10) / 10,
    willSkip,
    basis: `機能1件あたり $${perFeature}・${perFeatureMinutes}分（実測の平均）で計算`,
  };
}

/** 見積もりを1行にする */
export function formatEstimate(estimate: RunEstimate): string {
  const head =
    `${estimate.features} 機能 / 推定 $${estimate.estimatedUsd.toFixed(2)}・` +
    `約${estimate.estimatedMinutes}分`;
  return estimate.willSkip > 0
    ? `${head}（予算に達するため ${estimate.willSkip} 件は書かれません）`
    : head;
}

/** env から見積もりの係数を読む。リポジトリごとに実測が違うので上書きできる */
export function estimateOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pick<EstimateOptions, "costPerFeatureUsd" | "minutesPerFeature"> {
  const cost = Number(env["SPEC_BRIDGE_COST_PER_FEATURE_USD"]);
  const minutes = Number(env["SPEC_BRIDGE_MINUTES_PER_FEATURE"]);
  return {
    ...(Number.isFinite(cost) && cost > 0 ? { costPerFeatureUsd: cost } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { minutesPerFeature: minutes } : {}),
  };
}
