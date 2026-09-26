import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConfidenceBreakdown } from "./confidence.ts";
import {
  buildDocsPullRequestBody,
  buildDocsPullRequestTitle,
  type DocChange,
  type DocsPrSource,
} from "./pr-body.ts";
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

/** PR 解析の出どころ。バックフィルの場合は下の「バックフィル」節を参照 */
const source: DocsPrSource = { kind: "pull-request", pr };

const breakdown: ConfidenceBreakdown = {
  score: 0.92,
  sourceValidity: 1,
  readCoverage: 0.8,
  coverageKind: "changed-files",
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
  const title = buildDocsPullRequestTitle(source, [change("invite", "メンバー招待")]);
  assert.match(title, /メンバー招待/);
  assert.match(title, /acme\/backend#482/);
});

test("複数機能なら「ほか N 件」にまとめる", () => {
  const title = buildDocsPullRequestTitle(source, [
    change("a", "招待"),
    change("b", "課金"),
    change("c", "通知"),
  ]);
  assert.match(title, /ほか 2 件/);
});

test("本文に元 PR へのリンクが入る", () => {
  const body = buildDocsPullRequestBody(source, [change("invite", "メンバー招待")]);
  assert.match(body, /github\.com\/acme\/backend\/pull\/482/);
  assert.match(body, /feat: 招待の有効期限を延長/);
});

test("レビュー観点のチェックリストが入る（権限を明示的に挙げる）", () => {
  const body = buildDocsPullRequestBody(source, [change("invite", "メンバー招待")]);
  assert.match(body, /- \[ \] /);
  assert.match(body, /権限/);
  assert.match(body, /出典/);
});

test("確度の内訳が本文に出る（数字だけを見せない）", () => {
  const body = buildDocsPullRequestBody(source, [change("invite", "メンバー招待")]);
  assert.match(body, /0\.92/);
  assert.match(body, /出典の実在/);
  assert.match(body, /変更ファイル読了/);
});

test("警告があれば折りたたみで出す", () => {
  const body = buildDocsPullRequestBody(source, [
    change("invite", "メンバー招待", {
      warnings: [{ kind: "content-shrunk", detail: "仕様項目が 10 → 3 に減りました" }],
    }),
  ]);
  assert.match(body, /<details>/);
  assert.match(body, /仕様項目が 10 → 3 に減りました/);
});

test("警告が無ければ折りたたみを出さない", () => {
  const body = buildDocsPullRequestBody(source, [change("invite", "メンバー招待")]);
  assert.doesNotMatch(body, /<details>/);
});

test("開発者への確認事項はチェックボックスで、種類ごとに出す", () => {
  const c = change("invite", "メンバー招待");
  c.doc.body.openQuestions = [
    { question: "招待メールの再送を上限なしにしている意図は", kind: "intent", searched: ["app/invite.rb"] },
    { question: "再送間隔の既定値", kind: "unverified", searched: [] },
  ];
  const body = buildDocsPullRequestBody(source, [c]);
  assert.match(
    body,
    /\*\*聞くべきこと\*\*\n\n- \[ \] 招待メールの再送を上限なしにしている意図は（確認した箇所: `app\/invite\.rb`）/,
  );
  assert.match(body, /\*\*追加で調べれば埋まる可能性があるもの\*\*\n\n- \[ \] 再送間隔の既定値/);
});

test("未レビューであることが本文に明記される", () => {
  const body = buildDocsPullRequestBody(source, [change("invite", "メンバー招待")]);
  assert.match(body, /draft/);
});

test("複数機能ぶんの見出しが並ぶ", () => {
  const body = buildDocsPullRequestBody(source, [change("a", "招待"), change("b", "課金")]);
  assert.match(body, /## 招待/);
  assert.match(body, /## 課金/);
});

// --- バックフィル（PR に紐づかない出どころ） ---

const backfill: DocsPrSource = {
  kind: "backfill",
  repo: "acme/backend",
  sha: "9fbe1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b",
  surveyed: 8,
};

test("バックフィルのタイトルは PR 番号ではなくリポジトリを示す", () => {
  const title = buildDocsPullRequestTitle(backfill, [change("invite", "メンバー招待")]);
  assert.equal(title, "docs: メンバー招待（acme/backend のバックフィル）");
});

// PR が無いぶん、「どの状態のコードを読んだか」がレビューの前提になる
test("バックフィルの本文は起点のコミットと件数を出す", () => {
  const body = buildDocsPullRequestBody(backfill, [change("invite", "メンバー招待")]);
  assert.match(body, /いまのコードから/);
  assert.match(body, /9fbe1c2/);
  assert.match(body, /列挙 8 件 \/ 生成 8 件/);
  assert.doesNotMatch(body, /のマージに伴い/);
});

test("起点のコミットが分からない場合はその旨を書く（嘘の起点を書かない）", () => {
  const body = buildDocsPullRequestBody({ ...backfill, sha: null }, [change("invite", "招待")]);
  assert.match(body, /コミットに紐づいていません/);
});

// 途中で終わったランを「全機能そろった」と誤読させない
test("失敗があれば件数と警告を出す", () => {
  const body = buildDocsPullRequestBody({ ...backfill, failed: 3 }, [change("invite", "招待")]);
  assert.match(body, /列挙 8 件 \/ 生成 5 件 \/ \*\*失敗 3 件\*\*/);
  assert.match(body, /全機能を網羅していません/);
});

test("失敗が無ければ警告は出さない", () => {
  const body = buildDocsPullRequestBody(backfill, [change("invite", "招待")]);
  assert.doesNotMatch(body, /網羅していません/);
});

test("消費量が分かっていれば載せる（実測値の出どころになる）", () => {
  const body = buildDocsPullRequestBody(
    { ...backfill, usage: { costUsd: 13.6, agentRuns: 9, elapsedMs: 38 * 60_000 } },
    [change("invite", "招待")],
  );
  assert.match(body, /38分0秒/);
  assert.match(body, /\$13\.60/);
});

// レビュー観点や確度の内訳は出どころによらず同じであること
test("バックフィルでもレビュー観点と確度の内訳は出る", () => {
  const body = buildDocsPullRequestBody(backfill, [change("invite", "招待")]);
  assert.match(body, /レビューしてほしいこと/);
  assert.match(body, /確度 0\.92/);
  assert.match(body, /status: draft/);
});

// 全機能が失敗したランでも呼ばれうる。実際に `docs: undefined ほか -1 件` が出た
test("変更が0件でも壊れたタイトルを作らない", () => {
  assert.equal(buildDocsPullRequestTitle(backfill, []), "docs: acme/backend のバックフィル");
  assert.equal(buildDocsPullRequestTitle(source, []), "docs: acme/backend#482");
});
