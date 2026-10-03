import { z } from "zod";
import { extractJson, runAgent, NO_TOOLS_DENY_LIST } from "./agent.ts";
import { renderMarkdown } from "./markdown.ts";
import { selectRelevantDocs } from "./select-docs.ts";
import { DocStore } from "./store.ts";
import type { FeatureDoc } from "./types.ts";

export const Citation = z.object({
  docId: z.string(),
  docTitle: z.string().default(""),
  quote: z.string().describe("ドキュメントからの該当箇所の引用"),
  file: z.string().default("").describe("該当するソースファイル（出典欄にあれば）"),
});
export type Citation = z.infer<typeof Citation>;

/**
 * 答えにどこまで根拠があるか。
 *
 * - `answered`: 質問に、ドキュメントの記述だけで答えられた
 * - `partial`: 一部だけ答えられた。分からなかったところは `unknowns` に出す
 * - `unknown`: ドキュメントからは答えられない。**答えを作らない**
 */
export const Grounding = z.enum(["answered", "partial", "unknown"]);
export type Grounding = z.infer<typeof Grounding>;

/**
 * 質問が「こう動いているが、これは正しいか」という挙動の報告だったときだけ付ける判定。
 * 「この機能はどう動く？」のような説明を求める質問には付けない（null）。
 */
export const Verdict = z.enum(["spec", "bug"]);
export type Verdict = z.infer<typeof Verdict>;

