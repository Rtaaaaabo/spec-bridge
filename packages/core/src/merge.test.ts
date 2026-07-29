import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzeOutput } from "./analyze.ts";
import { mergeAnalysis } from "./merge.ts";
import type { FeatureDoc, PullRequestInput } from "./types.ts";

const pr: PullRequestInput = {
  repo: "acme/backend",
  number: 7,
  title: "feat: 何か",
  body: "",
  author: "dev",
  branch: "feat/x",
  mergedAt: "2026-07-29T00:00:00Z",
  changedFiles: [],
};

function analysis(overrides: Partial<AnalyzeOutput["body"]> = {}): AnalyzeOutput {
  return {
    changeSummary: "上限を3→5に変更",
    confidence: 0.9,
    body: {
      title: "サンプル機能",
      summary: "要約",
      overview: "概要",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [
        {
          text: "上限は5回。",
          sources: [{ repo: "acme/backend", file: "src/a.ts", line: 42, pr: null }],
        },
      ],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
      ...overrides,
    },
  };
}

test("出典のない仕様項目は書き出さず、警告を返す", () => {
  const input = analysis({
    rules: [
      { text: "根拠あり", sources: [{ repo: "acme/backend", file: "a.ts", line: 1, pr: null }] },
      { text: "根拠なし", sources: [] as never },
    ],
  });
  const { doc, warnings } = mergeAnalysis(null, input, pr, "sample", []);

  assert.equal(doc.body.rules.length, 1);
  assert.equal(doc.body.rules[0]?.text, "根拠あり");
  assert.ok(warnings.some((w) => w.kind === "rule-without-source"));
});

test("レビュー済みのドキュメントは自動更新で draft に戻る", () => {
  const existing: FeatureDoc = {
    meta: {
      id: "sample",
      status: "verified",
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-07-01",
      updatedByPRs: [],
      confidence: 1,
    },
    body: analysis().body,
    changelog: [],
  };

  const { doc, warnings } = mergeAnalysis(existing, analysis(), pr, "sample", []);

  assert.equal(doc.meta.status, "draft");
  assert.ok(warnings.some((w) => w.kind === "status-demoted"));
});

test("変更履歴はツール側が積む（LLM の出力に依存しない）", () => {
  const existing: FeatureDoc = {
    meta: {
      id: "sample",
      status: "draft",
      owners: [],
      repos: [],
      issueKeys: [],
      updatedAt: "2026-07-01",
      updatedByPRs: [],
      confidence: 0.5,
    },
    body: analysis().body,
    changelog: [{ date: "2026-07-01", summary: "初版", pr: "acme/backend#1" }],
  };

  const { doc } = mergeAnalysis(existing, analysis(), pr, "sample", []);

  assert.equal(doc.changelog.length, 2);
  assert.equal(doc.changelog[1]?.summary, "上限を3→5に変更");
  assert.equal(doc.changelog[1]?.pr, "acme/backend#7");
  assert.equal(doc.changelog[1]?.date, "2026-07-29");
});

test("repo が省略された項目は PR のリポジトリで補完される", () => {
  const input = analysis({
    screens: [{ name: "画面", path: "/x", repo: "", file: null, description: "" }],
    endpoints: [{ method: "GET", path: "/api/x", repo: "", file: null, description: "" }],
  });
  const { doc } = mergeAnalysis(null, input, pr, "sample", []);

  assert.equal(doc.body.screens[0]?.repo, "acme/backend");
  assert.equal(doc.body.endpoints[0]?.repo, "acme/backend");
});

test("出典の pr が未指定なら解析元の PR で埋まる", () => {
  const { doc } = mergeAnalysis(null, analysis(), pr, "sample", []);
  assert.equal(doc.body.rules[0]?.sources[0]?.pr, "acme/backend#7");
});

test("仕様項目が大幅に減った場合は警告する（既存記述の消失検知）", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    text: `ルール${i}`,
    sources: [{ repo: "acme/backend", file: "a.ts", line: i + 1, pr: null }],
  }));
  const existing: FeatureDoc = {
    meta: {
      id: "sample",
      status: "draft",
      owners: [],
      repos: [],
      issueKeys: [],
      updatedAt: "2026-07-01",
      updatedByPRs: [],
      confidence: 0.5,
    },
    body: { ...analysis().body, rules: many },
    changelog: [],
  };

  const { warnings } = mergeAnalysis(existing, analysis(), pr, "sample", []);
  assert.ok(warnings.some((w) => w.kind === "content-shrunk"));
});

