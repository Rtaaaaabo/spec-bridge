import { z } from "zod";

/**
 * LLM は出典を `"app/models/post.rb:42"` のような文字列で返しがちなので、
 * オブジェクトに正規化してから検証する。repo が空なら後段で PR のリポジトリを補う。
 */
function coerceSourceRef(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const withLine = value.match(/^(.*?):(\d+)(?:-\d+)?$/);
  return {
    repo: "",
    file: withLine?.[1] ?? value,
    line: withLine?.[2] ? Number(withLine[2]) : null,
    pr: null,
  };
}

/** 文字列で返ってきた配列項目を配列へ正規化する（箇条書き1本の文字列など） */
function coerceStringArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

const stringArray = z.preprocess(coerceStringArray, z.array(z.string()).default([]));

/**
 * 出典。ドキュメント中のあらゆる断定にはこれが必須。
 * 出典を出せない記述はドキュメントに載せない、というのがこのサービスの生命線。
 */
export const SourceRef = z.preprocess(
  coerceSourceRef,
  z.object({
    repo: z.string().default("").describe("org/repo。単一リポジトリなら省略可"),
    file: z.string().describe("リポジトリルートからの相対パス"),
    line: z.number().int().positive().nullable().default(null),
    pr: z.string().nullable().default(null).describe("org/repo#123"),
  }),
);
export type SourceRef = z.infer<typeof SourceRef>;

export const Screen = z.object({
  name: z.string(),
  path: z.string().describe("ルーティングパス。例: /settings/billing"),
  repo: z.string().default("").describe("org/repo。単一リポジトリなら省略可"),
  file: z.string().nullable().default(null),
  description: z.string().default(""),
});
export type Screen = z.infer<typeof Screen>;

export const Endpoint = z.object({
  method: z.string().describe("GET / POST など"),
  path: z.string(),
  repo: z.string().default("").describe("org/repo。単一リポジトリなら省略可"),
  file: z.string().nullable().default(null),
  description: z.string().default(""),
});
export type Endpoint = z.infer<typeof Endpoint>;

export const PermissionRow = z.object({
  role: z.string(),
  canDo: z.string().describe("そのロールができること"),
  sources: z.array(SourceRef).default([]),
});
export type PermissionRow = z.infer<typeof PermissionRow>;

/** 仕様の一項目。sources が空のものは書き出し前に落とす。 */
export const SpecRule = z.object({
  text: z.string(),
  sources: z.array(SourceRef).min(1),
});
export type SpecRule = z.infer<typeof SpecRule>;

