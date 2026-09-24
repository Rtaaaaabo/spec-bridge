import { analyzeFeature } from "./analyze.ts";
import { classifyPullRequest, type ClassifyResult } from "./classify.ts";
import type { ConfidenceBreakdown } from "./confidence.ts";
import { mergeAnalysis, type MergeWarning } from "./merge.ts";
import { DocStore } from "./store.ts";
import { surveyFeatures } from "./survey.ts";
import {
  backfillSource,
  isValidDocId,
  sourceFromPullRequest,
  type PullRequestInput,
} from "./types.ts";
import { UsageTally, type UsageSummary } from "./usage.ts";

export interface RunOptions {
  repoPath: string;
  docsPath: string;
  allowBash?: boolean;
  /** true なら分類をスキップして必ず解析する */
  force?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  skipped: boolean;
  classification: ClassifyResult;
  updated: Array<{
    id: string;
    path: string;
    confidence: number;
    breakdown: ConfidenceBreakdown;
    warnings: Array<MergeWarning | { kind: "invalid-source"; detail: string }>;
    openQuestions: string[];
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
    return { skipped: true, classification, updated: [], failures: [], usage: tally.summary() };
  }
  if (classification.targets.length === 0) {
    log("  対象機能が特定できませんでした。スキップします。");
    return { skipped: true, classification, updated: [], failures: [], usage: tally.summary() };
  }

  const updated: RunResult["updated"] = [];
  const failures: RunResult["failures"] = [];
  const source = sourceFromPullRequest(pr);

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

    log(`▸ 「${target.title}」(${id}) を解析中…`);
    try {
      const existing = target.docId ? await store.get(target.docId) : null;
      const result = await analyzeFeature(
        { kind: "pull-request", pr },
        existing,
        { id, title: target.title, why: target.why },
        {
          repoPath: options.repoPath,
          allowBash: options.allowBash,
          onProgress: log,
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
      const path = await store.save(doc);
      log(`  ✓ 書き出し: ${path} (確度 ${doc.meta.confidence.toFixed(2)})`);

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
      log(`  ✗ 失敗: ${message}`);
      failures.push({ id, error: message });
    }
  }

  if (updated.length > 0) {
    await store.writeIndexPage();
    log(`▸ インデックスページを更新しました`);
  }

  return { skipped: false, classification, updated, failures, usage: tally.summary() };
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
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const store = new DocStore(options.docsPath);
  const source = backfillSource(options.repo);
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

  const updated: RunResult["updated"] = [];
  const failures: RunResult["failures"] = [];

  for (const [i, feature] of survey.features.entries()) {
    // 上の normalizeSurvey で両方 null の項目は落としているが、型の上では null になりうる
    const id = feature.docId ?? feature.newDocId;
    if (!id) {
      failures.push({ id: feature.title, error: "docId と newDocId の両方が null でした" });
      continue;
    }

    log(`▸ [${i + 1}/${survey.features.length}] 「${feature.title}」(${id}) を解析中…`);
    try {
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

      updated.push({
        id,
        path,
        confidence: doc.meta.confidence,
        breakdown: result.confidence,
        warnings: [
          ...warnings,
          ...result.warnings.map((detail) => ({ kind: "invalid-source" as const, detail })),
        ],
        openQuestions: doc.body.openQuestions,
      });
    } catch (error) {
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
    usage: tally.summary(),
  };
}
