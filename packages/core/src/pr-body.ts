import type { ConfidenceBreakdown } from "./confidence.ts";
import type { MergeWarning } from "./merge.ts";
import type { FeatureDoc, PullRequestInput } from "./types.ts";

export interface DocChange {
  doc: FeatureDoc;
  breakdown: ConfidenceBreakdown;
  warnings: Array<MergeWarning | { kind: string; detail: string }>;
}

/**
 * docs リポジトリへ出す PR の本文を組み立てる。
 *
 * この PR がレビュー承認フローそのものなので、**レビュアーが何を確認すべきか**を
 * 本文に書く。特に確度の内訳と警告は、機械的に検出できた「怪しさ」なので必ず出す。
 */
export function buildDocsPullRequestBody(
  sourcePr: PullRequestInput,
  changes: DocChange[],
): string {
  const lines: string[] = [];

  lines.push(
    `[\`${sourcePr.repo}#${sourcePr.number}\`](https://github.com/${sourcePr.repo}/pull/${sourcePr.number}) ` +
      `のマージに伴い、機能仕様ドキュメントを更新しました。`,
    "",
    `> ${sourcePr.title}`,
    "",
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
        `変更ファイル読了 ${breakdown.readCoverage.toFixed(2)} / ` +
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
      for (const q of b.openQuestions) lines.push(`- [ ] ${q}`);
      lines.push("");
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

export function buildDocsPullRequestTitle(
  sourcePr: PullRequestInput,
  changes: DocChange[],
): string {
  const titles = changes.map((c) => c.doc.body.title);
  const subject =
    titles.length === 1 ? titles[0] : `${titles[0]} ほか ${titles.length - 1} 件`;
  return `docs: ${subject}（${sourcePr.repo}#${sourcePr.number}）`;
}
