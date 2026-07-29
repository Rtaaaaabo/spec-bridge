import type { AnalyzeOutput } from "./analyze.ts";
import type { FeatureDoc, FeatureDocBody, PullRequestInput } from "./types.ts";

export interface MergeWarning {
  kind:
    | "rule-without-source"
    | "status-demoted"
    | "content-shrunk"
    | "foreign-records-restored";
  detail: string;
}

export interface MergeResult {
  doc: FeatureDoc;
  warnings: MergeWarning[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 今回の PR のリポジトリでは検証できなかった記述を、既存ドキュメントから引き継ぐ。
 *
 * バックエンドとフロントエンドが別リポジトリのチームでは、フロントの PR を解析するエージェントは
 * バックエンドのコードを読めない。読めなかった記述を落とされるとドキュメントが痩せていくので、
 * 「今回の PR のリポジトリを出典に持たない記述」は LLM の出力に関わらず保持する。
 *
 * プロンプトで「消すな」と指示するだけでは守れないため、マージ層で構造的に担保している。
 */
function preserveForeign<T>(
  next: T[],
  previous: T[],
  isForeign: (item: T) => boolean,
  key: (item: T) => string,
): { items: T[]; restored: number } {
  const seen = new Set(next.map(key));
  const restoredItems = previous.filter((item) => isForeign(item) && !seen.has(key(item)));
  return { items: [...next, ...restoredItems], restored: restoredItems.length };
}

/** repo フィールドを直接持つ項目（画面・エンドポイント） */
function foreignByRepo(ownRepo: string) {
  return (item: { repo: string }): boolean => item.repo !== "" && item.repo !== ownRepo;
}

/** sources を持つ項目（仕様・権限・フラグ）。出典がすべて他リポジトリなら「検証できなかった」とみなす */
function foreignBySources(ownRepo: string) {
  return (item: { sources: Array<{ repo: string }> }): boolean =>
    item.sources.length > 0 && item.sources.every((s) => s.repo !== ownRepo);
}

/**
 * 解析結果を既存ドキュメントにマージする。
 *
 * ここで守っている不変条件:
 * - 出典のない `rules` は書き出さない（ハルシネーションがそのまま CS の回答になるのを防ぐ）
 * - 他リポジトリ由来の記述は、今回検証できなくても保持する（マルチリポジトリでの消失防止）
 * - changelog と meta は LLM に触らせず、ツール側で決定論的に積む
 * - `verified`（人間レビュー済）だったドキュメントは、自動更新されたら `draft` に戻す
 */
export function mergeAnalysis(
  existing: FeatureDoc | null,
  analysis: AnalyzeOutput,
  pr: PullRequestInput,
  targetId: string,
  issueKeys: string[],
): MergeResult {
  const warnings: MergeWarning[] = [];
  const prRef = `${pr.repo}#${pr.number}`;

  const rules = analysis.body.rules.filter((rule) => {
    if (rule.sources.length === 0) {
      warnings.push({
        kind: "rule-without-source",
        detail: `出典がないため除外: "${rule.text.slice(0, 80)}"`,
      });
      return false;
    }
    return true;
  });

  // 単一リポジトリのプロジェクトでは repo が省略されがちなので、PR のリポジトリで補う
  const fill = <T extends { repo: string }>(item: T): T =>
    item.repo ? item : { ...item, repo: pr.repo };
  const fillSources = <T extends { sources: Array<{ repo: string; pr: string | null }> }>(
    item: T,
  ): T => ({
    ...item,
    sources: item.sources.map((s) => ({
      ...s,
      repo: s.repo || pr.repo,
      pr: s.pr ?? prRef,
    })),
  });

  const filled: FeatureDocBody = {
    ...analysis.body,
    rules: rules.map(fillSources),
    screens: analysis.body.screens.map(fill),
    endpoints: analysis.body.endpoints.map(fill),
    permissions: analysis.body.permissions.map(fillSources),
    featureFlags: analysis.body.featureFlags.map(fillSources),
  };

  const prev = existing?.body;
  const byRepo = foreignByRepo(pr.repo);
  const bySources = foreignBySources(pr.repo);

  const mergedRules = preserveForeign(
    filled.rules,
    prev?.rules ?? [],
    bySources,
    (r) => normalize(r.text),
  );
  const mergedScreens = preserveForeign(
    filled.screens,
    prev?.screens ?? [],
    byRepo,
    (s) => `${s.repo}|${s.path}`,
  );
  const mergedEndpoints = preserveForeign(
    filled.endpoints,
    prev?.endpoints ?? [],
    byRepo,
    (e) => `${e.repo}|${e.method.toUpperCase()}|${e.path}`,
  );
  const mergedPermissions = preserveForeign(
    filled.permissions,
    prev?.permissions ?? [],
    bySources,
    (p) => `${normalize(p.role)}|${normalize(p.canDo)}`,
  );
  const mergedFlags = preserveForeign(
    filled.featureFlags,
    prev?.featureFlags ?? [],
    bySources,
    (f) => f.name,
  );

  const restored =
    mergedRules.restored +
    mergedScreens.restored +
    mergedEndpoints.restored +
    mergedPermissions.restored +
    mergedFlags.restored;

  if (restored > 0) {
    warnings.push({
      kind: "foreign-records-restored",
      detail:
        `他リポジトリ由来の記述 ${restored} 件を既存ドキュメントから引き継ぎました` +
        `（今回の PR は ${pr.repo} のため検証できていません）。`,
    });
  }

  const body: FeatureDocBody = {
    ...filled,
    rules: mergedRules.items,
    screens: mergedScreens.items,
    endpoints: mergedEndpoints.items,
    permissions: mergedPermissions.items,
    featureFlags: mergedFlags.items,
  };

  if (prev) {
    const before = prev.rules.length;
    const after = body.rules.length;
    if (after < before * 0.6 && before >= 3) {
      warnings.push({
        kind: "content-shrunk",
        detail: `仕様項目が ${before} → ${after} に減りました。既存の記述が失われていないかレビューしてください。`,
      });
    }
  }

  const previousStatus = existing?.meta.status ?? "draft";
  if (previousStatus === "verified") {
    warnings.push({
      kind: "status-demoted",
      detail:
        "レビュー済みだったドキュメントを自動更新したため draft に戻しました。再レビューが必要です。",
    });
  }

  const doc: FeatureDoc = {
    meta: {
      id: targetId,
      status: "draft",
      owners: existing?.meta.owners ?? [],
      repos: unique([...(existing?.meta.repos ?? []), pr.repo]),
      issueKeys: unique([...(existing?.meta.issueKeys ?? []), ...issueKeys]),
      updatedAt: today(),
      updatedByPRs: unique([...(existing?.meta.updatedByPRs ?? []), prRef]).slice(-20),
      confidence: analysis.confidence,
    },
    body,
    changelog: [
      ...(existing?.changelog ?? []),
      {
        date: pr.mergedAt?.slice(0, 10) ?? today(),
        summary: analysis.changeSummary,
        pr: prRef,
      },
    ],
  };

  return { doc, warnings };
}
