import { z } from "zod";
import { extractJson, runAgent, READ_ONLY_DENY_LIST } from "./agent.ts";
import type { FeatureDocIndexEntry, PullRequestInput } from "./types.ts";

export const ClassifyResult = z.object({
  affectsSpec: z
    .boolean()
    .describe("この PR がユーザーから見える仕様に影響するか"),
  reason: z.string(),
  issueKeys: z.array(z.string()).default([]),
  targets: z
    .array(
      z.object({
        docId: z
          .string()
          .nullable()
          .describe("既存の機能ドキュメントID。新規なら null"),
        newDocId: z
          .string()
          .nullable()
          .describe("新規の場合の kebab-case ID。既存に紐づくなら null"),
        title: z.string(),
        why: z.string(),
      }),
    )
    .default([]),
});
export type ClassifyResult = z.infer<typeof ClassifyResult>;

const SYSTEM = `あなたはソフトウェアの変更を仕様の観点で分類する担当です。

判断すること:
1. この PR は「ユーザーから見える仕様」に影響するか。
   影響しない例: 依存パッケージ更新、CI 設定、フォーマット修正、内部リファクタリング（振る舞いが変わらないもの）、テストのみの変更。
   影響する例: 画面・API・バリデーション・権限・エラーメッセージ・料金計算・通知条件などユーザーが観測できる変更。
2. 影響する場合、どの機能ドキュメントを更新すべきか。既存インデックスに該当があればその id を docId に、なければ newDocId に kebab-case の新規 ID を入れる（docId と newDocId は必ずどちらか一方だけを埋め、もう一方は null にする）。
3. ブランチ名・PRタイトル・本文から課題管理ツールのキー（例: PROJ-123）を抽出する。なければ空配列。

# 既存ドキュメントとの突き合わせ（マルチリポジトリ対応で最重要）
バックエンドとフロントエンドが別リポジトリに分かれているチームでは、**1つの機能が複数の PR にまたがります**。
新しいドキュメントを作るのではなく、既存のものに紐づけるべき場合を取りこぼさないでください。

優先順位は次のとおりです:
1. **課題キーが一致する既存ドキュメントがあれば、それを docId に指定する。** リポジトリが違っても同じ機能です。
   例: 既存ドキュメントが「課題キー: PROJ-123 / リポジトリ: acme/backend」で、今回の PR が acme/frontend の
   PROJ-123 なら、新規作成ではなく既存の docId に紐づける。
2. 課題キーがない場合は、タイトル・要約から意味的に同じ機能を指しているものを探す。
   「投稿の公開範囲」と「公開範囲設定UI」のような表記揺れは同じ機能として扱う。
3. どちらにも該当しなければ newDocId を付けて新規作成する。

判断に迷うときは affectsSpec: true に倒してよい。ただし明確に内部的な変更を true にはしないこと。
targets は多くても3件まで。1つの PR が4つ以上の機能に跨るなら、それは分割すべき PR なので最も中心的なものだけ挙げる。

ファイルを読む必要はありません。与えられた情報だけで判断してください。
出力は以下の形の JSON をひとつだけ、\`\`\`json フェンス付きコードブロックで返すこと。解説文は不要です。

\`\`\`json
{
  "affectsSpec": true,
  "reason": "...",
  "issueKeys": ["PROJ-123"],
  "targets": [
    { "docId": null, "newDocId": "example-feature", "title": "機能名", "why": "..." }
  ]
}
\`\`\``;

export interface ClassifyOptions {
  model?: string;
  onProgress?: (line: string) => void;
}

export async function classifyPullRequest(
  pr: PullRequestInput,
  docIndex: FeatureDocIndexEntry[],
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const indexText =
    docIndex.length === 0
      ? "(まだ機能ドキュメントは1件もありません)"
      : docIndex
          .map((d) => {
            const repos = d.repos.length > 0 ? ` / リポジトリ: ${d.repos.join(", ")}` : "";
            const keys = d.issueKeys.length > 0 ? ` / 課題キー: ${d.issueKeys.join(", ")}` : "";
            return `- ${d.id}: ${d.title} — ${d.summary}${repos}${keys}`;
          })
          .join("\n");

  const fileList = pr.changedFiles
    .map((f) => `${f.status}\t${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  const prompt = [
    `## 既存の機能ドキュメント一覧`,
    indexText,
    "",
    `## PR`,
    `リポジトリ: ${pr.repo}`,
    `番号: #${pr.number}`,
    `タイトル: ${pr.title}`,
    `ブランチ: ${pr.branch}`,
    `本文:`,
    pr.body || "(なし)",
    "",
    `## 変更ファイル (${pr.changedFiles.length}件)`,
    fileList,
  ].join("\n");

  const text = await runAgent({
    systemPrompt: SYSTEM,
    prompt,
    model: options.model ?? process.env.SPEC_BRIDGE_CLASSIFY_MODEL,
    // 分類はファイルを読む必要がないので、読み取り系も含めて全面的に禁止する
    allowedTools: [],
    disallowedTools: [...READ_ONLY_DENY_LIST, "Bash", "Read", "Grep", "Glob"],
    maxTurns: 2,
    onProgress: options.onProgress,
  });

  const parsed = ClassifyResult.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error(`分類結果がスキーマに合致しません:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
