import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConfidenceBreakdown } from "./confidence.ts";
import { buildDocsPullRequestBody, buildDocsPullRequestTitle, type DocChange } from "./pr-body.ts";
import type { FeatureDoc, PullRequestInput } from "./types.ts";

const pr: PullRequestInput = {
  repo: "acme/backend",
  number: 482,
  title: "feat: 招待の有効期限を延長",
  body: "",
  author: "dev",
  branch: "feature/PROJ-1",
  mergedAt: "2026-08-01T00:00:00Z",
  changedFiles: [],
};

const breakdown: ConfidenceBreakdown = {
  score: 0.92,
  sourceValidity: 1,
  readCoverage: 0.8,
  citationDensity: 1,
  determinacy: 0.75,
  selfReported: 0.8,
};

function change(id: string, title: string, overrides: Partial<DocChange> = {}): DocChange {
  const doc: FeatureDoc = {
    meta: {
      id,
      status: "draft",
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-08-01",
      updatedByPRs: [],
      confidence: 0.92,
    },
    body: {
      title,
      summary: `${title}の要約`,
      overview: "",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [
        { text: "ルール", sources: [{ repo: "acme/backend", file: "a.ts", line: 1, pr: null }] },
      ],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: ["n"], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
    },
    changelog: [],
  };
  return { doc, breakdown, warnings: [], ...overrides };
}

test("タイトルに機能名と元 PR が入る", () => {
  const title = buildDocsPullRequestTitle(pr, [change("invite", "メンバー招待")]);
  assert.match(title, /メンバー招待/);
  assert.match(title, /acme\/backend#482/);
});

test("複数機能なら「ほか N 件」にまとめる", () => {
  const title = buildDocsPullRequestTitle(pr, [
    change("a", "招待"),
    change("b", "課金"),
    change("c", "通知"),
  ]);
  assert.match(title, /ほか 2 件/);
});

test("本文に元 PR へのリンクが入る", () => {
  const body = buildDocsPullRequestBody(pr, [change("invite", "メンバー招待")]);
  assert.match(body, /github\.com\/acme\/backend\/pull\/482/);
  assert.match(body, /feat: 招待の有効期限を延長/);
});

test("レビュー観点のチェックリストが入る（権限を明示的に挙げる）", () => {
  const body = buildDocsPullRequestBody(pr, [change("invite", "メンバー招待")]);
  assert.match(body, /- \[ \] /);
  assert.match(body, /権限/);
  assert.match(body, /出典/);
});

test("確度の内訳が本文に出る（数字だけを見せない）", () => {
  const body = buildDocsPullRequestBody(pr, [change("invite", "メンバー招待")]);
  assert.match(body, /0\.92/);
  assert.match(body, /出典の実在/);
  assert.match(body, /変更ファイル読了/);
});

test("警告があれば折りたたみで出す", () => {
  const body = buildDocsPullRequestBody(pr, [
    change("invite", "メンバー招待", {
      warnings: [{ kind: "content-shrunk", detail: "仕様項目が 10 → 3 に減りました" }],
    }),
  ]);
  assert.match(body, /<details>/);
  assert.match(body, /仕様項目が 10 → 3 に減りました/);
});

test("警告が無ければ折りたたみを出さない", () => {
  const body = buildDocsPullRequestBody(pr, [change("invite", "メンバー招待")]);
  assert.doesNotMatch(body, /<details>/);
});

test("開発者への確認事項はチェックボックスで出す", () => {
  const c = change("invite", "メンバー招待");
  c.doc.body.openQuestions = ["招待メールの再送仕様が不明"];
  const body = buildDocsPullRequestBody(pr, [c]);
  assert.match(body, /- \[ \] 招待メールの再送仕様が不明/);
});

test("未レビューであることが本文に明記される", () => {
  const body = buildDocsPullRequestBody(pr, [change("invite", "メンバー招待")]);
  assert.match(body, /draft/);
});

test("複数機能ぶんの見出しが並ぶ", () => {
  const body = buildDocsPullRequestBody(pr, [change("a", "招待"), change("b", "課金")]);
  assert.match(body, /## 招待/);
  assert.match(body, /## 課金/);
});
