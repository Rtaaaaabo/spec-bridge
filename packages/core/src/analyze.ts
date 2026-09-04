import { z } from "zod";
import { extractJson, runAgent, runAgentDetailed, READ_ONLY_DENY_LIST } from "./agent.ts";
import { computeConfidence, pruneInvalidSources, type ConfidenceBreakdown } from "./confidence.ts";
import { FeatureDocBody, type FeatureDoc, type PullRequestInput } from "./types.ts";

export const AnalyzeOutput = z.object({
  changeSummary: z
    .string()
    .describe("この解析がこの機能に対して何を明らかにしたか。変更履歴に1行で載る"),
  confidence: z.number().min(0).max(1),
  body: FeatureDocBody,
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutput>;

/**
 * 何を根拠に解析するか。
 *
 * - `pull-request`: PR の差分を起点にする（既定の経路）
 * - `codebase`: 差分を持たず、いまのコードだけを読む（バックフィル）
 *
 * 確度の測り方がここで分かれる。PR があるときは「変更ファイルを読んだか」を測れるが、
 * バックフィルにはそれが無い。`subjectChangedFiles` が `null` を返すのはそのため。
 */
export type AnalysisSubject =
  | { kind: "pull-request"; pr: PullRequestInput }
  | { kind: "codebase"; repo: string; entryPoints: string[] };

export function subjectRepo(subject: AnalysisSubject): string {
  return subject.kind === "pull-request" ? subject.pr.repo : subject.repo;
}

/**
 * 確度算出に渡す変更ファイル。
 * PR が無い解析では `null` を返す。空配列を返すと読了率が満点になってしまう。
 */
function subjectChangedFiles(subject: AnalysisSubject): string[] | null {
  return subject.kind === "pull-request"
    ? subject.pr.changedFiles.map((f) => f.filename)
    : null;
}

export interface AnalyzeResult {
  output: AnalyzeOutput;
  /** 機械的に算出した確度の内訳 */
  confidence: ConfidenceBreakdown;
  /** 実在しない出典を落とした件数など */
  warnings: string[];
}

/**
 * システムプロンプト。「進め方」だけが PR 解析とバックフィルで変わる。
 *
 * プレースホルダの文字列置換にすると、名前がずれたときに置換が静かに空振りして
 * 未置換のまま出荷される。関数にしておけば型で防げる。
 */
const buildSystem = (procedure: string): string =>
  `あなたは開発チームのソースコードを読み、CS チームと QA チームが使う「機能仕様ドキュメント」を保守するエージェントです。

# 読み手
- **CS / サポート**: エンジニアではない。顧客からの問い合わせに答えるために読む。「バグか仕様か」を判断したい。
- **QA**: どの画面をどうテストすればいいか、この変更でどこが壊れうるかを知りたい。

# 絶対に守るルール
1. **出典のない断定を書かない。** \`rules\` の各項目には、実際に読んだファイルパス（と可能なら行番号）を \`sources\` に必ず入れる。推測で書いてよい場所はない。
2. **わからないことは \`openQuestions\` に書く。** コードから読み取れない仕様（意図、外部システムの挙動、運用ルール）を推測で埋めない。「わかりません、開発に確認してください」と言えることがこのドキュメントの価値。
3. **既存の記述を消さない。** 与えられた既存ドキュメントのうち、この PR が触っていない部分はそのまま維持する。あなたの仕事は差分の反映であって書き直しではない。
4. **専門用語を避ける。** \`overview\` と \`userBehavior\` は、コードを読まない人がそのまま顧客に説明できる言葉で書く。実装の詳細は \`rules\` に置く。

${procedure}

# 出力形式（厳守）
最後のメッセージに、以下の形の JSON をひとつだけ含めること:
\`\`\`json
{ "changeSummary": "...", "confidence": 0.0〜1.0, "body": { ... } }
\`\`\`

- \`body\` はプロンプトで与えられる JSON Schema に完全に一致させること。**キー名を勝手に変えない**（例: \`rules\` の各要素は必ず \`text\` と \`sources\`）。
- \`sources\` の各要素は**文字列ではなくオブジェクト**: \`{ "repo": "org/repo", "file": "path/to/file.rb", "line": 42, "pr": "org/repo#1" }\`
- 配列のフィールドには必ず配列を入れる。要素が1つでも配列にする。
- 該当するものがないフィールドは空配列 \`[]\` または空文字 \`""\` にする。キーごと省略してもよいが、キー名を別のものに置き換えてはいけない。
- \`confidence\` はドキュメントの確からしさ。コードを十分に読めて曖昧さが少なければ高く、推測が混ざるなら低くする。`;

/** PR の差分を起点に更新するときの進め方 */
const PR_PROCEDURE = `# 進め方
1. まず変更されたファイルを Read で読む。差分だけでは仕様はわからないので、周辺のコード（呼び出し元、型定義、バリデーション、ルーティング、権限チェック）も辿る。
2. 画面を扱う変更なら、ルーティング定義を Glob / Grep で探して \`screens\` を埋める。API なら同様に \`endpoints\` を埋める。
3. 権限・ロールのチェックがあれば必ず \`permissions\` に反映する。問い合わせで最も多いのがここ。
4. \`testPoints.regression\` には、この変更が壊しうる**既存**機能の観点を書く。新機能のテストより回帰範囲のほうが QA には価値がある。
5. 最後に、与えられた JSON Schema に**厳密に**従った JSON を \`\`\`json フェンス付きコードブロックひとつで出力する。それ以外の解説文は不要。`;

/**
 * 差分を持たず、いまのコードだけから初版を書き起こすときの進め方（バックフィル）。
 *
 * PR と違って「どこを見ればいいか」の手がかりが差分に無い。読む範囲を自分で決める必要があるぶん、
 * 手を抜いて浅い記述を量産しやすいので、**出典を必ず自分の目で開いてから書く**ことを強く指示する。
 */
const BACKFILL_PROCEDURE = `# 進め方
1. 与えられた起点ファイルを Read で読む。そこから呼び出し先・型定義・バリデーション・ルーティング・権限チェックを辿り、この機能の範囲を掴む。
2. 画面ならルーティング定義を Glob / Grep で探して \`screens\` を、API なら \`endpoints\` を埋める。
3. 権限・ロールのチェックがあれば必ず \`permissions\` に反映する。問い合わせで最も多いのがここ。
4. \`testPoints.regression\` には、この機能に手を入れると壊れうる範囲を書く。
5. 最後に、与えられた JSON Schema に**厳密に**従った JSON を \`\`\`json フェンス付きコードブロックひとつで出力する。それ以外の解説文は不要。

# この解析で特に注意すること
- **差分が無い。** 「何が変わったか」ではなく「いまどうなっているか」を書く。
- **出典に挙げるファイルは、必ず Read で開いてから挙げる。** 開かずに書いた出典は機械検証で落ちる。
  ファイル名から中身を推測して出典にしてはいけない。
- **この機能に関係しないことは書かない。** リポジトリ全体の説明ではなく、与えられた機能ひとつのドキュメントを作る。
- \`changeSummary\` には「この初版で何を記録したか」を1行で書く。`;

const REPAIR_SYSTEM = `あなたは JSON を修正する担当です。
与えられた JSON を、与えられた JSON Schema に厳密に合致するように修正してください。

- 内容（記述されている事実）は一切変更しないこと。キー名・構造・型だけを直す。
- 情報を勝手に削らない。キー名が違うだけなら正しいキーに移し替える。
- 修正した JSON 全体を \`\`\`json フェンス付きコードブロックひとつで出力する。解説文は不要。`;

export interface AnalyzeOptions {
  /** 解析対象リポジトリのローカルチェックアウト */
  repoPath: string;
  model?: string;
  maxTurns?: number;
  /** true にすると Bash を許可し、git log / git show を辿れるようになる */
  allowBash?: boolean;
  onProgress?: (line: string) => void;
}

/** LLM に渡す body の JSON Schema。zod 定義から生成するので、型定義とズレようがない */
const BODY_JSON_SCHEMA = JSON.stringify(
  z.toJSONSchema(FeatureDocBody, { io: "input" }),
  null,
  2,
);

function buildPrompt(
  subject: AnalysisSubject,
  existing: FeatureDoc | null,
  target: { id: string; title: string; why: string },
): string {
  const repo = subjectRepo(subject);

  const existingBlock = existing
    ? `既存の機能ドキュメント（この内容を土台に更新すること）:\n\`\`\`json\n${JSON.stringify(existing.body, null, 2)}\n\`\`\``
    : "この機能のドキュメントはまだ存在しません。新規に作成してください。";

  const head =
    subject.kind === "pull-request"
      ? [
          `# タスク`,
          `機能「${target.title}」(id: ${target.id}) のドキュメントを、以下の PR の内容を反映して更新してください。`,
          `この PR がこの機能に関係する理由: ${target.why}`,
        ]
      : [
          `# タスク`,
          `機能「${target.title}」(id: ${target.id}) のドキュメントを、いまのコードから書き起こしてください。`,
          `この機能を独立したドキュメントにする理由: ${target.why}`,
        ];

  const detail =
    subject.kind === "pull-request"
      ? buildPullRequestDetail(subject.pr)
      : buildCodebaseDetail(subject.entryPoints);

  return [
    ...head,
    "",
    `# 対象リポジトリ`,
    `${repo}（このリポジトリのチェックアウトが作業ディレクトリにあります。自由に読んでください）`,
    "",
    existingBlock,
    "",
    ...detail,
    "",
    `# body の JSON Schema（厳密に従うこと）`,
    "```json",
    BODY_JSON_SCHEMA,
    "```",
  ].join("\n");
}

function buildPullRequestDetail(pr: PullRequestInput): string[] {
  const diff = pr.changedFiles
    .map((f) => {
      const header = `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
      return f.patch ? `${header}\n${f.patch}` : `${header}\n(差分省略: バイナリまたは巨大な変更)`;
    })
    .join("\n\n");

  return [
    `# PR`,
    `#${pr.number} ${pr.title}`,
    `作成者: ${pr.author} / ブランチ: ${pr.branch}`,
    "",
    pr.body || "(本文なし)",
    "",
    `# 差分`,
    "```diff",
    diff.slice(0, 180_000),
    "```",
  ];
}

function buildCodebaseDetail(entryPoints: string[]): string[] {
  return [
    `# 起点になるファイル`,
    entryPoints.length > 0
      ? entryPoints.map((f) => `- ${f}`).join("\n")
      : "(指定なし。Glob / Grep でこの機能の実装を探してください)",
    "",
    `これは調査の入口であって、範囲ではありません。ここから辿れるコードは読んでください。`,
    `逆に、ここに挙がっていても実際に読んでいないファイルを出典にしてはいけません。`,
  ];
}

/**
 * Claude Agent SDK でリポジトリを実際に探索させ、機能ドキュメントの新しい本文を生成する。
 * 差分だけを LLM に渡す素朴な RAG より、エージェントに周辺コードを辿らせたほうが精度が段違いに高い。
 */
export async function analyzeFeature(
  subject: AnalysisSubject,
  existing: FeatureDoc | null,
  target: { id: string; title: string; why: string },
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const tools = ["Read", "Grep", "Glob"];
  if (options.allowBash) tools.push("Bash");

  // 書き込み・ネットワーク系は常に禁止。Bash は明示的に許可されたときだけ通す。
  const disallowedTools = [
    ...READ_ONLY_DENY_LIST,
    ...(options.allowBash ? [] : ["Bash"]),
  ];

  const model = options.model ?? process.env.SPEC_BRIDGE_ANALYZE_MODEL;

  const procedure =
    subject.kind === "pull-request" ? PR_PROCEDURE : BACKFILL_PROCEDURE;

  const run = await runAgentDetailed({
    systemPrompt: buildSystem(procedure),
    prompt: buildPrompt(subject, existing, target),
    cwd: options.repoPath,
    model,
    allowedTools: tools,
    disallowedTools,
    maxTurns: options.maxTurns ?? 60,
    onProgress: options.onProgress,
  });
  const resultText = run.text;

  const first = tryParse(resultText);
  if (first.ok) return finalize(first.value, subject, options, run.filesRead);

  // 調査には多くのツール呼び出しを費やしている。形式が違うだけで捨てるのは損なので、
  // 内容を保ったまま構造だけ直させる往復を1回だけ挟む。
  options.onProgress?.(`  ↻ 出力形式が不正だったため修正を依頼中…`);

  const repaired = await runAgent({
    systemPrompt: REPAIR_SYSTEM,
    prompt: [
      `# 修正対象の JSON`,
      "```json",
      resultText.slice(0, 200_000),
      "```",
      "",
      `# 検証エラー`,
      first.errors,
      "",
      `# 従うべき JSON Schema（\`body\` の中身）`,
      "```json",
      BODY_JSON_SCHEMA,
      "```",
      "",
      `全体は { "changeSummary": string, "confidence": number, "body": <上記スキーマ> } の形にすること。`,
    ].join("\n"),
    model,
    allowedTools: [],
    disallowedTools,
    maxTurns: 2,
  });

  const second = tryParse(repaired);
  if (second.ok) return finalize(second.value, subject, options, run.filesRead);

  const dumpPath = await dumpFailure(target.id, resultText, repaired);
  throw new Error(
    `解析結果がスキーマに合致しませんでした（修正の再試行も失敗）。\n` +
      `エージェントの生出力: ${dumpPath}\n\n` +
      truncateErrors(second.errors),
  );
}

/**
 * 解析結果を確定させる。
 *
 * ここで (1) 実在しない出典を除去し (2) 確度を機械的に算出し直す。
 * モデルの自己申告する confidence は当てにならないので採用しない。
 */
function finalize(
  output: AnalyzeOutput,
  subject: AnalysisSubject,
  options: AnalyzeOptions,
  filesRead: string[],
): AnalyzeResult {
  const warnings: string[] = [];
  const repo = subjectRepo(subject);

  const pruned = pruneInvalidSources(output.body, options.repoPath, repo);
  if (pruned.droppedSources > 0) {
    warnings.push(
      `実在しないファイルを指す出典 ${pruned.droppedSources} 件を除去しました。`,
    );
  }
  for (const text of pruned.droppedRules) {
    warnings.push(`出典がすべて無効だったため除外: "${text.slice(0, 80)}"`);
  }

  const confidence = computeConfidence({
    body: pruned.body,
    repoPath: options.repoPath,
    currentRepo: repo,
    // PR が無い解析では null。空配列を渡すと読了率が満点になる
    changedFiles: subjectChangedFiles(subject),
    filesRead,
    selfReported: output.confidence,
  });

  return {
    output: { ...output, body: pruned.body, confidence: confidence.score },
    confidence,
    warnings,
  };
}

type ParseAttempt =
  | { ok: true; value: AnalyzeOutput }
  | { ok: false; errors: string };

function tryParse(text: string): ParseAttempt {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (error) {
    return {
      ok: false,
      errors: `JSON として読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = AnalyzeOutput.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: z.prettifyError(parsed.error) };
}

/** CLI に数百行のエラーを吐かせない */
function truncateErrors(errors: string, maxLines = 20): string {
  const lines = errors.split("\n");
  if (lines.length <= maxLines) return errors;
  return [...lines.slice(0, maxLines), `… ほか ${lines.length - maxLines} 行`].join("\n");
}

async function dumpFailure(id: string, first: string, second: string): Promise<string> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "spec-bridge-"));
  const path = join(dir, `${id}.txt`);
  await writeFile(
    path,
    ["=== 1回目の出力 ===", first, "", "=== 修正後の出力 ===", second].join("\n"),
    "utf8",
  );
  return path;
}
