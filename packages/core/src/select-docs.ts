import { z } from "zod";
import { extractJson, runAgent } from "./agent.ts";
import type { FeatureDoc } from "./types.ts";

/**
 * 絞り込みをせずに全文をプロンプトへ入れる上限。
 *
 * これ以下ならそのまま渡す。1往復増やすコストと遅延のほうが大きいため、
 * 小規模な導入では今までどおりの挙動になる。
 */
export const SELECTION_THRESHOLD = 5;

/** 絞り込み後に全文を読み込む最大件数 */
export const MAX_SELECTED_DOCS = 5;

const SelectionOutput = z.object({
  docIds: z.array(z.string()).default([]),
  reason: z.string().default(""),
});

const SYSTEM = `あなたは社内の機能仕様ドキュメントの索引係です。
CS からの問い合わせ内容を読み、**どのドキュメントを開けば答えられるか**だけを判断します。

- 回答は作りません。関係するドキュメントの id を選ぶだけです
- 顧客は社内用語を使いません。「公開設定」「非公開」のような言い換えから、
  対応する機能を推測してください。用語表の別名が手がかりになります
- 関係しそうなものが複数あれば、可能性の高い順に最大5件まで挙げてください
- **どれも関係しないと判断したら空配列を返してください。** 無理に選ばないこと。
  ここで誤って選ぶと、無関係なドキュメントを根拠に回答が作られます

出力は次の JSON のみ:
{
  "docIds": ["feature-id", ...],
  "reason": "なぜそれを選んだかの短い説明"
}`;

function indexText(docs: FeatureDoc[]): string {
  return docs
    .map((doc) => {
      const b = doc.body;
      const aliases = b.glossary
        .flatMap((g) => [g.term, ...g.aliases])
        .filter(Boolean)
        .join(" / ");
      const lines = [`- id: ${doc.meta.id}`, `  タイトル: ${b.title}`, `  概要: ${b.summary}`];
      if (aliases) lines.push(`  関連する言葉: ${aliases}`);
      if (b.screens.length > 0) {
        lines.push(`  画面: ${b.screens.map((s) => s.name).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export interface SelectionResult {
  docs: FeatureDoc[];
  /** 絞り込みを実行したか（件数が少なければ省略される） */
  narrowed: boolean;
  reason: string;
}

/**
 * 問い合わせに関係するドキュメントだけを選ぶ。
 *
 * 全ドキュメントの全文をプロンプトに入れる方式は、件数が増えると破綻する。
 * 索引（id・タイトル・要約・用語の別名）だけを見せて候補を絞り、
 * 選ばれたものだけ全文を読み込む。
 *
 * 索引だけを見て対象を特定するやり方は `classify.ts` と同じ形で、実績がある。
 */
export async function selectRelevantDocs(
  question: string,
  docs: FeatureDoc[],
  options: { model?: string; limit?: number } = {},
): Promise<SelectionResult> {
  const limit = options.limit ?? MAX_SELECTED_DOCS;

  if (docs.length <= SELECTION_THRESHOLD) {
    return { docs, narrowed: false, reason: "件数が少ないため全件を参照しました" };
  }

  const text = await runAgent({
    systemPrompt: SYSTEM,
    prompt: [
      "## 機能ドキュメントの索引",
      indexText(docs),
      "",
      "## 問い合わせ内容",
      question,
    ].join("\n"),
    model: options.model ?? process.env.SPEC_BRIDGE_SELECT_MODEL ?? "claude-sonnet-5",
    allowedTools: [],
    maxTurns: 2,
  });

  return resolveSelection(text, docs, limit);
}

/**
 * 絞り込みエージェントの出力を、実際のドキュメント一覧へ解決する。
 *
 * ここが本体から切り離してあるのは、**この製品で最も怖い失敗**——
 * 関係のないドキュメントを根拠に回答してしまうこと——がここで起きるため。
 * LLM を呼ばずに検証できるようにしてある。
 */
export function resolveSelection(
  rawText: string,
  docs: FeatureDoc[],
  limit: number = MAX_SELECTED_DOCS,
): SelectionResult {
  let parsed: z.infer<typeof SelectionOutput>;
  try {
    parsed = SelectionOutput.parse(extractJson(rawText));
  } catch {
    // 絞り込みに失敗したら全件にフォールバックする。
    // 回答できなくなるより、コストを払ってでも答えられるほうがよい。
    return { docs, narrowed: false, reason: "絞り込みに失敗したため全件を参照しました" };
  }

  const byId = new Map(docs.map((d) => [d.meta.id, d]));
  const seen = new Set<string>();
  const selected = parsed.docIds
    .filter((id) => {
      // 存在しない id と重複を落とす。ハルシネーションした id で全件に戻さない
      if (!byId.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => byId.get(id) as FeatureDoc)
    .slice(0, limit);

  return { docs: selected, narrowed: true, reason: parsed.reason };
}
