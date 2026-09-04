import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeSurvey, type SurveyedFeature } from "./survey.ts";

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-bridge-survey-"));
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "page.tsx"), "// page");
  writeFileSync(join(root, "app", "actions.ts"), "// actions");
  return root;
}

function feature(overrides: Partial<SurveyedFeature> = {}): SurveyedFeature {
  return {
    docId: null,
    newDocId: "post-visibility",
    title: "投稿の公開範囲",
    why: "問い合わせが来やすい",
    entryPoints: ["app/page.tsx"],
    ...overrides,
  };
}

test("実在する起点ファイルはそのまま残る", () => {
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature({ entryPoints: ["app/page.tsx", "app/actions.ts"] })],
    repo,
    20,
  );

  assert.equal(features.length, 1);
  assert.deepEqual(features[0]?.entryPoints, ["app/page.tsx", "app/actions.ts"]);
  assert.deepEqual(warnings, []);
});

test("実在しない起点ファイルは落とし、警告する", () => {
  // 後段の解析エージェントに存在しないパスを渡すと、探索に turn を浪費する
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature({ entryPoints: ["app/page.tsx", "app/nope.tsx"] })],
    repo,
    20,
  );

  assert.deepEqual(features[0]?.entryPoints, ["app/page.tsx"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /app\/nope\.tsx/);
});

test("起点ファイルが全部消えても機能自体は残す（探索させれば書ける）", () => {
  const repo = fixtureRepo();
  const { features } = normalizeSurvey([feature({ entryPoints: ["nope.ts"] })], repo, 20);

  assert.equal(features.length, 1);
  assert.deepEqual(features[0]?.entryPoints, []);
});

test("リポジトリ外を指す起点ファイルは落とす（パストラバーサル対策）", () => {
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature({ entryPoints: ["../../etc/passwd"] })],
    repo,
    20,
  );

  assert.deepEqual(features[0]?.entryPoints, []);
  assert.equal(warnings.length, 1);
});

test("docId と newDocId が両方 null の項目は落とす（保存先が決まらない）", () => {
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature({ docId: null, newDocId: null }), feature()],
    repo,
    20,
  );

  assert.equal(features.length, 1);
  assert.equal(features[0]?.newDocId, "post-visibility");
  assert.ok(warnings.some((w) => w.includes("両方が null")));
});

test("ID が重複する項目は後勝ちにせず落とす", () => {
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature(), feature({ title: "重複したほう" })],
    repo,
    20,
  );

  assert.equal(features.length, 1);
  assert.equal(features[0]?.title, "投稿の公開範囲");
  assert.ok(warnings.some((w) => w.includes("重複")));
});

test("既存ドキュメントに紐づく項目（docId 指定）も通る", () => {
  const repo = fixtureRepo();
  const { features } = normalizeSurvey(
    [feature({ docId: "existing-feature", newDocId: null })],
    repo,
    20,
  );

  assert.equal(features.length, 1);
  assert.equal(features[0]?.docId, "existing-feature");
});

test("上限を超えた分は切り捨て、警告する", () => {
  const repo = fixtureRepo();
  const many = Array.from({ length: 5 }, (_, i) => feature({ newDocId: `feature-${i}` }));
  const { features, warnings } = normalizeSurvey(many, repo, 3);

  assert.equal(features.length, 3);
  assert.ok(warnings.some((w) => w.includes("上限 3 件")));
});

test("上限ちょうどなら切り捨ての警告は出さない", () => {
  const repo = fixtureRepo();
  const three = Array.from({ length: 3 }, (_, i) => feature({ newDocId: `feature-${i}` }));
  const { features, warnings } = normalizeSurvey(three, repo, 3);

  assert.equal(features.length, 3);
  assert.deepEqual(warnings, []);
});

test("ID に区切り文字が混ざった項目は落とす（解析を走らせる前に弾く）", () => {
  const repo = fixtureRepo();
  const { features, warnings } = normalizeSurvey(
    [feature({ newDocId: "../../escaped" }), feature({ newDocId: "post-visibility" })],
    repo,
    20,
  );

  assert.equal(features.length, 1);
  assert.equal(features[0]?.newDocId, "post-visibility");
  assert.ok(warnings.some((w) => w.includes("ID に使えない文字")));
});

test("既存ドキュメント側の docId も検証する", () => {
  const repo = fixtureRepo();
  const { features } = normalizeSurvey(
    [feature({ docId: "../../escaped", newDocId: null })],
    repo,
    20,
  );
  assert.equal(features.length, 0);
});
