import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryTenantStore } from "./store.ts";
import { resolveDocsRepo } from "./resolve.ts";
import { isValidRepoName, normalizeDocsRepo } from "./types.ts";

// --- 入力の検証（画面から入る値） ---

test("org/repo の形だけ受け付ける", () => {
  assert.equal(isValidRepoName("acme/product-specs"), true);
  assert.equal(isValidRepoName("acme_1/specs.v2"), true);
  for (const bad of ["acme", "acme/", "/specs", "acme/spec s", "a/b/c", "", "acme/specs;drop"]) {
    assert.equal(isValidRepoName(bad), false, bad);
  }
});

test("空文字は「未設定に戻す」（画面から消せるように）", () => {
  assert.equal(normalizeDocsRepo(""), null);
  assert.equal(normalizeDocsRepo("   "), null);
  assert.equal(normalizeDocsRepo(null), null);
});

test("形式が違えば保存前に弾く", () => {
  assert.throws(() => normalizeDocsRepo("specs"), /org\/repo の形式/);
});

test("前後の空白は落とす", () => {
  assert.equal(normalizeDocsRepo("  acme/specs  "), "acme/specs");
});

// --- 記録（webhook の installation イベントから） ---

test("インストールを記録して引ける", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme" });
  const tenant = await store.get(1);
  assert.equal(tenant?.account, "acme");
  assert.equal(tenant?.docsRepo, null, "提出先は未設定から始まる");
});

// 再インストールのたびに設定が消えると、毎回入れ直しになる
test("再記録しても提出先は消えない", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme" });
  await store.setDocsRepo(1, "acme/specs");
  await store.upsert({ installationId: 1, account: "acme-renamed" });

  const tenant = await store.get(1);
  assert.equal(tenant?.docsRepo, "acme/specs");
  assert.equal(tenant?.account, "acme-renamed", "アカウント名の変更は反映する");
});

test("提出先は未設定に戻せる", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme", docsRepo: "acme/specs" });
  assert.equal((await store.setDocsRepo(1, null))?.docsRepo, null);
});

test("知らないインストールには設定できない", async () => {
  const store = new MemoryTenantStore();
  assert.equal(await store.setDocsRepo(999, "acme/specs"), null);
});

test("アンインストールで消える", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme" });
  await store.remove(1);
  assert.equal(await store.get(1), null);
});

// --- 提出先の解決 ---

test("テナントの設定を使う", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme", docsRepo: "acme/specs" });
  assert.deepEqual(await resolveDocsRepo(store, 1, "env/repo"), {
    docsRepo: "acme/specs",
    source: "installation",
  });
});

// 単一テナント運用（env 1本）のための後方互換
test("テナントに設定が無ければ環境変数へ落ちる", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme" });
  assert.deepEqual(await resolveDocsRepo(store, 1, "env/repo"), {
    docsRepo: "env/repo",
    source: "env",
  });
});

test("installation が分からなくても環境変数があれば動く", async () => {
  const store = new MemoryTenantStore();
  assert.equal((await resolveDocsRepo(store, null, "env/repo")).source, "env");
});

// 提出先の無いまま数分〜30分の解析を走らせない
test("どちらも無ければ投げる", async () => {
  const store = new MemoryTenantStore();
  await store.upsert({ installationId: 1, account: "acme" });
  await assert.rejects(() => resolveDocsRepo(store, 1, undefined), /提出先が設定されていません/);
  await assert.rejects(() => resolveDocsRepo(store, null, ""), /提出先が決まりません/);
});
