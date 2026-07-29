import { analyzeFeature } from "./analyze.ts";
import { classifyPullRequest, type ClassifyResult } from "./classify.ts";
import type { ConfidenceBreakdown } from "./confidence.ts";
import { mergeAnalysis, type MergeWarning } from "./merge.ts";
import { DocStore } from "./store.ts";
import type { PullRequestInput } from "./types.ts";

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

  log(`▸ 既存ドキュメントを読み込み中: ${options.docsPath}`);
  const index = await store.index();
  log(`  ${index.length} 件の機能ドキュメントを検出`);

  log(`▸ この PR が仕様に影響するか分類中…`);
  const classification = await classifyPullRequest(pr, index, { onProgress: log });
  log(`  → ${classification.affectsSpec ? "影響あり" : "影響なし"}: ${classification.reason}`);

  if (!classification.affectsSpec && !options.force) {
    return { skipped: true, classification, updated: [], failures: [] };
  }
  if (classification.targets.length === 0) {
    log("  対象機能が特定できませんでした。スキップします。");
    return { skipped: true, classification, updated: [], failures: [] };
  }

  const updated: RunResult["updated"] = [];
  const failures: RunResult["failures"] = [];

  for (const target of classification.targets) {
    const id = target.docId ?? target.newDocId;
    if (!id) {
      failures.push({ id: target.title, error: "docId と newDocId の両方が null でした" });
      continue;
    }

    log(`▸ 「${target.title}」(${id}) を解析中…`);
    try {
      const existing = target.docId ? await store.get(target.docId) : null;
      const result = await analyzeFeature(
        pr,
        existing,
        { id, title: target.title, why: target.why },
        {
          repoPath: options.repoPath,
          allowBash: options.allowBash,
          onProgress: log,
        },
      );

      const { doc, warnings } = mergeAnalysis(
        existing,
        result.output,
        pr,
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

  return { skipped: false, classification, updated, failures };
}