test("課題キーとリポジトリは既存分とマージされ重複しない", () => {
  const existing: FeatureDoc = {
    meta: {
      id: "sample",
      status: "draft",
      owners: [],
      repos: ["acme/frontend", "acme/backend"],
      issueKeys: ["PROJ-1"],
      updatedAt: "2026-07-01",
      updatedByPRs: [],
      confidence: 0.5,
    },
    body: analysis().body,
    changelog: [],
  };

  const { doc } = mergeAnalysis(existing, analysis(), pr, "sample", ["PROJ-1", "PROJ-2"]);

  assert.deepEqual(doc.meta.repos, ["acme/backend", "acme/frontend"]);
  assert.deepEqual(doc.meta.issueKeys, ["PROJ-1", "PROJ-2"]);
});

// --- マルチリポジトリ ---

const feDoc = (): FeatureDoc => ({
  meta: {
    id: "sample",
    status: "draft",
    owners: [],
    repos: ["acme/frontend"],
    issueKeys: ["PROJ-1"],
    updatedAt: "2026-07-01",
    updatedByPRs: ["acme/frontend#3"],
    confidence: 0.8,
  },
  body: {
    ...analysis().body,
    rules: [
      {
        text: "公開範囲セレクトの初期値は「全員」。",
        sources: [{ repo: "acme/frontend", file: "components/form.tsx", line: 10, pr: null }],
      },
    ],
    screens: [
      { name: "投稿作成", path: "/posts/new", repo: "acme/frontend", file: null, description: "" },
    ],
    permissions: [
      {
        role: "投稿者",
        canDo: "公開範囲を選べる",
        sources: [{ repo: "acme/frontend", file: "components/form.tsx", line: 12, pr: null }],
      },
    ],
  },
  changelog: [],
});

test("他リポジトリ由来の記述は、今回検証できなくても引き継がれる", () => {
  // フロント由来のドキュメントに、バックエンドの PR を適用する
  const { doc, warnings } = mergeAnalysis(feDoc(), analysis(), pr, "sample", []);

  const texts = doc.body.rules.map((r) => r.text);
  assert.ok(texts.includes("公開範囲セレクトの初期値は「全員」。"), "FE 由来の仕様が消えた");
  assert.ok(texts.includes("上限は5回。"), "今回の BE 由来の仕様が入っていない");
  assert.equal(doc.body.screens.length, 1, "FE 由来の画面が消えた");
  assert.equal(doc.body.permissions.length, 1, "FE 由来の権限が消えた");
  assert.ok(warnings.some((w) => w.kind === "foreign-records-restored"));
});

test("同じリポジトリの記述は引き継がず、解析結果で置き換わる（更新が反映される）", () => {
  const existing = feDoc();
  existing.meta.repos = ["acme/backend"];
  existing.body.rules = [
    {
      text: "上限は3回。",
      sources: [{ repo: "acme/backend", file: "src/a.ts", line: 42, pr: null }],
    },
  ];
  existing.body.screens = [];
  existing.body.permissions = [];

  const { doc } = mergeAnalysis(existing, analysis(), pr, "sample", []);

  const texts = doc.body.rules.map((r) => r.text);
  assert.ok(texts.includes("上限は5回。"), "更新後の仕様がない");
  assert.ok(!texts.includes("上限は3回。"), "古い同一リポジトリの仕様が残ってしまっている");
});

test("引き継ぎで重複を作らない（エージェントが既存記述を再出力した場合）", () => {
  const existing = feDoc();
  const reemitted = analysis({
    rules: [
      ...analysis().body.rules,
      // エージェントが既存ドキュメントを見て FE 由来の記述をそのまま再出力したケース
      {
        text: "公開範囲セレクトの初期値は「全員」。",
        sources: [{ repo: "acme/frontend", file: "components/form.tsx", line: 10, pr: null }],
      },
    ],
  });

  const { doc } = mergeAnalysis(existing, reemitted, pr, "sample", []);

  const occurrences = doc.body.rules.filter(
    (r) => r.text === "公開範囲セレクトの初期値は「全員」。",
  ).length;
  assert.equal(occurrences, 1, "同じ記述が重複している");
});

test("前後の空白や改行の差は同一とみなす", () => {
  // LLM の再出力でよくあるのは前後の空白・改行の混入。ここは吸収する。
  // なお言い換え（「上限は5回。」→「上限は5回です。」）は検出できない。
  // その場合は重複したまま docs リポジトリの PR に出るので、人間のレビューで落とす設計。
  const existing = feDoc();
  const reemitted = analysis({
    rules: [
      {
        text: "  公開範囲セレクトの初期値は「全員」。\n",
        sources: [{ repo: "acme/frontend", file: "components/form.tsx", line: 10, pr: null }],
      },
    ],
  });

  const { doc } = mergeAnalysis(existing, reemitted, pr, "sample", []);
  assert.equal(doc.body.rules.length, 1);
});
