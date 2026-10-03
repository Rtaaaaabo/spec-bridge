import assert from "node:assert/strict";
import { test } from "node:test";
import { AskAnswer, finalizeAnswer } from "./ask.ts";
import type { FeatureDoc } from "./types.ts";

function doc(id: string, status: FeatureDoc["meta"]["status"]): FeatureDoc {
  return {
    meta: {
      id,
      status,
      owners: [],
      repos: [],
      issueKeys: [],
      updatedAt: "2026-10-01",
      updatedByPRs: [],
      confidence: 0.8,
    },
    body: {
      title: `${id} の機能`,
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
    },
    changelog: [],
  };
}

function answer(overrides: Partial<AskAnswer> = {}): AskAnswer {
  return AskAnswer.parse({
    grounding: "answered",
    confidence: 0.9,
    headline: "14日間です",
    answer: "招待の有効期限は14日間です。",
    citations: [{ docId: "invite", quote: "招待の有効期限は14日間" }],
    ...overrides,
  });
}

const docs = [doc("invite", "draft"), doc("members", "verified"), doc("billing", "stale")];

test("出典のある答えは、そのまま返す", () => {
  const { answer: result } = finalizeAnswer(answer(), docs);
  assert.equal(result.grounding, "answered");
  assert.equal(result.answer, "招待の有効期限は14日間です。");
});

// 根拠なしで断定させない。プロンプトではなくシステム側で強制する
test("出典が無いのに答えていたら、答えを捨てて「答えられない」に落とす", () => {
  const { answer: result } = finalizeAnswer(
    answer({ citations: [], verdict: "spec", devRequest: { title: "t", body: "b" } }),
    docs,
  );
  assert.equal(result.grounding, "unknown");
  assert.equal(result.answer, "", "答えの文面を残さない");
  assert.equal(result.verdict, null);
  assert.equal(result.devRequest, null);
  assert.equal(result.confidence, 0);
  assert.match(result.unknowns.at(-1) ?? "", /出典を示せない/);
});

test("一部だけ答えられた（partial）も、出典が無ければ落とす", () => {
  const { answer: result } = finalizeAnswer(answer({ grounding: "partial", citations: [] }), docs);
  assert.equal(result.grounding, "unknown");
});

test("答えられないときは、LLM が答えを書いていても空にする", () => {
  const { answer: result } = finalizeAnswer(answer({ grounding: "unknown", answer: "たぶん14日" }), docs);
  assert.equal(result.answer, "");
});

test("起票文は、判定が bug のときだけ残す", () => {
  const devRequest = { title: "期限が7日になる", body: "..." };
  assert.equal(finalizeAnswer(answer({ verdict: "spec", devRequest }), docs).answer.devRequest, null);
  assert.equal(finalizeAnswer(answer({ verdict: null, devRequest }), docs).answer.devRequest, null);
  assert.deepEqual(finalizeAnswer(answer({ verdict: "bug", devRequest }), docs).answer.devRequest, devRequest);
});

// 「未レビューを根拠にした」ことの言い忘れを起こさないよう、LLM に書かせず機械的に出す
test("根拠にした機能のうち、未レビュー（AI生成・要更新）のものを出す", () => {
  const { unreviewed } = finalizeAnswer(
    answer({
      citations: [
        { docId: "invite", docTitle: "", quote: "a", file: "" },
        { docId: "invite", docTitle: "", quote: "b", file: "" },
        { docId: "members", docTitle: "", quote: "c", file: "" },
        { docId: "billing", docTitle: "", quote: "d", file: "" },
        { docId: "unknown-doc", docTitle: "", quote: "e", file: "" },
      ],
    }),
    docs,
  );
  assert.deepEqual(unreviewed, [
    { docId: "invite", title: "invite の機能", status: "draft" },
    { docId: "billing", title: "billing の機能", status: "stale" },
  ]);
});

test("verdict を書かない答え（説明を求める質問）は null になる", () => {
  const parsed = AskAnswer.parse({
    grounding: "answered",
    confidence: 1,
    headline: "h",
    answer: "a",
    citations: [{ docId: "invite", quote: "q" }],
  });
  assert.equal(parsed.verdict, null);
});
