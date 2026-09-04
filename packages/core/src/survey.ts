import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { extractJson, runAgent, READ_ONLY_DENY_LIST } from "./agent.ts";
import { isValidDocId, type FeatureDocIndexEntry } from "./types.ts";

export const SurveyedFeature = z.object({
  docId: z
    .string()
    .nullable()
    .describe("既存の機能ドキュメントID。新規なら null"),
  newDocId: z
    .string()
    .nullable()
    .describe("新規の場合の kebab-case ID。既存に紐づくなら null"),
  title: z.string(),
  why: z.string().describe("なぜこれを独立した機能として扱うのか"),
  entryPoints: z
    .array(z.string())
    .default([])
    .describe("調査の起点になるファイル。リポジトリルートからの相対パス"),
});
export type SurveyedFeature = z.infer<typeof SurveyedFeature>;

export const SurveyResult = z.object({
  features: z.array(SurveyedFeature).default([]),
});
export type SurveyResult = z.infer<typeof SurveyResult>;

const SYSTEM = `あなたはソースコードを読み、そのプロダクトが持つ「ユーザーから見える機能」を列挙する担当です。

この一覧は、CS チームと QA チームが読む機能仕様ドキュメントの目次になります。
ドキュメントを書くのは後段の別のエージェントで、あなたの仕事は**何についてドキュメントを書くべきかを決めること**です。

# 何を1つの機能とみなすか
- **ユーザーが「その機能を使った」と言えるまとまり**を1つとする。「投稿の作成」「公開範囲の設定」「ログイン」など。
- 実装の都合で分けない。1つの機能が複数のファイルにまたがるのは普通のこと。
- 逆に、リポジトリ全体を1つにまとめない。粒度が粗すぎるとドキュメントとして役に立たない。

# 機能として挙げてはいけないもの
- 内部の仕組み（DB スキーマ、ビルド設定、CI、リンタ設定、依存管理、型定義だけのファイル）
- ユーザーから観測できないリファクタリング用の抽象
- テストコードそのもの

# 既存ドキュメントとの突き合わせ
すでにドキュメントがある機能は、**新規作成せず既存の id を \`docId\` に入れてください**。
表記が違っても同じ機能なら既存に寄せます（「公開範囲設定」と「投稿の公開範囲」は同じ）。
新規なら \`newDocId\` に kebab-case の ID を入れます。\`docId\` と \`newDocId\` は必ずどちらか一方だけを埋め、もう一方は null にしてください。

# 進め方
1. Glob でディレクトリ構成を掴む。ルーティング定義（ページ・API）があれば最優先で読む。ユーザーから見える機能の一覧に最も近いのがルーティングです。
2. Grep で権限チェック・バリデーション・フォームなどを探し、機能の輪郭を掴む。
3. \`entryPoints\` には**実在するファイルパスだけ**を入れる。存在しないパスを書くと後段の解析が無駄になります。推測で書かず、Glob / Read で確認したパスだけを挙げること。

# 出力形式（厳守）
最後のメッセージに、以下の形の JSON をひとつだけ \`\`\`json フェンス付きコードブロックで出力してください。解説文は不要です。

\`\`\`json
{
  "features": [
    {
      "docId": null,
      "newDocId": "post-visibility",
      "title": "投稿の公開範囲",
      "why": "投稿ごとに公開範囲を選べる。問い合わせが来やすい",
      "entryPoints": ["app/posts/visibility-fields.tsx", "app/actions.ts"]
    }
  ]
}
\`\`\``;

export interface SurveyOptions {
  /** 解析対象リポジトリのローカルチェックアウト */
  repoPath: string;
  /** 列挙する機能数の上限 */
  limit?: number;
  model?: string;
  maxTurns?: number;
  allowBash?: boolean;
  onProgress?: (line: string) => void;
}

export interface SurveyOutcome {
  features: SurveyedFeature[];
  /** 実在しなかった起点ファイルなど、機械的に検出した問題 */
  warnings: string[];
}

