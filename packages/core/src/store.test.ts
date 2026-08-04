import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DocStore } from "./store.ts";
import type { FeatureDoc } from "./types.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "spec-bridge-store-"));
}

function doc(id: string, overrides: Partial<FeatureDoc["meta"]> = {}): FeatureDoc {
  return {
    meta: {
      id,
      status: "draft",
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-08-01",
      updatedByPRs: [],
      confidence: 0.9,
      ...overrides,
    },
    body: {
      title: `${id} の機能`,
      summary: `${id} の要約`,
      overview: "概要",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [
        { text: "ルール", sources: [{ repo: "acme/backend", file: "a.ts", line: 1, pr: null }] },
      ],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
    },
    changelog: [],
  };
}

test("保存したドキュメントを読み戻せる", async () => {
  const store = new DocStore(tempDir());
  await store.save(doc("payment-retry"));

  const loaded = await store.get("payment-retry");
  assert.ok(loaded, "読み戻せなかった");
  assert.equal(loaded.body.title, "payment-retry の機能");
  assert.equal(loaded.body.rules[0]?.sources[0]?.file, "a.ts");
});

test("存在しない id は null を返す（例外にしない）", async () => {
  const store = new DocStore(tempDir());
  assert.equal(await store.get("nope"), null);
});

test("ディレクトリが無くても list は空配列を返す", async () => {
  const store = new DocStore(join(tmpdir(), "spec-bridge-not-created-" + Date.now()));
  assert.deepEqual(await store.list(), []);
});

test("同じ id で保存すると上書きされる（重複ファイルを作らない）", async () => {
  const root = tempDir();
  const store = new DocStore(root);
  await store.save(doc("same"));

  const updated = doc("same");
  updated.body.title = "更新後";
  await store.save(updated);

  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.body.title, "更新後");
});

test("複数のドキュメントを列挙できる", async () => {
  const store = new DocStore(tempDir());
  for (const id of ["a", "b", "c"]) await store.save(doc(id));

  const ids = (await store.list()).map((d) => d.meta.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("索引には課題キーとリポジトリが含まれる（マルチリポジトリの束ねに使う）", async () => {
  const store = new DocStore(tempDir());
  await store.save(
    doc("payment", { issueKeys: ["PROJ-42"], repos: ["acme/backend", "acme/frontend"] }),
  );

  const index = await store.index();
  assert.equal(index.length, 1);
  assert.deepEqual(index[0]?.issueKeys, ["PROJ-42"]);
  assert.deepEqual(index[0]?.repos, ["acme/backend", "acme/frontend"]);
  assert.equal(index[0]?.title, "payment の機能");
});

test("壊れた Markdown が混ざっていても、他のドキュメントは読める", async () => {
  const root = tempDir();
  const store = new DocStore(root);
  await store.save(doc("good"));

  mkdirSync(join(root, "features"), { recursive: true });
  writeFileSync(join(root, "features", "broken.md"), "# 手で書き換えて壊れたファイル\n", "utf8");

  const all = await store.list();
  assert.equal(all.length, 1, "壊れたファイルで全体が読めなくなってはいけない");
  assert.equal(all[0]?.meta.id, "good");
});

test("インデックスページが生成される", async () => {
  const root = tempDir();
  const store = new DocStore(root);
  await store.save(doc("payment-retry"));
  await store.writeIndexPage();

  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.match(readme, /payment-retry/);
});
