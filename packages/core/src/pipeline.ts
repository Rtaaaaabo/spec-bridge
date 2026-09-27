import { analyzeFeature } from "./analyze.ts";
import { classifyPullRequest, type ClassifyResult } from "./classify.ts";
import { runWithConcurrency } from "./concurrency.ts";
import {
  estimateOptionsFromEnv,
  estimateRun,
  formatEstimate,
  type RunEstimate,
} from "./estimate.ts";
import type { ConfidenceBreakdown } from "./confidence.ts";
import { mergeAnalysis, type MergeWarning } from "./merge.ts";
import { DocStore } from "./store.ts";
import { surveyFeatures, type SurveyedFeature } from "./survey.ts";
import {
  backfillSource,
  isValidDocId,
  sourceFromPullRequest,
  type OpenQuestion,
  type PullRequestInput,
} from "./types.ts";
import { UsageTally, type UsageSummary } from "./usage.ts";

export interface RunOptions {
  repoPath: string;
  docsPath: string;
  allowBash?: boolean;
  /** true なら分類をスキップして必ず解析する */
  force?: boolean;
  /**
   * この PR 1本で使ってよい額（USD）。超えたら残りの機能を書かずに終える。
   *
   * 大規模 PR は実測で **6機能・約 $15**（gitea #38966）。上限が無いと、
   * 1回のマージでいくらでも使えてしまう。**書けなかった機能は結果に残す**ので、
   * 予算を上げて再実行すれば続きから拾える。
   */
  budgetUsd?: number;
  /**
   * 機能の解析を何件まで同時に走らせるか（既定 1）。
   *
   * 機能どうしは独立で、1件あたり4〜5分かかる。**並列にしても費用は変わらず、
   * 実時間だけ縮む**（6機能で29分 → 2並列なら15分程度）。
   * ただし LLM の利用上限に当たりやすくなるので、既定は直列のまま。
   */
  concurrency?: number;
  log?: (line: string) => void;
}

/** 予算に達して書けなかった機能。**黙って落とさず、必ず結果に残す** */
export interface SkippedTarget {
  id: string;
  title: string;
}

export interface RunResult {
  skipped: boolean;
  classification: ClassifyResult;
  /** 解析を始める前に出した見積もり。実測と並べて精度を確かめられる */
  estimate: RunEstimate | null;
  /** 予算に達したため書かなかった機能 */
  skippedTargets: SkippedTarget[];
  updated: Array<{
    id: string;
    path: string;
    confidence: number;
    breakdown: ConfidenceBreakdown;
    warnings: Array<MergeWarning | { kind: "invalid-source"; detail: string }>;
    openQuestions: OpenQuestion[];
  }>;
  failures: Array<{ id: string; error: string }>;
  /** 所要時間と推定コスト */
  usage: UsageSummary;
}

/**
 * PR ひとつを機能ドキュメントへ反映する Phase 0 のメインパイプライン。
 *
 *   PR取得 → 仕様に影響するか分類 → 対象機能ごとにリポジトリを探索 → マージ → Markdown 書き出し
 */
