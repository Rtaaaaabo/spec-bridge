import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SELECTED_DOCS, resolveSelection, selectRelevantDocs } from "./select-docs.ts";
import type { FeatureDoc } from "./types.ts";

function doc(id: string): FeatureDoc {
  return {
    meta: {
      id,
      status: "draft",
      owners: [],
      repos: [],
      issueKeys: [],
      updatedAt: "2026-08-01",
      updatedByPRs: [],
      confidence: 0.9,
    },
    body: {
      title: id,
      summary: `${id} の要約`,
      overview: "",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
    },
    changelog: [],
  };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => doc(`f${i}`));

// --- 閾値（LLM を呼ばない経路） ---

test("件数が閾値以下なら絞り込まず全件を返す（往復を増やさない）", async () => {
  const docs = many(5);
  const r = await selectRelevantDocs("なんでもよい質問", docs);
  assert.equal(r.narrowed, false);
  assert.equal(r.docs.length, 5);
});

test("ドキュメントが0件でも落ちない", async () => {
  const r = await selectRelevantDocs("質問", []);
  assert.equal(r.docs.length, 0);
  assert.equal(r.narrowed, false);
});

// --- 出力の解決（この製品で最も怖い失敗が起きる場所） ---

test("選ばれた id のドキュメントだけを返す", () => {
  const docs = many(10);
  const r = resolveSelection('{"docIds":["f2","f7"],"reason":"関係あり"}', docs);
  assert.equal(r.narrowed, true);
  assert.deepEqual(r.docs.map((d) => d.meta.id), ["f2", "f7"]);
  assert.equal(r.reason, "関係あり");
});

test("空配列が返ったら0件のまま返す（無理に全件へ戻さない）", () => {
  // 「関係するものがない」は正しい判断。ここで全件に戻すと無関係な回答が生まれる
  const docs = many(10);
  const r = resolveSelection('{"docIds":[],"reason":"該当なし"}', docs);
  assert.equal(r.docs.length, 0);
  assert.equal(r.narrowed, true);
});

test("存在しない id は無視する（ハルシネーション対策）", () => {
  const docs = many(10);
  const r = resolveSelection('{"docIds":["f1","存在しない機能","f3"]}', docs);
  assert.deepEqual(r.docs.map((d) => d.meta.id), ["f1", "f3"]);
});

test("全部が存在しない id でも、全件へは戻さない", () => {
  const docs = many(10);
  const r = resolveSelection('{"docIds":["架空A","架空B"]}', docs);
  assert.equal(r.docs.length, 0, "架空の id で全件を参照してはいけない");
});

test("重複した id は1件にまとめる", () => {
  const docs = many(10);
  const r = resolveSelection('{"docIds":["f1","f1","f2"]}', docs);
  assert.deepEqual(r.docs.map((d) => d.meta.id), ["f1", "f2"]);
});

test("上限件数で打ち切る", () => {
  const docs = many(20);
  const ids = docs.slice(0, 12).map((d) => d.meta.id);
  const r = resolveSelection(JSON.stringify({ docIds: ids }), docs);
  assert.equal(r.docs.length, MAX_SELECTED_DOCS);
});

test("上限は呼び出し側で指定できる", () => {
  const docs = many(20);
  const ids = docs.slice(0, 12).map((d) => d.meta.id);
  const r = resolveSelection(JSON.stringify({ docIds: ids }), docs, 2);
  assert.equal(r.docs.length, 2);
});

test("出力が壊れていたら全件へフォールバックする", () => {
  // 答えられなくなるより、コストを払ってでも答えられるほうがよい
  const docs = many(10);
  const r = resolveSelection("すみません、選べませんでした。", docs);
  assert.equal(r.docs.length, 10);
  assert.equal(r.narrowed, false);
});

test("docIds が欠けていても壊れず、0件として扱う", () => {
  const docs = many(10);
  const r = resolveSelection('{"reason":"該当なし"}', docs);
  assert.equal(r.docs.length, 0);
  assert.equal(r.narrowed, true);
});

test("フェンス付きの出力でも解決できる", () => {
  const docs = many(10);
  const r = resolveSelection('考えました。\n```json\n{"docIds":["f4"]}\n```', docs);
  assert.deepEqual(r.docs.map((d) => d.meta.id), ["f4"]);
});
