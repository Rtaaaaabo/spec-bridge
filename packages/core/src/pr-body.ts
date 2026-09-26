import type { ConfidenceBreakdown, CoverageKind } from "./confidence.ts";
import type { MergeWarning } from "./merge.ts";
import { formatQuestion, QUESTION_KIND_LABEL, QUESTION_KINDS, questionsOfKind } from "./questions.ts";
import type { FeatureDoc, PullRequestInput } from "./types.ts";
import { formatUsageSummary, type UsageSummary } from "./usage.ts";

/**
 * 読了率が何を測ったかのラベル。
 * PR 解析とバックフィルで指標が違うので、同じ名前で並べるとレビュアーが誤読する。
 */
export function coverageLabel(kind: CoverageKind): string {
  return kind === "cited-files" ? "出典ファイル読了" : "変更ファイル読了";
}

export interface DocChange {
  doc: FeatureDoc;
  breakdown: ConfidenceBreakdown;
  warnings: Array<MergeWarning | { kind: string; detail: string }>;
}

/**
 * この PR の出どころ。
 *
 * PR 解析とバックフィルで書けることが違う。バックフィルには参照すべき PR が無いので、
 * 「どのコミットのコードから起こしたか」と「何件中何件を書けたか」を代わりに出す。
 * **途中で終わったランを、レビュアーが見て分かるようにするのが目的。**
 */
export type DocsPrSource =
  | { kind: "pull-request"; pr: PullRequestInput }
  | {
      kind: "backfill";
      /** `org/repo` */
      repo: string;
      /** 起点にしたコミット。分からなければ null */
      sha?: string | null;
      /** 列挙された機能数 */
      surveyed: number;
      /** 書けなかった機能数 */
      failed?: number;
      usage?: UsageSummary;
    };

/**
 * docs リポジトリへ出す PR の本文を組み立てる。
 *
 * この PR がレビュー承認フローそのものなので、**レビュアーが何を確認すべきか**を
 * 本文に書く。特に確度の内訳と警告は、機械的に検出できた「怪しさ」なので必ず出す。
 */
export function buildDocsPullRequestBody(
  source: DocsPrSource,
  changes: DocChange[],
): string {
  const lines: string[] = [];

  lines.push(...introLines(source));

  lines.push(
    "## レビューしてほしいこと",
    "",
    "- [ ] 記述が実装と合っているか（特に**権限・ロール**）",
    "- [ ] 出典が正しい箇所を指しているか",
    "- [ ] CS がそのまま顧客に説明できる言葉になっているか",
    "- [ ] 「開発者への確認事項」が妥当か",
    "",
    "承認してマージすると、CX サポートデスクがこの内容を根拠に回答するようになります。",
    "",
  );

  for (const change of changes) {
    const { doc, breakdown, warnings } = change;
    lines.push(`## ${doc.body.title} (\`${doc.meta.id}\`)`);
    lines.push("");
    lines.push(doc.body.summary);
    lines.push("");
    lines.push(
      `**確度 ${doc.meta.confidence.toFixed(2)}** — ` +
        `出典の実在 ${breakdown.sourceValidity.toFixed(2)} / ` +
        `${coverageLabel(breakdown.coverageKind)} ${breakdown.readCoverage.toFixed(2)} / ` +
        `出典の密度 ${breakdown.citationDensity.toFixed(2)} / ` +
        `確定度 ${breakdown.determinacy.toFixed(2)}`,
    );
    lines.push("");

    const b = doc.body;
    lines.push(
      `仕様 ${b.rules.length} 件 ／ 画面 ${b.screens.length} ／ ` +
        `エンドポイント ${b.endpoints.length} ／ 権限 ${b.permissions.length} ／ ` +
        `テスト観点 ${b.testPoints.normal.length + b.testPoints.abnormal.length + b.testPoints.regression.length} 件`,
    );
    lines.push("");

    if (warnings.length > 0) {
      lines.push("<details><summary>⚠️ 自動検出された注意点</summary>", "");
      for (const w of warnings) lines.push(`- ${w.detail}`);
      lines.push("", "</details>", "");
    }

    if (b.openQuestions.length > 0) {
      lines.push("### 開発者への確認事項", "");
      for (const kind of QUESTION_KINDS) {
        const questions = questionsOfKind(b.openQuestions, kind);
        if (questions.length === 0) continue;
        lines.push(`**${QUESTION_KIND_LABEL[kind]}**`, "");
        for (const q of questions) lines.push(`- [ ] ${formatQuestion(q)}`);
        lines.push("");
      }
    }
  }

  lines.push(
    "---",
    "",
    "🤖 [spec-bridge](https://github.com/Rtaaaaabo/spec-bridge) が自動生成しました。" +
      "内容は未レビュー（`status: draft`）です。",
  );

  return lines.join("\n");
}

export function buildDocsPullRequestTitle(source: DocsPrSource, changes: DocChange[]): string {
  const titles = changes.map((c) => c.doc.body.title);
  const suffix =
    source.kind === "pull-request"
      ? `${source.pr.repo}#${source.pr.number}`
      : `${source.repo} のバックフィル`;

  // 0件でも呼ばれうる（全機能が失敗したランなど）。`undefined ほか -1 件` を出さない
  if (titles.length === 0) return `docs: ${suffix}`;

  const subject = titles.length === 1 ? titles[0] : `${titles[0]} ほか ${titles.length - 1} 件`;
  return `docs: ${subject}（${suffix}）`;
}

/** 冒頭の説明。ここだけが出どころによって変わる */
function introLines(source: DocsPrSource): string[] {
  if (source.kind === "pull-request") {
    const pr = source.pr;
    return [
      `[\`${pr.repo}#${pr.number}\`](https://github.com/${pr.repo}/pull/${pr.number}) ` +
        `のマージに伴い、機能仕様ドキュメントを更新しました。`,
      "",
      `> ${pr.title}`,
      "",
    ];
  }

  const written = source.surveyed - (source.failed ?? 0);
  const lines = [
    `\`${source.repo}\` のいまのコードから、機能仕様ドキュメントを書き起こしました。`,
    "",
    // PR に紐づかないので、代わりに「どの状態のコードを読んだか」を示す
    source.sha
      ? `起点: [\`${source.sha.slice(0, 7)}\`](https://github.com/${source.repo}/commit/${source.sha})`
      : "起点: 作業ツリーの現在の状態（コミットに紐づいていません）",
    "",
    `列挙 ${source.surveyed} 件 / 生成 ${written} 件` +
      (source.failed ? ` / **失敗 ${source.failed} 件**` : ""),
  ];
  if (source.usage) lines.push("", formatUsageSummary(source.usage));
  if (source.failed) {
    // 途中で終わったランを「全部そろった」と誤読させない
    lines.push(
      "",
      "> ⚠️ 書けなかった機能があります。**このランだけでは全機能を網羅していません。**" +
        "同じ設定でもう一度実行すると、書けなかったぶんを拾い直します。",
    );
  }
  lines.push("");
  return lines;
}
