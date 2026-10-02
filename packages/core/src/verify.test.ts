import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocFile } from "./markdown.ts";
import type { FeatureDoc } from "./types.ts";
import { markVerified, verifiedFiles } from "./verify.ts";

function doc(id: string, status: FeatureDoc["meta"]["status"] = "draft"): FeatureDoc {
  return {
    meta: {
      id,
      status,
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-08-01",
      updatedByPRs: [],
      confidence: 0.9,
    },
    body: {
      title: `${id} の機能`,
      summary: `${id} の要約`,
      overview: "概要",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [{ text: "ルール", sources: [{ repo: "acme/backend", file: "a.ts", line: 1, pr: null }] }],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
    },
    changelog: [{ date: "2026-08-01", summary: "作成", pr: null }],
  };
}

test("レビュー済にし、誰がいつ確かめたかを変更履歴に残す", () => {
  const result = markVerified(doc("invite"), { login: "alice", date: "2026-10-02" });
  assert.equal(result.meta.status, "verified");
  assert.deepEqual(result.changelog.at(-1), {
    date: "2026-10-02",
    summary: "@alice がレビュー済にした",
    pr: null,
  });
  assert.equal(result.changelog.length, 2, "既存の履歴は残す");
});

// updatedAt は「仕様がいつ変わったか」。レビューは内容を変えない
test("最終更新日は変えない", () => {
  const result = markVerified(doc("invite"), { login: "alice", date: "2026-10-02" });
  assert.equal(result.meta.updatedAt, "2026-08-01");
});

test("要更新（stale）からもレビュー済にできる", () => {
  const result = markVerified(doc("invite", "stale"), { login: "alice", date: "2026-10-02" });
  assert.equal(result.meta.status, "verified");
});

test("元のドキュメントは書き換えない", () => {
  const original = doc("invite");
  markVerified(original, { login: "alice", date: "2026-10-02" });
  assert.equal(original.meta.status, "draft");
  assert.equal(original.changelog.length, 1);
});

// 本体だけ変えると、一覧が「AI生成」のまま食い違う
test("本体と、一覧・確認事項ページを一緒に書き換える", () => {
  const all = [doc("a-feature"), doc("invite")];
  const verified = markVerified(all[1]!, { login: "alice", date: "2026-10-02" });
  const files = verifiedFiles(all, verified);

  assert.deepEqual(
    files.map((f) => f.path),
    ["features/invite.md", "README.md", "open-questions.md"],
  );
  assert.equal(parseDocFile(files[0]!.content)?.meta.status, "verified");

  const index = files[1]!.content;
  assert.match(index, /\[invite の機能\]\(features\/invite\.md\) \| ✅ 確認済/);
  assert.match(index, /\[a-feature の機能\]\(features\/a-feature\.md\) \| 📝 AI生成/, "他の機能はそのまま");
});
