import assert from "node:assert/strict";
import { test } from "node:test";
import { excludeDocumented, type SurveyedFeature } from "./survey.ts";

function feature(docId: string | null, newDocId: string | null): SurveyedFeature {
  return { docId, newDocId, title: docId ?? newDocId ?? "?", why: "", entryPoints: [] };
}

// 書き直すと、人がレビュー済にした印が外れる（実際に起きた）
test("すでにドキュメントがある機能は書かない", () => {
  const { features, documented } = excludeDocumented(
    [feature("invite", null), feature(null, "seat-limit"), feature("members", null)],
    ["invite", "members"],
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

test("新規の ID に既存の ID を書いてきても、既存として扱う", () => {
  const { features, documented } = excludeDocumented([feature(null, "invite")], ["invite"]);
  assert.deepEqual(features, []);
  assert.equal(documented.length, 1);
});

test("既存の ID を指していれば、一覧に無くても既存として扱う（docId は既存に紐づける約束）", () => {
  const { features } = excludeDocumented([feature("removed-doc", null)], []);
  assert.deepEqual(features, []);
});

test("ドキュメントが1件も無ければ、全部書く", () => {
  const all = [feature(null, "a"), feature(null, "b")];
  assert.deepEqual(excludeDocumented(all, []).features, all);
});
