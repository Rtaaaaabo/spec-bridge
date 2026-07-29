import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDocFile, renderDocFile } from "./markdown.ts";
import type { FeatureDoc, FeatureDocIndexEntry } from "./types.ts";

/**
 * docs リポジトリ（またはローカルディレクトリ）上の機能ドキュメント置き場。
 * レイアウト: <root>/features/<id>.md
 */
export class DocStore {
  constructor(private readonly root: string) {}

  private get featuresDir(): string {
    return join(this.root, "features");
  }

  private pathFor(id: string): string {
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
    await mkdir(this.featuresDir, { recursive: true });
    const path = this.pathFor(doc.meta.id);
    await writeFile(path, renderDocFile(doc), "utf8");
    return path;
  }

  /** 一覧ページ（README）を再生成する。CS / QA が最初に開く入口。 */
  async writeIndexPage(): Promise<string> {
    const docs = await this.list();
    const rows = docs.map((d) => {
      const badge = { verified: "✅ 確認済", draft: "📝 AI生成", stale: "⚠️ 要更新" }[
        d.meta.status
      ];
      return `| [${d.body.title}](features/${d.meta.id}.md) | ${badge} | ${d.meta.repos.map((r) => `\`${r}\``).join(", ")} | ${d.meta.updatedAt} |`;
    });
    const content = [
      "# 機能仕様インデックス",
      "",
      "spec-bridge が PR から自動生成・更新しています。",
      "`📝 AI生成` は未レビューです — 顧客への回答に使う前に開発者の確認を取ってください。",
      "",
      "| 機能 | ステータス | リポジトリ | 最終更新 |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "README.md");
    await writeFile(path, content, "utf8");
    return path;
  }
}
