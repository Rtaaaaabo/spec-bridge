import YAML from "yaml";
import {
  FeatureDoc,
  type ChangelogEntry,
  type FeatureDocBody,
  type SourceRef,
} from "./types.ts";

const FRONTMATTER_DELIM = "---";

/** 出典を Markdown の脚注参照に変換する際の採番テーブル */
class FootnoteTable {
  private readonly keys = new Map<string, number>();
  private readonly refs: SourceRef[] = [];

  add(source: SourceRef): number {
    const key = `${source.repo}:${source.file}:${source.line ?? ""}:${source.pr ?? ""}`;
    const existing = this.keys.get(key);
    if (existing !== undefined) return existing;
    const index = this.refs.length + 1;
    this.keys.set(key, index);
    this.refs.push(source);
    return index;
  }

  render(): string {
    if (this.refs.length === 0) return "";
    const lines = this.refs.map((ref, i) => {
      const loc = ref.line ? `${ref.file}:${ref.line}` : ref.file;
      const pr = ref.pr ? ` (${ref.pr})` : "";
      return `[^${i + 1}]: \`${ref.repo}\` \`${loc}\`${pr}`;
    });
    return ["## 出典", "", ...lines].join("\n");
  }
}

function markers(sources: SourceRef[], table: FootnoteTable): string {
  if (sources.length === 0) return "";
  return sources.map((s) => `[^${table.add(s)}]`).join("");
}

function section(title: string, content: string | null): string[] {
  if (!content || content.trim() === "") return [];
  return [`## ${title}`, "", content.trim(), ""];
}

function bulletList(items: string[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- ${i}`).join("\n");
}

function table(headers: string[], rows: string[][]): string | null {
  if (rows.length === 0) return null;
  const escape = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(escape).join(" | ")} |`),
  ].join("\n");
}

/**
 * FeatureDoc を Markdown（frontmatter + 本文）へ。
 * 生成は決定論的 — 同じ入力からは常に同じバイト列が出るので、docs リポジトリの diff がノイズにならない。
 */
export function renderMarkdown(doc: FeatureDoc): string {
  const fm = YAML.stringify(doc.meta).trimEnd();
  const notes = new FootnoteTable();
  const b = doc.body;

  const parts: string[] = [
    FRONTMATTER_DELIM,
    fm,
    FRONTMATTER_DELIM,
    "",
    `# ${b.title}`,
    "",
    b.summary.trim(),
    "",
  ];

  parts.push(...section("概要", b.overview));
  parts.push(...section("ユーザーから見た振る舞い", bulletList(b.userBehavior)));

  parts.push(
    ...section(
      "画面",
      table(
        ["画面", "パス", "リポジトリ", "説明"],
        b.screens.map((s) => [
          s.name,
          `\`${s.path}\``,
          `\`${s.repo}\``,
          s.description,
        ]),
      ),
    ),
  );

  parts.push(
    ...section(
      "エンドポイント",
      table(
        ["メソッド", "パス", "リポジトリ", "説明"],
        b.endpoints.map((e) => [
          e.method.toUpperCase(),
          `\`${e.path}\``,
          `\`${e.repo}\``,
          e.description,
        ]),
      ),
    ),
  );

  parts.push(
    ...section(
      "権限・ロール",
      table(
        ["ロール", "できること", "出典"],
        b.permissions.map((p) => [p.role, p.canDo, markers(p.sources, notes)]),
      ),
    ),
  );

  parts.push(
    ...section(
      "仕様の詳細",
      bulletList(b.rules.map((r) => `${r.text}${markers(r.sources, notes)}`)),
    ),
  );

  parts.push(...section("制約・既知の制限", bulletList(b.limitations)));

  parts.push(
    ...section(
      "フィーチャーフラグ",
      table(
        ["フラグ", "説明", "出典"],
        b.featureFlags.map((f) => [
          `\`${f.name}\``,
          f.description,
          markers(f.sources, notes),
        ]),
      ),
    ),
  );

  const t = b.testPoints;
  const testBlocks: string[] = [];
  if (t.normal.length) testBlocks.push(`### 正常系\n\n${bulletList(t.normal)}`);
  if (t.abnormal.length) testBlocks.push(`### 異常系\n\n${bulletList(t.abnormal)}`);
  if (t.regression.length)
    testBlocks.push(`### 回帰テスト対象\n\n${bulletList(t.regression)}`);
  if (t.e2e.length) {
    const e2e = t.e2e
      .map(
        (c) =>
          `#### ${c.title}\n\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n**期待結果**: ${c.expected}`,
      )
      .join("\n\n");
    testBlocks.push(`### E2E シナリオ\n\n${e2e}`);
  }
  parts.push(...section("テスト観点", testBlocks.join("\n\n") || null));

  parts.push(
    ...section(
      "用語",
      table(
        ["用語", "別の呼ばれ方", "コード上の名前"],
        b.glossary.map((g) => [
          g.term,
          g.aliases.join(" / "),
          g.codeName ? `\`${g.codeName}\`` : "",
        ]),
      ),
    ),
  );

  parts.push(
    ...section(
      "開発者への確認事項",
      bulletList(b.openQuestions.map((q) => `[ ] ${q}`)),
    ),
  );

  parts.push(
    ...section(
      "変更履歴",
      table(
        ["日付", "変更内容", "PR"],
        [...doc.changelog]
          .reverse()
          .map((c) => [c.date, c.summary, c.pr ? `\`${c.pr}\`` : ""]),
      ),
    ),
  );

  const footnotes = notes.render();
  if (footnotes) parts.push(footnotes, "");

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Markdown から FeatureDoc を復元する。
 * 本文は frontmatter 直後の JSON ブロック（`<!-- spec-bridge:data -->`）から読む。
 * Markdown 本文を再パースするのは壊れやすいので、機械可読なソースオブトゥルースを併記しておく。
 */
export function renderDocFile(doc: FeatureDoc): string {
  const data = JSON.stringify({ body: doc.body, changelog: doc.changelog }, null, 2);
  const md = renderMarkdown(doc);
  return `${md}\n<!-- spec-bridge:data\n${data}\n-->\n`;
}

export function parseDocFile(raw: string): FeatureDoc | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const dataMatch = raw.match(/<!-- spec-bridge:data\n([\s\S]*?)\n-->/);
  if (!fmMatch?.[1] || !dataMatch?.[1]) return null;

  const meta = YAML.parse(fmMatch[1]) as unknown;
  const data = JSON.parse(dataMatch[1]) as {
    body: FeatureDocBody;
    changelog: ChangelogEntry[];
  };

  const parsed = FeatureDoc.safeParse({
    meta,
    body: data.body,
    changelog: data.changelog ?? [],
  });
  return parsed.success ? parsed.data : null;
}
