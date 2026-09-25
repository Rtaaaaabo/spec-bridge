import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDocFile, renderDocFile } from "./markdown.ts";
import { formatQuestion, QUESTION_KIND_LABEL, QUESTION_KINDS, questionsOfKind } from "./questions.ts";
import {
  isValidDocId,
  type FeatureDoc,
  type FeatureDocIndexEntry,
  type QuestionKind,
} from "./types.ts";

/** 一覧ページのファイル名（docs ルートからの相対パス） */
export const INDEX_PAGE = "README.md";
/** 確認事項の横断一覧のファイル名（docs ルートからの相対パス） */
export const QUESTIONS_PAGE = "open-questions.md";

const STATUS_BADGE: Record<FeatureDoc["meta"]["status"], string> = {
  verified: "✅ 確認済",
  draft: "📝 AI生成",
  stale: "⚠️ 要更新",
};

/**
 * docs リポジトリ（またはローカルディレクトリ）上の機能ドキュメント置き場。
 * レイアウト:
 *   <root>/README.md            一覧ページ
 *   <root>/open-questions.md    開発者への確認事項（全機能ぶん）
 *   <root>/features/<id>.md     機能ドキュメント
 */
export class DocStore {
  constructor(private readonly root: string) {}

  private get featuresDir(): string {
    return join(this.root, "features");
  }

  /**
   * ID からファイルパスを組み立てる。**書き込み先を決める唯一の場所。**
   *
   * ID は LLM が決めた値なので、ここで必ず検証する。スキーマ側でも弾いているが、
   * `FeatureDoc` を経由せず ID 文字列だけで呼ばれる経路（`get`）があるため、
   * パスを作る側にも置いて二重にする。
   */
  private pathFor(id: string): string {
    if (!isValidDocId(id)) {
      throw new Error(
        `ドキュメント ID として使えない値です: ${JSON.stringify(id)}\n` +
          `英数字で始まり、英数字・ハイフン・アンダースコア・ドットのみ（100文字以内）が使えます。`,
      );
    }
    return join(this.featuresDir, `${id}.md`);
  }

  async list(): Promise<FeatureDoc[]> {
    let entries: string[];
    try {
      entries = await readdir(this.featuresDir);
    } catch {
      return [];
    }
    const docs: FeatureDoc[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const raw = await readFile(join(this.featuresDir, entry), "utf8");
      const doc = parseDocFile(raw);
      if (doc) docs.push(doc);
      else
        console.warn(
          `[spec-bridge] ${entry} を FeatureDoc として読めませんでした（手で編集された可能性があります）。スキップします。`,
        );
    }
    return docs.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  }

  async index(): Promise<FeatureDocIndexEntry[]> {
    const docs = await this.list();
    return docs.map((d) => ({
      id: d.meta.id,
      title: d.body.title,
      summary: d.body.summary,
      repos: d.meta.repos,
      issueKeys: d.meta.issueKeys,
      filePath: relative(this.root, this.pathFor(d.meta.id)),
    }));
  }