export async function runPipeline(
  pr: PullRequestInput,
  options: RunOptions,
): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const store = new DocStore(options.docsPath);
  const tally = new UsageTally();

  log(`▸ 既存ドキュメントを読み込み中: ${options.docsPath}`);
  const index = await store.index();
  log(`  ${index.length} 件の機能ドキュメントを検出`);

  log(`▸ この PR が仕様に影響するか分類中…`);
  const classification = await classifyPullRequest(pr, index, {
    onProgress: log,
    onUsage: tally.add,
  });
  log(`  → ${classification.affectsSpec ? "影響あり" : "影響なし"}: ${classification.reason}`);

  if (!classification.affectsSpec && !options.force) {
    return {
      skipped: true,
      classification,
      estimate: null,
      skippedTargets: [],
      updated: [],
      failures: [],
      usage: tally.summary(),
    };
  }
  if (classification.targets.length === 0) {
    log("  対象機能が特定できませんでした。スキップします。");
    return {
      skipped: true,
      classification,
      estimate: null,
      skippedTargets: [],
      updated: [],
      failures: [],
      usage: tally.summary(),
    };
  }

  // 分類は安い（実測 $0.27）。**ここで機能数が分かるので、走らせる前に費用を知らせる。**
  // 「安くする」より「高い PR を事前に知らせる」ほうが、判断を人に残せる
  const estimate = estimateRun(classification.targets.length, {
    ...estimateOptionsFromEnv(),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    spentUsd: tally.summary().costUsd,
  });
  log(`▸ 見積もり: ${formatEstimate(estimate)}`);
  log(`  （${estimate.basis}）`);

  const updated: RunResult["updated"] = [];
  const failures: RunResult["failures"] = [];
  const skippedTargets: SkippedTarget[] = [];
  const source = sourceFromPullRequest(pr);

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  if (concurrency > 1) {
    log(`▸ ${concurrency} 件を同時に解析します（費用は変わらず、実時間だけ縮みます）`);
  }

  // 解析できる対象だけを先に選り分ける。ID が不正なものは走らせる前に落とす
  const analyzable: Array<{ target: (typeof classification.targets)[number]; id: string }> = [];
  for (const target of classification.targets) {
    const id = target.docId ?? target.newDocId;
    if (!id) {
      failures.push({ id: target.title, error: "docId と newDocId の両方が null でした" });
      continue;
    }
    // 保存時にも弾かれるが、そこまで行くと数分の解析が無駄になる
    if (!isValidDocId(id)) {
      failures.push({ id, error: `ID に使えない文字が含まれています: ${JSON.stringify(id)}` });
      continue;
    }
    // 同じ ID が2回来ると、並列だと同じファイルに同時に書くことになる
    // （直列でも後勝ちで変更履歴が消える）。分類の出力なので、起こりうる
    if (analyzable.some((entry) => entry.id === id)) {
      log(`  ⚠ 同じ機能が2回挙がっています。2件目は無視します: ${id}`);
      continue;
    }
    analyzable.push({ target, id });
  }

  const pool = await runWithConcurrency(
    analyzable,
    async ({ target, id }) => {
      // 並列だとログが混ざるので、どの機能の行かを示す
      const line = (text: string) => log(concurrency > 1 ? `[${id}] ${text}` : text);
      line(`▸ 「${target.title}」(${id}) を解析中…`);
      try {
        const existing = target.docId ? await store.get(target.docId) : null;
        const result = await analyzeFeature(
          { kind: "pull-request", pr },
          existing,
          { id, title: target.title, why: target.why, files: target.files },
          {
            repoPath: options.repoPath,
            allowBash: options.allowBash,
            onProgress: line,
            onUsage: tally.add,
          },
        );

        const { doc, warnings } = mergeAnalysis(
          existing,
          result.output,
          source,
          id,
          classification.issueKeys,
        );
        // 保存は直列にしたいところだが、機能ごとにファイルが分かれるので競合しない
        const path = await store.save(doc);
        line(`  ✓ 書き出し: ${path} (確度 ${doc.meta.confidence.toFixed(2)})`);

        updated.push({
          id,
          path,
          confidence: doc.meta.confidence,
          breakdown: result.confidence,
          warnings: [
            ...warnings,
            ...result.warnings.map((detail) => ({
              kind: "invalid-source" as const,
              detail,
            })),
          ],
          openQuestions: doc.body.openQuestions,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        line(`  ✗ 失敗: ${message}`);
        failures.push({ id, error: message });
      }
    },
    {
      limit: concurrency,
      // 予算は着手前に見る。並列だと、同時に始まった件数ぶんは上限を超えうる
      ...(options.budgetUsd !== undefined
        ? { shouldStop: () => tally.summary().costUsd >= (options.budgetUsd as number) }
        : {}),
    },
  );

  for (const { target, id } of pool.notStarted) {
    log(
      `⏭ 「${target.title}」(${id}) は予算に達したため書きません` +
        `（$${tally.summary().costUsd.toFixed(2)} / 上限 $${options.budgetUsd}）`,
    );
    skippedTargets.push({ id, title: target.title });
  }

  if (updated.length > 0) {
    await store.writeIndexPage();
    log(`▸ インデックスページを更新しました`);
  }

  if (skippedTargets.length > 0) {
    log(
      `⚠ 予算（$${options.budgetUsd}）に達したため ${skippedTargets.length} 件の機能を書いていません。` +
        `予算を上げて再実行すると続きから拾えます。`,
    );
  }

  return {
    skipped: false,
    classification,
    estimate,
    skippedTargets,
    updated,
    failures,
    usage: tally.summary(),
  };
}

export interface BackfillOptions {
  /** 解析対象リポジトリのローカルチェックアウト */
  repoPath: string;
  docsPath: string;
  /** `org/repo`。出典の帰属とマルチリポジトリの保護に使う */
  repo: string;
  /** 生成する機能数の上限 */
  limit?: number;
  allowBash?: boolean;
  log?: (line: string) => void;
}

export interface BackfillResult {
  /** 列挙された機能数 */
  surveyed: number;
  /** 機能の列挙時に機械的に検出した問題 */
  surveyWarnings: string[];
  updated: RunResult["updated"];
  failures: RunResult["failures"];
  /** 所要時間と推定コスト。実測の数字として外に出せるよう、列挙から全件の解析までを含む */
  usage: UsageSummary;
}

/**
 * いまのコードから機能ドキュメント一式を書き起こす（バックフィル）。
 *
 * PR 単位のパイプラインと違い、差分が無い。そのため:
 * - 対象の決定は `classifyPullRequest` ではなく `surveyFeatures`（コード側から機能を起こす）
 * - 確度の読了率は「変更ファイル」ではなく「出典に挙げたファイル」で測る（`analyze.ts` 参照）
 * - 変更履歴に PR 参照を作らない（`backfillSource`）
 *
 * 1件失敗しても続行し、書けたものは残す。全部を1トランザクションにすると
 * 20件目の失敗で19件分の解析が捨てられる。
 */
export interface BackfillSurvey {
  features: SurveyedFeature[];
  warnings: string[];
  usage: UsageSummary;
}

/**
 * バックフィルの前半だけを行う: **何についてドキュメントを書くかを決める。**
 *
 * 後半（機能ごとの解析）と分けてあるのは、SaaS 側で機能1件＝ジョブ1件として
 * 分割して走らせるため。1件あたり数分・上限に当たりうるので、まとめて1トランザクションに
 * すると途中で全部失う。CLI は `runBackfill` がこの2つを順に呼ぶ。
 */
export async function surveyForBackfill(options: BackfillOptions): Promise<BackfillSurvey> {
  const log = options.log ?? (() => {});
  const store = new DocStore(options.docsPath);
  const tally = new UsageTally();

  log(`▸ 既存ドキュメントを読み込み中: ${options.docsPath}`);
  const index = await store.index();
  log(`  ${index.length} 件の機能ドキュメントを検出`);

  log(`▸ ${options.repo} からドキュメント化すべき機能を列挙中…`);
  const survey = await surveyFeatures(options.repo, index, {
    repoPath: options.repoPath,
    limit: options.limit,
    allowBash: options.allowBash,
    onProgress: log,
    onUsage: tally.add,
  });
  log(`  ${survey.features.length} 件の機能を検出`);
  for (const warning of survey.warnings) log(`  ⚠ ${warning}`);

  return { features: survey.features, warnings: survey.warnings, usage: tally.summary() };
}

/**
 * 列挙された機能のうち1件を書き起こす。
 *
 * **失敗は投げる。** 呼び出し側（CLI のループ / ジョブのワーカー）が、
 * 続行するか再試行するかを決める。
 */
export async function backfillOneFeature(
  feature: SurveyedFeature,
  options: BackfillOptions,
): Promise<{ updated: RunResult["updated"][number]; usage: UsageSummary }> {
  const log = options.log ?? (() => {});
  const store = new DocStore(options.docsPath);
  const source = backfillSource(options.repo);
  const tally = new UsageTally();

  // normalizeSurvey で両方 null の項目は落としているが、型の上では null になりうる
  const id = feature.docId ?? feature.newDocId;
  if (!id) throw new Error("docId と newDocId の両方が null でした");

  const existing = feature.docId ? await store.get(feature.docId) : null;
  const result = await analyzeFeature(
    { kind: "codebase", repo: options.repo, entryPoints: feature.entryPoints },
    existing,
    { id, title: feature.title, why: feature.why },
    {
      repoPath: options.repoPath,
      allowBash: options.allowBash,
      onProgress: log,
      onUsage: tally.add,
    },
  );

  const { doc, warnings } = mergeAnalysis(existing, result.output, source, id, []);
  const path = await store.save(doc);
  log(`  ✓ 書き出し: ${path} (確度 ${doc.meta.confidence.toFixed(2)})`);

  return {
    updated: {
      id,
      path,
      confidence: doc.meta.confidence,
      breakdown: result.confidence,
      warnings: [
        ...warnings,
        ...result.warnings.map((detail) => ({ kind: "invalid-source" as const, detail })),
      ],
      openQuestions: doc.body.openQuestions,
    },
    usage: tally.summary(),
  };
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const store = new DocStore(options.docsPath);

  const survey = await surveyForBackfill(options);
  let costUsd = survey.usage.costUsd;
  let agentRuns = survey.usage.agentRuns;
  const startedAt = Date.now() - survey.usage.elapsedMs;

  const updated: RunResult["updated"] = [];
  const failures: RunResult["failures"] = [];

  for (const [i, feature] of survey.features.entries()) {
    const id = feature.docId ?? feature.newDocId ?? feature.title;
    log(`▸ [${i + 1}/${survey.features.length}] 「${feature.title}」(${id}) を解析中…`);
    try {
      const result = await backfillOneFeature(feature, options);
      costUsd += result.usage.costUsd;
      agentRuns += result.usage.agentRuns;
      updated.push(result.updated);
    } catch (error) {
      // 1件失敗しても続ける。全体を1トランザクションにすると、
      // 20件目の失敗で19件ぶんの解析が捨てられる
      const message = error instanceof Error ? error.message : String(error);
      log(`  ✗ 失敗: ${message}`);
      failures.push({ id, error: message });
    }
  }

  if (updated.length > 0) {
    await store.writeIndexPage();
    log(`▸ インデックスページを更新しました`);
  }

  return {
    surveyed: survey.features.length,
    surveyWarnings: survey.warnings,
    updated,
    failures,
    usage: { costUsd, agentRuns, elapsedMs: Date.now() - startedAt },
  };
}