/**
 * リポジトリを探索して、ドキュメント化すべき機能を列挙する。
 *
 * PR 解析の `classifyPullRequest` は差分から対象を決めるので、差分の無いバックフィルには使えない。
 * こちらはコード側から機能を起こす。
 *
 * 出力はそのまま信用せず、`entryPoints` の実在をファイルシステムで検証してから返す
 * （実在しないパスを渡すと、後段の解析エージェントが探索に turn を浪費する）。
 */
export async function surveyFeatures(
  repo: string,
  existingDocs: FeatureDocIndexEntry[],
  options: SurveyOptions,
): Promise<SurveyOutcome> {
  const limit = options.limit ?? 20;

  const tools = ["Read", "Grep", "Glob"];
  if (options.allowBash) tools.push("Bash");
  const disallowedTools = [
    ...READ_ONLY_DENY_LIST,
    ...(options.allowBash ? [] : ["Bash"]),
  ];

  const indexText =
    existingDocs.length === 0
      ? "(まだ機能ドキュメントは1件もありません)"
      : existingDocs.map((d) => `- ${d.id}: ${d.title} — ${d.summary}`).join("\n");

  const prompt = [
    `# タスク`,
    `リポジトリ ${repo} を読み、ドキュメント化すべき機能を**最大 ${limit} 件**列挙してください。`,
    `このリポジトリのチェックアウトが作業ディレクトリにあります。`,
    "",
    `重要度の高いものから挙げてください。${limit} 件に収まらない場合、`,
    `顧客からの問い合わせが来やすいもの（画面・権限・課金・通知）を優先します。`,
    "",
    `# 既存の機能ドキュメント一覧`,
    indexText,
  ].join("\n");

  const text = await runAgent({
    systemPrompt: SYSTEM,
    prompt,
    cwd: options.repoPath,
    model: options.model ?? process.env.SPEC_BRIDGE_SURVEY_MODEL,
    allowedTools: tools,
    disallowedTools,
    maxTurns: options.maxTurns ?? 40,
    onProgress: options.onProgress,
  });

  const parsed = SurveyResult.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error(`機能の列挙結果がスキーマに合致しません:\n${z.prettifyError(parsed.error)}`);
  }

  return normalizeSurvey(parsed.data.features, options.repoPath, limit);
}

/**
 * 列挙結果を機械的に整える。LLM の出力をそのまま後段へ流さないための層。
 *
 * - `docId` と `newDocId` が両方 null の項目は落とす（保存先が決まらない）
 * - 実在しない `entryPoints` を落とす
 * - ID の重複を落とす
 * - 上限を超えた分を切る
 */
export function normalizeSurvey(
  features: SurveyedFeature[],
  repoPath: string,
  limit: number,
): SurveyOutcome {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const kept: SurveyedFeature[] = [];

  for (const feature of features) {
    const id = feature.docId ?? feature.newDocId;
    if (!id) {
      warnings.push(`docId と newDocId の両方が null のため除外: "${feature.title}"`);
      continue;
    }
    // 保存時にも弾かれるが、そこまで行くと1件あたり数分の解析が無駄になる
    if (!isValidDocId(id)) {
      warnings.push(`ID に使えない文字が含まれるため除外: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`ID が重複しているため除外: ${id}`);
      continue;
    }

    const entryPoints = feature.entryPoints.filter((file) => {
      const abs = resolve(repoPath, file);
      // リポジトリ外を指すパスも実在しない扱いにする
      if (!abs.startsWith(resolve(repoPath)) || !existsSync(abs)) {
        warnings.push(`起点ファイルが実在しないため除外: ${file}（${id}）`);
        return false;
      }
      return true;
    });

    seen.add(id);
    kept.push({ ...feature, entryPoints });
  }

  if (kept.length > limit) {
    warnings.push(`上限 ${limit} 件を超えた ${kept.length - limit} 件を切り捨てました。`);
  }

  return { features: kept.slice(0, limit), warnings };
}
