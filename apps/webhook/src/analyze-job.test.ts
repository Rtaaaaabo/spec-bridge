import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeDedupeKey, analyzeJob, parseAnalyzePayload } from "./analyze-job.ts";

const event = {
  repo: "acme/backend",
  number: 42,
  mergeCommitSha: "abc123",
  installationId: 999,
};

// 202 を先に返すので GitHub は再送しうるし、手動 Redeliver もある。
// 同じ鍵なら積まれない = docs リポジトリに PR が2つできない
test("同じマージなら同じ鍵になる", () => {
  assert.equal(analyzeDedupeKey(event), analyzeDedupeKey({ ...event }));
  assert.equal(analyzeDedupeKey({ ...event, repo: "Acme/Backend" }), analyzeDedupeKey(event));
});

test("同じ PR でもマージコミットが違えば別の仕事", () => {
  assert.notEqual(analyzeDedupeKey({ ...event, mergeCommitSha: "def456" }), analyzeDedupeKey(event));
});

test("イベントを payload に載せて往復できる", () => {
  const job = analyzeJob(event);
  assert.equal(job.kind, "analyze.pr");
  assert.equal(job.tenantId, "local");
  assert.deepEqual(parseAnalyzePayload(job.payload), event);
});

test("マージコミットが無くても往復できる", () => {
  const withoutSha = { ...event, mergeCommitSha: null, installationId: null };
  assert.deepEqual(parseAnalyzePayload(analyzeJob(withoutSha).payload), withoutSha);
});

// payload は DB から来る（別プロセスが書いた、古い形かもしれない値）
test("壊れた payload は投げて止める", () => {
  assert.throws(() => parseAnalyzePayload({}), /解釈できません/);
  assert.throws(() => parseAnalyzePayload({ repo: "acme/backend" }), /解釈できません/);
  assert.throws(() => parseAnalyzePayload({ repo: "backend", number: 1 }), /解釈できません/);
  assert.throws(() => parseAnalyzePayload({ repo: "acme/backend", number: "1" }), /解釈できません/);
});