export const AskAnswer = z.object({
  grounding: Grounding,
  verdict: Verdict.nullable()
    .default(null)
    .describe("挙動の報告のときだけ。spec=仕様どおり / bug=仕様と食い違う。それ以外は null"),
  confidence: z.number().min(0).max(1),
  headline: z.string().describe("結論を1文で"),
  answer: z
    .string()
    .default("")
    .describe("質問への答え。コードを書いていない人が読んで分かる言葉で。grounding が unknown なら空"),
  citations: z.array(Citation).default([]),
  unknowns: z
    .array(z.string())
    .default([])
    .describe("ドキュメントからは分からなかったこと。コードを書いた人に確かめる候補"),
  devRequest: z
    .object({
      title: z.string(),
      body: z.string().describe("再現手順・期待/実際・関連コードを含む起票用の本文"),
    })
    .nullable()
    .default(null)
    .describe("verdict が bug のときだけ。開発チームへの依頼文"),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

const SYSTEM = `あなたは、あるプロダクトの機能仕様ドキュメントを読んで質問に答える担当です。
質問するのは**このコードを書いていない人**です（引き継いだ人、外から入って調べている人、サポートや QA の人など）。
機能仕様ドキュメントだけを根拠に答えます。

# 最重要のルール
1. **ドキュメントに書かれていないことは答えない。** 一般的な知識や推測で埋めてはいけない。
   - ドキュメントで答えられる → grounding を "answered"
   - 一部だけ答えられる → "partial"。答えられた部分だけを answer に書き、分からなかったことを unknowns に挙げる
   - 答えられない → "unknown"。answer は空文字にして、何が分からないかを unknowns に挙げる
   根拠のない答えが、そのまま他の人に伝わることが、このシステムで最も避けたい事故です。
2. **すべての答えに出典を付ける。** citations には、根拠にしたドキュメントの該当箇所を引用する。
   citations が空なら grounding は "unknown" にする。
3. **answer は、コードを書いていない人が読んで分かる言葉で書く。** 結論を先に書き、
   コードの識別子やファイルパスは必要なときだけ添える（出典は citations に入れる）。
   ドキュメントの「用語」表に別の呼ばれ方があれば、質問者が使っている言葉に合わせる。
4. **コードから分からない事実を書かない。** 利用状況・問い合わせの多さ・今後の予定・誰が決めたかなどは、
   ドキュメントに書いてあっても推測を足さず、書いてある範囲だけを答える。
5. **verdict は、質問が挙動の報告のときだけ付ける。**
   「〜したら〜になった。これは正しい？」のように、起きた挙動が仕様どおりかを問われたときに
   - "spec": ドキュメントに書かれた仕様どおり
   - "bug": ドキュメントに書かれた仕様と食い違っている
   「〜はどう動く？」「〜できる？」のような説明を求める質問では null にする。
6. **verdict が "bug" のときは devRequest を必ず埋める。** 開発チームがそのまま起票できる粒度で、
   「何が起きているか」「ドキュメント上の期待挙動」「関連しそうなファイル」を書く。
7. 質問に関係する「開発者への確認事項」がドキュメントにあれば、それも unknowns に入れる。

# 出力
以下の JSON をひとつだけ \`\`\`json フェンス付きコードブロックで返すこと。解説文は不要。

\`\`\`json
{
  "grounding": "answered" | "partial" | "unknown",
  "verdict": null | "spec" | "bug",
  "confidence": 0.0〜1.0,
  "headline": "結論を1文で",
  "answer": "質問への答え（unknown なら空文字）",
  "citations": [{ "docId": "...", "docTitle": "...", "quote": "ドキュメントからの引用", "file": "path/to/file.ts" }],
  "unknowns": ["ドキュメントからは分からなかったこと"],
  "devRequest": null または { "title": "...", "body": "..." }
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
  /**
   * 読み込み済みの機能ドキュメント。画面は GitHub の docs リポジトリから読んで渡す。
   * 省略時は `docsPath` のディレクトリから読む（CLI とローカル開発）
   */
  docs?: FeatureDoc[];
  docsPath?: string;
  model?: string;
  /** 絞り込みに使うモデル。省略時は軽量モデル */
  selectModel?: string;
}

/** 答えの根拠にした機能のうち、人がまだ確かめていないもの */
export interface UnreviewedSource {
  docId: string;
  title: string;
  status: FeatureDoc["meta"]["status"];
}

export interface AskResult {
  answer: AskAnswer;
  /**
   * 根拠にした機能のうち、未レビュー（AI生成のまま・要更新）のもの。
   * **LLM に書かせず、出典とドキュメントの状態から機械的に出す**（言い忘れが起きないように）
   */
  unreviewed: UnreviewedSource[];
  /** 参照できたドキュメントの総数 */
  docCount: number;
  /** 実際に全文を読み込んだ件数 */
  consultedCount: number;
  /** 絞り込みを実行したか */
  narrowed: boolean;
}

async function loadFromPath(docsPath: string | undefined): Promise<FeatureDoc[]> {
  if (!docsPath) throw new Error("機能ドキュメントの置き場所（docs か docsPath）が指定されていません");
  return new DocStore(docsPath).list();
}

function noAnswer(headline: string, unknowns: string[]): AskAnswer {
  return {
    grounding: "unknown",
    verdict: null,
    confidence: 0,
    headline,
    answer: "",
    citations: [],
    unknowns,
    devRequest: null,
  };
}

/**
 * LLM の答えを、**システム側の約束**に合わせる。プロンプトに頼らず、ここで強制する。
 *
 * - 出典が無いのに答えていたら、答えを捨てて `unknown` に落とす（根拠なしで断定させない）
 * - `unknown` なら答え・判定・起票文を空にする
 * - 判定が `bug` でなければ起票文は付けない
 * - 根拠にした機能のうち未レビューのものを、ドキュメントの状態から出す
 */
export function finalizeAnswer(
  answer: AskAnswer,
  docs: FeatureDoc[],
): { answer: AskAnswer; unreviewed: UnreviewedSource[] } {
  let result = answer;
  if (result.citations.length === 0 && result.grounding !== "unknown") {
    result = {
      ...result,
      grounding: "unknown",
      confidence: 0,
      unknowns: [
        ...result.unknowns,
        "出典を示せない答えだったため、システム側で「答えられない」に変更しました。コードを書いた人に確かめてください。",
      ],
    };
  }
  if (result.grounding === "unknown") {
    result = { ...result, answer: "", verdict: null, devRequest: null };
  }
  if (result.verdict !== "bug" && result.devRequest !== null) {
    result = { ...result, devRequest: null };
  }

  const byId = new Map(docs.map((doc) => [doc.meta.id, doc]));
  const cited = [...new Set(result.citations.map((c) => c.docId))];
  const unreviewed = cited
    .map((id) => byId.get(id))
    .filter((doc): doc is FeatureDoc => doc !== undefined && doc.meta.status !== "verified")
    .map((doc) => ({ docId: doc.meta.id, title: doc.body.title, status: doc.meta.status }));

  return { answer: result, unreviewed };
}

/**
 * 機能ドキュメントだけを根拠に、質問に答える。
 *
 * 読み手は**このコードを書いていない人**（引き継いだ人・外から調べる人・サポートや QA）。
 * 特定の職種向けの文面（顧客への返信など）は作らない。答えは誰が読んでも分かる言葉で1つだけ返す。
 */
export async function askQuestion(question: string, options: AskOptions): Promise<AskResult> {
  const all = options.docs ?? (await loadFromPath(options.docsPath));

  if (all.length === 0) {
    return {
      answer: noAnswer("参照できる機能ドキュメントがありません。", [
        "機能ドキュメントが1件も見つかりませんでした。先に spec-bridge で既存コードから書き起こしてください。",
      ]),
      unreviewed: [],
      docCount: 0,
      consultedCount: 0,
      narrowed: false,
    };
  }

  // 件数が増えると全文をプロンプトに入れる方式は破綻するので、先に索引で絞り込む
  const selection = await selectRelevantDocs(question, all, { model: options.selectModel });
  const docs = selection.docs;

  // 索引の段階で「関係するものがない」と判断されたら、全文を読むまでもない
  if (docs.length === 0) {
    return {
      answer: noAnswer("この質問に関係する機能ドキュメントが見つかりませんでした。", [
        `参照できる ${all.length} 件のドキュメントを確認しましたが、関係するものがありませんでした。` +
          (selection.reason ? `（${selection.reason}）` : ""),
        "この機能のドキュメントがあるか、コードを書いた人に確かめてください。",
      ]),
      unreviewed: [],
      docCount: all.length,
      consultedCount: 0,
      narrowed: selection.narrowed,
    };
  }

  const text = await runAgent({
    systemPrompt: SYSTEM,
    prompt: [`# 参照できる機能仕様ドキュメント`, docContext(docs), "", `# 質問`, question].join("\n"),
    model: options.model ?? process.env.SPEC_BRIDGE_ASK_MODEL,
    allowedTools: [],
    // 与えられたドキュメントだけで答えさせる。ファイルもネットワークも触らせない。
    disallowedTools: [...NO_TOOLS_DENY_LIST],
    maxTurns: 2,
  });

  const parsed = AskAnswer.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error(`回答がスキーマに合致しません:\n${z.prettifyError(parsed.error)}`);
  }

  // 出典なしで断定させない。ここは画面側の実装に依存させたくないので、ロジック側で強制する
  const { answer, unreviewed } = finalizeAnswer(parsed.data, docs);
  return {
    answer,
    unreviewed,
    docCount: all.length,
    consultedCount: docs.length,
    narrowed: selection.narrowed,
  };
}
