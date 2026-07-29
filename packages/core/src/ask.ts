import { z } from "zod";
import { extractJson, runAgent, READ_ONLY_DENY_LIST } from "./agent.ts";
import { renderMarkdown } from "./markdown.ts";
import { DocStore } from "./store.ts";
import type { FeatureDoc } from "./types.ts";

export const Citation = z.object({
  docId: z.string(),
  docTitle: z.string().default(""),
  quote: z.string().describe("ドキュメントからの該当箇所の引用"),
  file: z.string().default("").describe("該当するソースファイル（出典欄にあれば）"),
});
export type Citation = z.infer<typeof Citation>;

export const Verdict = z.enum(["spec", "bug", "unknown"]);
export type Verdict = z.infer<typeof Verdict>;

export const AskAnswer = z.object({
  verdict: Verdict.describe(
    "spec=仕様どおり / bug=仕様と異なる挙動の可能性 / unknown=ドキュメントからは判断できない",
  ),
  confidence: z.number().min(0).max(1),
  headline: z.string().describe("結論を1文で"),
  answerForCustomer: z
    .string()
    .default("")
    .describe("顧客にそのまま返せる文面。敬語・専門用語なし。unknown のときは空"),
  explanation: z.string().describe("CS 向けの内部説明。なぜその判断になるか"),
  citations: z.array(Citation).default([]),
  devRequest: z
    .object({
      title: z.string(),
      body: z.string().describe("再現手順・期待/実際・関連コードを含む起票用の本文"),
    })
    .nullable()
    .default(null)
    .describe("bug のときだけ。開発チームへの依頼文"),
  followUp: z
    .array(z.string())
    .default([])
    .describe("開発チームに確認すべきこと"),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

const SYSTEM = `あなたはカスタマーサポート（CX）チームの一次請け担当です。
社内の機能仕様ドキュメントだけを根拠に、顧客からの問い合わせに答えます。

# 最重要のルール
1. **仕様ドキュメントに書かれていないことは答えない。** あなたの一般的な知識や推測で埋めてはいけない。
   ドキュメントに根拠がなければ verdict を "unknown" にして、正直に「このドキュメントからは判断できない」と言う。
   間違った回答が顧客に伝わることが、このシステムで最も避けたい事故です。
2. **すべての判断に出典を付ける。** citations には、根拠にしたドキュメントの該当箇所を引用する。
   citations が空になる回答は "unknown" 以外にしてはいけない。
3. **verdict の判断基準**
   - "spec": 顧客が報告している挙動が、ドキュメントに書かれた仕様どおりである
   - "bug": ドキュメントに書かれた仕様と、顧客が報告している挙動が食い違っている
   - "unknown": ドキュメントに該当する記述がない、または情報が足りず判断できない
4. **answerForCustomer は顧客にそのまま送れる文面にする。** 敬語で、コードの識別子（\`CUSTOM\` や関数名など）や
   ファイルパスは出さない。ドキュメントの「用語」表に別の呼ばれ方があれば、顧客が使っている言葉に合わせる。
   verdict が "unknown" のときは answerForCustomer を空文字にする（回答してはいけないため）。
5. **explanation は CS 向けの内部メモ。** なぜその判断になるのか、どこに書いてあるのかを簡潔に。
6. **verdict が "bug" のときは devRequest を必ず埋める。** 開発チームがそのまま起票できる粒度で、
   「何が起きているか」「ドキュメント上の期待挙動」「関連しそうなファイル」を書く。
7. ドキュメントの「開発者への確認事項」に関係する内容が問い合わせに含まれていたら、followUp に入れる。
   ステータスが draft（AI生成・未レビュー）のドキュメントを根拠にした場合も、その旨を followUp に入れる。

# 出力
以下の JSON をひとつだけ \`\`\`json フェンス付きコードブロックで返すこと。解説文は不要。

\`\`\`json
{
  "verdict": "spec" | "bug" | "unknown",
  "confidence": 0.0〜1.0,
  "headline": "結論を1文で",
  "answerForCustomer": "顧客にそのまま返せる文面（unknown なら空文字）",
  "explanation": "CS 向けの内部説明",
  "citations": [{ "docId": "...", "docTitle": "...", "quote": "ドキュメントからの引用", "file": "path/to/file.ts" }],
  "devRequest": null または { "title": "...", "body": "..." },
  "followUp": ["開発に確認すべきこと"]
}
\`\`\``;

function docContext(docs: FeatureDoc[]): string {
  return docs
    .map((doc) => {
      const status = {
        draft: "AI生成・未レビュー",
        verified: "人間レビュー済",
        stale: "古い可能性あり",
      }[doc.meta.status];
      return [
        `=== 機能ドキュメント: ${doc.meta.id} ===`,
        `ステータス: ${status} / 最終更新: ${doc.meta.updatedAt} / 確度: ${doc.meta.confidence}`,
        "",
        renderMarkdown(doc),
      ].join("\n");
    })
    .join("\n\n");
}

export interface AskOptions {
  docsPath: string;
  model?: string;
}

export async function askSupportQuestion(
  question: string,
  options: AskOptions,
): Promise<{ answer: AskAnswer; docCount: number }> {
  const docs = await new DocStore(options.docsPath).list();

  if (docs.length === 0) {
    return {
      answer: {
        verdict: "unknown",
        confidence: 0,
        headline: "参照できる機能ドキュメントがありません。",
        answerForCustomer: "",
        explanation:
          "指定されたディレクトリに機能ドキュメントが1件も見つかりませんでした。先に spec-bridge の解析を実行してください。",
        citations: [],
        devRequest: null,
        followUp: [],
      },
      docCount: 0,
    };
  }

  const text = await runAgent({
    systemPrompt: SYSTEM,
    prompt: [
      `# 参照できる機能仕様ドキュメント`,
      docContext(docs),
      "",
      `# 問い合わせ内容`,
      question,
    ].join("\n"),
    model: options.model ?? process.env.SPEC_BRIDGE_ASK_MODEL,
    allowedTools: [],
    // 与えられたドキュメントだけで答えさせる。ファイルもネットワークも触らせない。
    disallowedTools: [...READ_ONLY_DENY_LIST, "Bash", "Read", "Grep", "Glob"],
    maxTurns: 2,
  });

  const parsed = AskAnswer.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error(`回答がスキーマに合致しません:\n${z.prettifyError(parsed.error)}`);
  }

  // 出典なしで断定させない。ここは UI 側の実装に依存させたくないので、ロジック側で強制する。
  const answer = parsed.data;
  if (answer.citations.length === 0 && answer.verdict !== "unknown") {
    return {
      answer: {
        ...answer,
        verdict: "unknown",
        answerForCustomer: "",
        explanation:
          `${answer.explanation}\n\n` +
          `（※ 出典を示せない回答だったため、システム側で「判断できない」に変更しました。開発チームに確認してください）`,
        confidence: 0,
      },
      docCount: docs.length,
    };
  }

  return { answer, docCount: docs.length };
}
