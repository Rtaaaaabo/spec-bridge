import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// --- パストラバーサル（SaaS 化の調査で実際に脱出できることを確認した箇所） ---

test("ID で docs ディレクトリの外へ書き込めない", async () => {
  // 脱出先を自分たちだけの領域にするため docs ルートを一段ネストさせる。
  // 共有の tmpdir を脱出先にすると、他のテストや過去の実行の残骸を拾ってしまう。
  const sandbox = tempDir();
  const root = join(sandbox, "docs");
  const store = new DocStore(root);

  // 修正前は join(featuresDir, "../../escaped.md") が通り、sandbox 直下にファイルができた
  await assert.rejects(
    () => store.save(doc("../../escaped")),
    /使えない値/,
    "ルート外への書き込みが通ってしまった",
  );

  assert.equal(
    existsSync(join(sandbox, "escaped.md")),
    false,
    "docs ルートの外にファイルができている",
  );
  // 検証はディスクを触る前に行うので、features ディレクトリも作られない
  assert.equal(existsSync(join(root, "features")), false);
});

test("区切り文字を含む ID はすべて拒否する", async () => {
  const store = new DocStore(tempDir());
  for (const id of [
    "../escape",
    "a/b",
    "a\\b",
    "/absolute",
    "..",
    ".",
    ".hidden",
    "",
    "a".repeat(101),
  ]) {
    await assert.rejects(
      () => store.save(doc(id)),
      /使えない値/,
      `拒否されなければならない ID: ${JSON.stringify(id)}`,
    );
  }
});

test("通常の ID は今までどおり保存できる（過剰に厳しくしない）", async () => {
  const store = new DocStore(tempDir());
  for (const id of ["payment-retry", "post_visibility", "v1.2", "Feature1", "a"]) {
    await store.save(doc(id));
    assert.ok(await store.get(id), `保存できるべき ID が弾かれた: ${id}`);
  }
});

test("不正な ID の取得は例外ではなく null（照会は落とさない）", async () => {
  const store = new DocStore(tempDir());
  assert.equal(await store.get("../../etc/passwd"), null);
});

test("手で書き換えて不正な ID にされたファイルは読み飛ばす", async () => {
  const root = tempDir();
  const store = new DocStore(root);
  await store.save(doc("good"));

  // frontmatter の id だけを不正な値に書き換える
  const path = join(root, "features", "good.md");
  writeFileSync(path.replace("good.md", "tampered.md"), readFileSync(path, "utf8").replace("id: good", "id: ../../evil"), "utf8");

  const all = await store.list();
  assert.equal(all.length, 1, "不正な id のファイルが読み込まれてしまっている");
  assert.equal(all[0]?.meta.id, "good");
});
