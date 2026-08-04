import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureDoc } from "@spec-bridge/core";
import { buildSampleQuestions } from "./samples.ts";

function doc(overrides: Partial<FeatureDoc["body"]> = {}): FeatureDoc {
  return {
    meta: {
      id: "f",
      status: "draft",
      owners: [],
      repos: [],
      issueKeys: [],
      updatedAt: "2026-08-01",
      updatedByPRs: [],
      confidence: 0.9,
    },
    body: {
      title: "投稿の公開範囲設定",
      summary: "",
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
      ...overrides,
    },
    changelog: [],
  };
}

test("ドキュメントが無ければ空配列", () => {
  assert.deepEqual(buildSampleQuestions([]), []);
});

test("タイトルからサンプル質問を作る（特定プロダクトに依存しない）", () => {
  const qs = buildSampleQuestions([doc()]);
  assert.ok(qs.length > 0);
  assert.ok(qs.some((q) => q.includes("投稿の公開範囲設定")));
});

test("答えられる質問を先に、曖昧な質問を後ろに置く", () => {
  // 1問目が「判断できない」になると、この画面が何をするものか伝わらない
  const qs = buildSampleQuestions([
    doc({ userBehavior: ["新規投稿時に公開範囲を選べる。"] }),
  ]);
  assert.match(qs[0]!, /新規投稿時に公開範囲を選べる/);
  assert.match(qs.at(-1)!, /説明どおりに動かない/);
});

test("用語表の別名があれば、顧客が使う言葉での質問を作る", () => {
  const qs = buildSampleQuestions([
    doc({ glossary: [{ term: "公開範囲", aliases: ["公開設定"], codeName: null }] }),
  ]);
  assert.ok(qs.some((q) => q.includes("公開設定")));
});

test("制限事項があれば、それを踏む質問を作る", () => {
  const qs = buildSampleQuestions([doc({ limitations: ["友達のみは選択できない。"] })]);
  assert.ok(qs.some((q) => q.includes("友達のみは選択できない")));
});

test("文末の句点は重複しないように落とす", () => {
  const qs = buildSampleQuestions([doc({ userBehavior: ["公開範囲を選べる。"] })]);
  assert.ok(!qs[0]!.includes("選べる。」"), `句点が重複している: ${qs[0]}`);
});

test("上限件数を超えない", () => {
  const docs = Array.from({ length: 10 }, () => doc({ userBehavior: ["何かできる"] }));
  assert.equal(buildSampleQuestions(docs).length, 4);
  assert.equal(buildSampleQuestions(docs, 2).length, 2);
});