  async get(id: string): Promise<FeatureDoc | null> {
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      return parseDocFile(raw);
    } catch {
      return null;
    }
  }

  async save(doc: FeatureDoc): Promise<string> {
    // 検証はディスクを触る前に。不正な ID で呼ばれたときに痕跡を残さない
    const path = this.pathFor(doc.meta.id);
    await mkdir(this.featuresDir, { recursive: true });
    await writeFile(path, renderDocFile(doc), "utf8");
    return path;
  }

  /**
   * 一覧ページ（README）と確認事項の横断一覧を再生成する。CS / QA が最初に開く入口。
   *
   * 2つは同じ `list()` から作り、必ず一緒に書く。片方だけ古いと、
   * 一覧の件数と確認事項ページの中身が食い違う。
   */
  async writeIndexPage(): Promise<string> {
    const docs = await this.list();
    const counts = countQuestions(docs);

    // 一覧に出す件数は「聞くべきこと」だけ。調べれば埋まるものまで数えると、人に聞く量を水増しして見せる
    const rows = docs.map((d) => {
      const ask = questionsOfKind(d.body.openQuestions, "intent").length;
      return `| [${d.body.title}](features/${d.meta.id}.md) | ${STATUS_BADGE[d.meta.status]} | ${ask > 0 ? `${ask} 件` : "—"} | ${d.meta.repos.map((r) => `\`${r}\``).join(", ")} | ${d.meta.updatedAt} |`;
    });
    const content = [
      "# 機能仕様インデックス",
      "",
      // バックフィルで作られたドキュメントは PR に紐づかないので「PR から」とは書けない
      "spec-bridge がソースコードから自動生成・更新しています。",
      "`📝 AI生成` は未レビューです — 顧客への回答に使う前に開発者の確認を取ってください。",
      "",
      `コードを読んだうえで人に確かめるしかない点は [開発者への確認事項](${QUESTIONS_PAGE}) にまとめています` +
        `（聞くべきこと ${counts.intent} 件。ほかに追加調査 ${counts.unverified} 件・範囲のメモ ${counts.scope} 件）。`,
      "",
      "| 機能 | ステータス | 聞くべきこと | リポジトリ | 最終更新 |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, INDEX_PAGE);
    await writeFile(path, content, "utf8");
    await writeFile(join(this.root, QUESTIONS_PAGE), renderQuestionsPage(docs), "utf8");
    return path;
  }
}

function countQuestions(docs: FeatureDoc[]): Record<QuestionKind, number> {
  const counts: Record<QuestionKind, number> = { intent: 0, unverified: 0, scope: 0 };
  for (const d of docs) for (const q of d.body.openQuestions) counts[q.kind] += 1;
  return counts;
}

const KIND_INTRO: Record<QuestionKind, string> = {
  intent:
    "コードを探したうえで、意図・運用・外部システムの挙動など、人に確かめるしかない点です。各項目に、答えを探して開いたファイルを添えています。",
  unverified:
    "コードを追えば分かるはずで、今回そこまで読めなかった点です。人に聞く前に、もう一度コードを当たってください。",
  scope: "機能ドキュメントの範囲についての相談です。ドキュメントを保守する人向けのメモです。",
};

/**
 * 全機能の `openQuestions` を1ページに集める。
 *
 * 機能ドキュメントの中に散らばったままだと、「コードを読んだうえで、人に聞くべきこと」を
 * 見渡す手段がない。キックオフや引き継ぎの前に、このページだけ開けば済むようにする。
 *
 * 種類ごとに分け、人に聞くべきもの（intent）を先頭に置く。調べれば埋まるもの（unverified）を
 * 同じ並びに混ぜると、「コードを読めば分かることを聞く」ことになる。
 *
 * 入力の並び（`list()` は ID 順）をそのまま使い、日時も埋め込まない。
 * 同じドキュメント群からは常に同じバイト列が出る（docs リポジトリの diff を汚さない）。
 */
export function renderQuestionsPage(docs: FeatureDoc[]): string {
  const counts = countQuestions(docs);
  const total = counts.intent + counts.unverified + counts.scope;

  const lines = ["# 開発者への確認事項", ""];
  if (total === 0) {
    lines.push("現在、確認事項はありません。", "");
    return lines.join("\n");
  }

  lines.push(
    `spec-bridge がコードから確定できず、推測で埋めずに残した点を種類ごとにまとめています` +
      `（聞くべきこと ${counts.intent} 件・追加調査 ${counts.unverified} 件・範囲のメモ ${counts.scope} 件）。`,
    "前後の文脈は、見出しのリンク先の機能ドキュメントを参照してください。",
    "",
  );
  for (const kind of QUESTION_KINDS) {
    if (counts[kind] === 0) continue;
    lines.push(`## ${QUESTION_KIND_LABEL[kind]}（${counts[kind]} 件）`, "", KIND_INTRO[kind], "");
    for (const d of docs) {
      const questions = questionsOfKind(d.body.openQuestions, kind);
      if (questions.length === 0) continue;
      lines.push(
        `### [${d.body.title}](features/${d.meta.id}.md)`,
        "",
        `${STATUS_BADGE[d.meta.status]} · ${d.meta.repos.map((r) => `\`${r}\``).join(", ")}`,
        "",
        ...questions.map((q) => `- [ ] ${formatQuestion(q)}`),
        "",
      );
    }
  }
  return lines.join("\n");
}
