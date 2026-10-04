import assert from "node:assert/strict";
import { test } from "node:test";
import { excludeDocumented, type SurveyedFeature } from "./survey.ts";

function feature(docId: string | null, newDocId: string | null): SurveyedFeature {
  return { docId, newDocId, title: docId ?? newDocId ?? "?", why: "", entryPoints: [] };
}

const existing = [
  { id: "invite", repos: ["acme/api"] },
  { id: "members", repos: ["acme/api", "acme/web"] },
];

// 同じリポジトリで書き直すと、人がレビュー済にした印が外れる（実際に起きた）
test("このリポジトリの分がすでに書かれている機能は書かない", () => {
  const { features, documented } = excludeDocumented(
    [feature("invite", null), feature(null, "seat-limit"), feature("members", null)],
    existing,
    "acme/api",
  );
  assert.deepEqual(
    features.map((f) => f.newDocId),
    ["seat-limit"],
  );
  assert.deepEqual(
    documented.map((f) => f.docId),
    ["invite", "members"],
  );
});

// サーバー側だけを書き起こした機能に、画面のリポジトリから画面の情報を足す
test("別のリポジトリから見た同じ機能は、既存の機能に追記する", () => {
  const { features, documented } = excludeDocumented(
    [feature("invite", null), feature("members", null)],
    existing,
    "acme/web",
  );
  assert.deepEqual(
    features.map((f) => f.docId),
    ["invite"],
  );
  assert.deepEqual(
    documented.map((f) => f.docId),
    ["members"],
    "acme/web がすでに入っている機能は書かない",
  );
});

test("新規の ID に既存の ID を書いてきても、既存の機能として扱う", () => {
  const same = excludeDocumented([feature(null, "invite")], existing, "acme/api");
  assert.deepEqual(same.features, []);
  assert.equal(same.documented.length, 1);

  // 別のリポジトリなら、既存の id に寄せて追記させる（新しい機能を作らない）
  const other = excludeDocumented([feature(null, "invite")], existing, "acme/web");
  assert.deepEqual(other.features, [{ ...feature(null, "invite"), docId: "invite", newDocId: null }]);
});

test("リポジトリ名の大文字・小文字は区別しない", () => {
  const { features } = excludeDocumented([feature("invite", null)], existing, "Acme/API");
  assert.deepEqual(features, []);
});

test("一覧に無い既存の ID を指してきたものは書かない（存在しない機能を作らない）", () => {
  const { features } = excludeDocumented([feature("removed-doc", null)], existing, "acme/api");
  assert.deepEqual(features, []);
});

test("ドキュメントが1件も無ければ、全部書く", () => {
  const all = [feature(null, "a"), feature(null, "b")];
  assert.deepEqual(excludeDocumented(all, [], "acme/api").features, all);
});
