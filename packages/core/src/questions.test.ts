import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatQuestion, verifyQuestionEvidence } from "./questions.ts";
import { FeatureDocBody, type OpenQuestion } from "./types.ts";

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-bridge-questions-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.go"), "package a\n");
  writeFileSync(join(root, "src", "b.go"), "package b\n");
  return root;
}

function body(openQuestions: OpenQuestion[]): FeatureDocBody {
  return FeatureDocBody.parse({ title: "t", summary: "s", overview: "o", openQuestions });
}

const intent = (question: string, searched: string[]): OpenQuestion => ({
  question,
  kind: "intent",
  searched,
});

test("実際に開いたファイルを挙げた「聞くべきこと」はそのまま残る", () => {
  const repo = fixtureRepo();
  const result = verifyQuestionEvidence(
    body([intent("上書きは意図か", ["src/a.go"])]),
    repo,
    [join(repo, "src", "a.go")],
  );
  assert.deepEqual(result.downgraded, []);
  assert.deepEqual(result.body.openQuestions[0], intent("上書きは意図か", ["src/a.go"]));
});

test("探した箇所を挙げていない「聞くべきこと」は未調査に格下げする", () => {
  const repo = fixtureRepo();
  const result = verifyQuestionEvidence(body([intent("既定値は", [])]), repo, []);
  assert.deepEqual(result.downgraded, ["既定値は"]);
  assert.equal(result.body.openQuestions[0]?.kind, "unverified");
});

test("開いていないファイルを挙げても探した証拠にならない", () => {
  const repo = fixtureRepo();
  const result = verifyQuestionEvidence(
    body([intent("意図は", ["src/a.go"])]),
    repo,
    [join(repo, "src", "b.go")],
  );
  assert.equal(result.body.openQuestions[0]?.kind, "unverified");
  assert.deepEqual(result.body.openQuestions[0]?.searched, []);
});

test("実在しないファイル・リポジトリ外のパスは落とし、残った証拠だけを添える", () => {
  const repo = fixtureRepo();
  const result = verifyQuestionEvidence(
    body([intent("意図は", ["src/a.go:12", "src/nope.go", "../../etc/passwd", "src/a.go"])]),
    repo,
    ["src/a.go", "src/nope.go", "../../etc/passwd"],
  );
  assert.deepEqual(result.downgraded, []);
  // 行番号を外して重複をまとめる
  assert.deepEqual(result.body.openQuestions[0]?.searched, ["src/a.go"]);
});

test("ディレクトリを挙げても探した証拠にならない（Grep の検索範囲だけでは開いたと言えない）", () => {
  const repo = fixtureRepo();
  const result = verifyQuestionEvidence(body([intent("意図は", ["src"])]), repo, ["src"]);
  assert.equal(result.body.openQuestions[0]?.kind, "unverified");
});

test("未調査・範囲のメモは検証の対象外で、そのまま残る", () => {
  const repo = fixtureRepo();
  const questions: OpenQuestion[] = [
    { question: "既定値は", kind: "unverified", searched: [] },
    { question: "分けるべきか", kind: "scope", searched: [] },
  ];
  const result = verifyQuestionEvidence(body(questions), repo, []);
  assert.deepEqual(result.downgraded, []);
  assert.deepEqual(result.body.openQuestions, questions);
});

test("聞くべきことには確認した箇所を添え、ほかは本文だけを出す", () => {
  assert.equal(
    formatQuestion(intent("意図は", ["src/a.go", "src/b.go"])),
    "意図は（確認した箇所: `src/a.go`, `src/b.go`）",
  );
  assert.equal(formatQuestion({ question: "既定値は", kind: "unverified", searched: ["x"] }), "既定値は");
});
