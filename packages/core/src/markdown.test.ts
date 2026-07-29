import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocFile, renderDocFile, renderMarkdown } from "./markdown.ts";
import type { FeatureDoc } from "./types.ts";

function doc(overrides: Partial<FeatureDoc> = {}): FeatureDoc {
  return {
    meta: {
      id: "sample-feature",
      status: "draft",
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-07-29",
      updatedByPRs: ["acme/backend#1"],
      confidence: 0.7,
      ...overrides.meta,
    },
    body: {
      title: "サンプル機能",
      summary: "要約",
      overview: "概要",
      userBehavior: ["ユーザーはこうする"],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [
        {
          text: "上限は5回。",
          sources: [{ repo: "acme/backend", file: "src/a.ts", line: 42, pr: "acme/backend#1" }],
        },
      ],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
      ...overrides.body,
    },
    changelog: overrides.changelog ?? [],
  };
}

test("render → parse でラウンドトリップする", () => {
  const original = doc();
  const parsed = parseDocFile(renderDocFile(original));
  assert.ok(parsed, "パースに失敗した");
  assert.equal(parsed.meta.id, original.meta.id);
  assert.equal(parsed.body.rules[0]?.text, "上限は5回。");
  assert.equal(parsed.body.rules[0]?.sources[0]?.line, 42);
});

test("同じ入力からは常に同じバイト列を生成する（docs リポジトリの diff を安定させるため）", () => {
  const d = doc();
  assert.equal(renderDocFile(d), renderDocFile(d));
});

test("出典が脚注として本文に現れる", () => {
  const md = renderMarkdown(doc());
  assert.match(md, /上限は5回。\[\^1\]/);
  assert.match(md, /\[\^1\]: `acme\/backend` `src\/a\.ts:42` \(acme\/backend#1\)/);
});

test("同一の出典は同じ脚注番号にまとめられる", () => {
  const source = { repo: "acme/backend", file: "src/a.ts", line: 1, pr: null };
  const md = renderMarkdown(
    doc({
      body: {
        ...doc().body,
        rules: [
          { text: "ルールA", sources: [source] },
          { text: "ルールB", sources: [source] },
        ],
      },
    }),
  );
  assert.match(md, /ルールA\[\^1\]/);
  assert.match(md, /ルールB\[\^1\]/);
  assert.doesNotMatch(md, /\[\^2\]/);
});

test("表のセルに含まれるパイプがエスケープされる（表崩れ防止）", () => {
  const md = renderMarkdown(
    doc({
      body: {
        ...doc().body,
        screens: [
          {
            name: "設定 | 請求",
            path: "/settings",
            repo: "acme/frontend",
            file: null,
            description: "説明",
          },
        ],
      },
    }),
  );
  assert.match(md, /設定 \\\| 請求/);
});

test("spec-bridge:data ブロックが壊れているファイルは null を返す", () => {
  const broken = renderDocFile(doc()).replace("<!-- spec-bridge:data", "<!-- broken");
  assert.equal(parseDocFile(broken), null);
});

test("スキーマ違反のファイル（出典ゼロの仕様項目）は読み込まない", () => {
  const rendered = renderDocFile(doc());
  const tampered = rendered.replace(
    /"sources": \[[\s\S]*?\]/,
    '"sources": []',
  );
  assert.equal(parseDocFile(tampered), null);
});
