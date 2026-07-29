import assert from "node:assert/strict";
import { test } from "node:test";
import { FeatureDocBody, SourceRef } from "./types.ts";

/**
 * LLM は指示どおりの形で返さないことがある。
 * ここで吸収できる範囲を固定しておかないと、解析結果を丸ごと捨てる事故が起きる。
 */

test("出典が文字列で来ても file:line のオブジェクトに正規化される", () => {
  const parsed = SourceRef.parse("app/models/post.rb:42");
  assert.equal(parsed.file, "app/models/post.rb");
  assert.equal(parsed.line, 42);
  assert.equal(parsed.repo, "");
});

test("出典が行範囲つきの文字列でも開始行を取る", () => {
  const parsed = SourceRef.parse("lib/db.ts:44-51");
  assert.equal(parsed.file, "lib/db.ts");
  assert.equal(parsed.line, 44);
});

test("行番号のない文字列でも壊れない", () => {
  const parsed = SourceRef.parse("README.md");
  assert.equal(parsed.file, "README.md");
  assert.equal(parsed.line, null);
});

test("出典がオブジェクトで来た場合はそのまま通る", () => {
  const parsed = SourceRef.parse({
    repo: "acme/backend",
    file: "a.ts",
    line: 3,
    pr: "acme/backend#1",
  });
  assert.equal(parsed.repo, "acme/backend");
  assert.equal(parsed.line, 3);
});

test("配列であるべき項目が改行区切りの文字列で来ても配列になる", () => {
  const body = FeatureDocBody.parse({
    title: "t",
    summary: "s",
    overview: "o",
    userBehavior: "- 項目A\n- 項目B\n* 項目C",
  });
  assert.deepEqual(body.userBehavior, ["項目A", "項目B", "項目C"]);
});

test("省略されたフィールドは既定値で埋まる", () => {
  const body = FeatureDocBody.parse({ title: "t", summary: "s", overview: "o" });
  assert.deepEqual(body.rules, []);
  assert.deepEqual(body.screens, []);
  assert.deepEqual(body.testPoints.regression, []);
});

test("画面・エンドポイントの repo 省略を許す（単一リポジトリのプロジェクト向け）", () => {
  const body = FeatureDocBody.parse({
    title: "t",
    summary: "s",
    overview: "o",
    screens: [{ name: "画面", path: "/x" }],
    endpoints: [{ method: "GET", path: "/api/x" }],
  });
  assert.equal(body.screens[0]?.repo, "");
  assert.equal(body.endpoints[0]?.repo, "");
});

test("仕様項目は出典なしでは受け付けない（サービスの生命線）", () => {
  const result = FeatureDocBody.safeParse({
    title: "t",
    summary: "s",
    overview: "o",
    rules: [{ text: "根拠のない断定", sources: [] }],
  });
  assert.equal(result.success, false);
});