export const GlossaryTerm = z.object({
  term: z.string().describe("正式な呼び方"),
  aliases: z.array(z.string()).default([]).describe("CS / 顧客側での呼ばれ方"),
  codeName: z.string().nullable().default(null).describe("コード上の識別子"),
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;

export const TestPoints = z.object({
  normal: stringArray,
  abnormal: stringArray,
  regression: stringArray.describe("この変更で影響を受ける既存機能の回帰観点"),
  e2e: z
    .array(
      z.object({
        title: z.string(),
        steps: z.array(z.string()),
        expected: z.string(),
      }),
    )
    .default([]),
});
export type TestPoints = z.infer<typeof TestPoints>;

export const ChangelogEntry = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  summary: z.string(),
  pr: z.string().nullable().default(null),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;

/**
 * 確認事項の種類。「分からない」にも中身の違いがある。
 *
 * - `intent`: コードを探したうえで、意図・運用・外部システムの挙動など、人に聞くしかないこと
 * - `unverified`: コードを追えば分かるはずだが、今回そこまで読めなかったこと
 * - `scope`: ドキュメントの範囲についての相談（別ドキュメントにすべきか等）
 *
 * 人に聞くべきなのは `intent` だけ。`unverified` をそのまま人に渡すと、
 * 「コードを読めば分かることを聞く」ことになる。
 */
export const QuestionKind = z.enum(["intent", "unverified", "scope"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

/**
 * 旧形式（文字列だけ）の確認事項を読み込めるようにする。
 *
 * 文字列には「どこを探したか」が無いので `unverified` として扱う。
 * 探した証拠のない「分からない」を、人に聞くべきことに格上げしない。
 */
function coerceOpenQuestion(value: unknown): unknown {
  if (typeof value === "string") return { question: value, kind: "unverified", searched: [] };
  return value;
}

export const OpenQuestion = z.preprocess(
  coerceOpenQuestion,
  z.object({
    question: z.string().describe("開発者に直接聞ける疑問文。読み手向けの説明は入れない"),
    // 未知の値や欠落は、証拠が要らない側（unverified）に倒す
    kind: QuestionKind.catch("unverified"),
    searched: z
      .array(z.string())
      .default([])
      .describe("答えを探して Read で開いたファイル。リポジトリルートからの相対パス"),
  }),
);
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const DocStatus = z.enum(["draft", "verified", "stale"]);
export type DocStatus = z.infer<typeof DocStatus>;

/**
 * LLM が生成・更新する本文部分。
 * メタデータ（id / status / changelog など）は人間とツールが管理し、LLM には触らせない。
 */
export const FeatureDocBody = z.object({
  title: z.string(),
  summary: z.string().describe("1〜2文。CS が一覧で読む用"),
  overview: z.string().describe("専門用語を使わない機能説明"),
  userBehavior: stringArray.describe(
    "ユーザーから見た振る舞い。CS が顧客にそのまま説明できる粒度",
  ),
  screens: z.array(Screen).default([]),
  endpoints: z.array(Endpoint).default([]),
  permissions: z.array(PermissionRow).default([]),
  rules: z.array(SpecRule).default([]).describe("仕様の詳細。出典必須"),
  limitations: stringArray.describe("既知の制限・仕様上できないこと"),
  featureFlags: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        sources: z.array(SourceRef).default([]),
      }),
    )
    .default([]),
  testPoints: TestPoints.default({ normal: [], abnormal: [], regression: [], e2e: [] }),
  glossary: z.array(GlossaryTerm).default([]),
  openQuestions: z
    .preprocess(coerceStringArray, z.array(OpenQuestion).default([]))
    .describe("コードからは判断できず、開発者への確認が必要な点。種類ごとに kind を付ける"),
});
export type FeatureDocBody = z.infer<typeof FeatureDocBody>;

/**
 * 機能ドキュメント ID として許可する形。
 *
 * ID はそのままファイル名になる（`features/<id>.md`）ため、`/` や `\` が混ざると
 * docs ディレクトリの外へ書き込めてしまう。ID の出所は LLM（`classify` の `newDocId`、
 * `survey` の `newDocId`）なので、**安全な文字だけを通す許可リスト**にする。
 * 出典パスのように「解決してからルート内か確かめる」方式は、階層を持つパス向けの手段。
 * ID は階層を持たない識別子なので、そもそも区切り文字を通さないほうが強い。
 *
 * 先頭を英数字に限ることで `.` / `..` や隠しファイルも弾ける。
 */
export const DOC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidDocId(id: string): boolean {
  return DOC_ID_PATTERN.test(id);
}

export const FeatureDocMeta = z.object({
  id: z
    .string()
    .regex(DOC_ID_PATTERN, "ID に使えない文字が含まれています（英数字・ハイフン・アンダースコア・ドットのみ）")
    .describe("kebab-case の安定ID"),
  status: DocStatus.default("draft"),
  owners: z.array(z.string()).default([]),
  repos: z.array(z.string()).default([]),
  issueKeys: z.array(z.string()).default([]),
  updatedAt: z.string(),
  updatedByPRs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type FeatureDocMeta = z.infer<typeof FeatureDocMeta>;

export const FeatureDoc = z.object({
  meta: FeatureDocMeta,
  body: FeatureDocBody,
  changelog: z.array(ChangelogEntry).default([]),
});
export type FeatureDoc = z.infer<typeof FeatureDoc>;

/**
 * 解析のきっかけ。マージ層はこれだけを見る。
 *
 * PR 単位の解析とバックフィル（既存コードからの一括生成）で、変更履歴に積む内容も
 * 出典に補う PR 参照も変わる。マージ層が `PullRequestInput` を直接受け取っていると
 * 「PR が存在しない」経路を表現できないので、ここで一段抽象化する。
 */
export interface ChangeSource {
  kind: "pull-request" | "backfill";
  /** `org/repo` */
  repo: string;
  /** `org/repo#123`。バックフィルは PR に紐づかないので null */
  ref: string | null;
  /** YYYY-MM-DD。null なら書き出し時点の日付を使う */
  date: string | null;
  /** 変更履歴に積む既定の文言。解析結果に要約がなければこれを使う */
  fallbackSummary: string;
}

export function sourceFromPullRequest(pr: PullRequestInput): ChangeSource {
  return {
    kind: "pull-request",
    repo: pr.repo,
    ref: `${pr.repo}#${pr.number}`,
    date: pr.mergedAt?.slice(0, 10) ?? null,
    fallbackSummary: pr.title,
  };
}

export function backfillSource(repo: string): ChangeSource {
  return {
    kind: "backfill",
    repo,
    ref: null,
    date: null,
    fallbackSummary: "既存のコードから初版を生成",
  };
}

/** PR 解析の入力 */
export interface PullRequestInput {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  mergedAt: string | null;
  changedFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>;
}

export interface FeatureDocIndexEntry {
  id: string;
  title: string;
  summary: string;
  repos: string[];
  /** 課題管理ツールのキー。マルチリポジトリで PR を同じ機能に束ねる主キーになる */
  issueKeys: string[];
  filePath: string;
}
