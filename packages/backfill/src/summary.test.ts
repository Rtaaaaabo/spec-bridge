import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "@spec-bridge/jobs";
import { progressLabel, summarizeRuns } from "./summary.ts";

let sequence = 0;
function job(overrides: Partial<Job> & Pick<Job, "kind">): Job {
  sequence += 1;
  const at = new Date(Date.UTC(2026, 8, 27, 0, sequence));
  return {
    id: `job-${sequence}`,
    tenantId: "local",
    dedupeKey: `key-${sequence}`,
    payload: { runId: "run-1", repo: "acme/backend", docsRepo: "acme/specs", branch: "b", budgetUsd: 10 },
    state: "succeeded",
    attempts: 1,
    maxAttempts: 5,
    runAfter: at,
    leaseUntil: null,
    lastError: null,
    result: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

test("ジョブをランにまとめる", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 2, costUsd: 0.27 } }),
    job({ kind: "backfill.feature", result: { docId: "a", costUsd: 0.51 } }),
    job({ kind: "backfill.feature", result: { docId: "b", costUsd: 0.3 } }),
    job({ kind: "backfill.finish", result: { prUrl: "https://example.com/pr/5" } }),
  ]);

  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.repo, "acme/backend");
  assert.equal(run.state, "succeeded");
  assert.equal(run.surveyed, 2);
  assert.equal(run.done, 2);
  assert.equal(Number(run.costUsd.toFixed(2)), 1.08, "列挙のぶんも足す");
  assert.equal(run.prUrl, "https://example.com/pr/5");
});

test("PR が出るまでは実行中とみなす", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 3 } }),
    job({ kind: "backfill.feature" }),
    job({ kind: "backfill.feature", state: "running" }),
    job({ kind: "backfill.finish", state: "queued" }),
  ]);
  assert.equal(runs[0]?.state, "running");
  assert.equal(runs[0]?.pending, 1);
});

// 全部すでにドキュメントがあるときは、仕上げも PR も作らずに終わる。ずっと「実行中」に見せない
test("書く機能が無かったランは、PR が無くても終わったとみなす", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 0, alreadyDocumented: ["invite"] } }),
  ]);
  assert.equal(runs[0]?.state, "succeeded");
  assert.equal(runs[0]?.prUrl, null);
  assert.equal(progressLabel(runs[0]!), "対象なし");
});

test("列挙がまだ終わっていなければ、0件でも実行中のまま", () => {
  const runs = summarizeRuns([job({ kind: "backfill.survey", state: "running", result: null })]);
  assert.equal(runs[0]?.state, "running");
});

// 予算で打ち切ったランを「全部書けた」と見せない
test("予算超過で打ち切ったランはそうと分かる", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 3, costUsd: 0.2 } }),
    job({ kind: "backfill.feature", result: { docId: "a", costUsd: 9.9 } }),
    job({ kind: "backfill.feature", result: { skipped: "over-budget", costUsd: 0 } }),
    job({ kind: "backfill.finish", result: { prUrl: "https://example.com/pr/6" } }),
  ]);
  assert.equal(runs[0]?.state, "over-budget");
  assert.equal(runs[0]?.skipped, 1);
});

test("列挙に失敗したランは失敗として出す", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", state: "failed", lastError: "Not Found" }),
  ]);
  assert.equal(runs[0]?.state, "failed");
  assert.equal(runs[0]?.lastError, "Not Found");
});

test("機能の失敗は件数に出るが、ラン自体は PR まで進む", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 2 } }),
    job({ kind: "backfill.feature", state: "failed", lastError: "session limit" }),
    job({ kind: "backfill.feature", result: { docId: "b" } }),
    job({ kind: "backfill.finish", result: { prUrl: "https://example.com/pr/7" } }),
  ]);
  assert.equal(runs[0]?.state, "succeeded");
  assert.equal(runs[0]?.failed, 1);
  assert.equal(runs[0]?.lastError, "session limit");
});

test("複数のランを混ぜても取り違えない（新しい順）", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", payload: { runId: "old", repo: "a/b", docsRepo: "a/c", branch: "x" } }),
    job({ kind: "backfill.survey", payload: { runId: "new", repo: "d/e", docsRepo: "a/c", branch: "y" } }),
  ]);
  assert.deepEqual(runs.map((r) => r.runId), ["new", "old"]);
  assert.equal(runs[0]?.repo, "d/e");
});

test("ラン以外のジョブ（PR 解析）は混ざらない", () => {
  const runs = summarizeRuns([
    job({ kind: "analyze.pr", payload: { runId: "run-1", repo: "acme/backend" } }),
  ]);
  assert.equal(runs.length, 0);
});

test("進み具合の表示", () => {
  const [run] = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 8 } }),
    job({ kind: "backfill.feature" }),
    job({ kind: "backfill.feature", state: "running" }),
  ]);
  assert.equal(progressLabel(run!), "1 / 8 機能");
});

test("列挙が終わる前は「列挙中」と出す（0/0 と出さない）", () => {
  const [run] = summarizeRuns([job({ kind: "backfill.survey", state: "running" })]);
  assert.equal(progressLabel(run!), "列挙中…");
});

// 仕上げジョブの結果にはラン全体の集計が入る。足すと二重計上になる（実データで $1.08 が $1.89 になった）
test("仕上げジョブの費用を二重に数えない", () => {
  const runs = summarizeRuns([
    job({ kind: "backfill.survey", result: { surveyed: 2, costUsd: 0.27 } }),
    job({ kind: "backfill.feature", result: { docId: "a", costUsd: 0.51 } }),
    job({ kind: "backfill.feature", result: { docId: "b", costUsd: 0.3 } }),
    // 古い形（PR #9 より前）は costUsd という名前でラン合計を持っている
    job({ kind: "backfill.finish", result: { prUrl: "https://example.com/pr/5", costUsd: 0.81 } }),
  ]);
  assert.equal(Number(runs[0]!.costUsd.toFixed(2)), 1.08);
});
