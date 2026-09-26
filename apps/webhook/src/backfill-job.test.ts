import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryJobStore } from "@spec-bridge/jobs";
import type { SurveyedFeature } from "@spec-bridge/core";
import {
  DEFAULT_BUDGET_USD,
  runElapsedMs,
  surveyJob as makeSurveyJob,
  featureJob,
  finishJob,
  parseRun,
  readyToFinish,
  runProgress,
  surveyJob,
  withinBudget,
  type BackfillRun,
} from "./backfill-job.ts";

const run: BackfillRun = {
  runId: "run-1",
  repo: "acme/backend",
  docsRepo: "acme/specs",
  branch: "spec-bridge/backfill-backend-run-1",
  limit: 5,
  budgetUsd: 10,
};

const feature: SurveyedFeature = {
  docId: null,
  newDocId: "post-visibility",
  title: "投稿の公開範囲",
  why: "権限に関わる",
  entryPoints: ["app/posts.ts"],
};

// --- 鍵（同じ仕事を二度積まない） ---

test("ランの3種類は別々の鍵を持つ", () => {
  const keys = new Set([
    surveyJob(run).dedupeKey,
    featureJob(run, feature, { index: 1, total: 3 }, null).dedupeKey,
    finishJob(run, { surveyed: 3, sha: null }).dedupeKey,
  ]);
  assert.equal(keys.size, 3);
});

test("同じランの同じ機能は同じ鍵（二度書かない）", () => {
  const a = featureJob(run, feature, { index: 1, total: 3 }, "abc");
  const b = featureJob(run, feature, { index: 2, total: 3 }, "abc");
  assert.equal(a.dedupeKey, b.dedupeKey);
});

test("ランが違えば同じ機能でも別の仕事", () => {
  const other = featureJob({ ...run, runId: "run-2" }, feature, { index: 1, total: 3 }, null);
  assert.notEqual(other.dedupeKey, featureJob(run, feature, { index: 1, total: 3 }, null).dedupeKey);
});

// --- payload（DB から来る値なので検証する） ---

test("payload からランを復元できる", () => {
  assert.deepEqual(parseRun(surveyJob(run).payload), run);
});

test("予算と上限が欠けていたら既定値で補う", () => {
  const restored = parseRun({ runId: "r", repo: "a/b", docsRepo: "a/c", branch: "x" });
  assert.equal(restored.budgetUsd, DEFAULT_BUDGET_USD);
  assert.equal(restored.limit, 20);
});

test("壊れた payload は投げて止める", () => {
  assert.throws(() => parseRun({}), /解釈できません/);
  assert.throws(() => parseRun({ runId: "r", repo: "a/b" }), /解釈できません/);
});

// --- 予算（1機能 約 $1.7。歯止めが無いと1回のクリックで青天井になる） ---

const progressOf = (overrides: Partial<Parameters<typeof withinBudget>[0]> = {}) => ({
  done: 0,
  failed: 0,
  pending: 0,
  costUsd: 0,
  agentRuns: 0,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

test("使った額が上限未満なら続ける", () => {
  assert.equal(withinBudget(progressOf({ done: 3, pending: 2, costUsd: 5.1 }), 10), true);
});

test("上限に達したら書かない", () => {
  assert.equal(withinBudget(progressOf({ done: 6, pending: 1, costUsd: 10 }), 10), false);
  assert.equal(withinBudget(progressOf({ done: 7, pending: 1, costUsd: 11.9 }), 10), false);
});

// --- 仕上げの待ち合わせ（ワーカーが複数いると完了順は保証されない） ---

test("残っている機能があるあいだは仕上げない", () => {
  assert.equal(readyToFinish(progressOf({ done: 2, pending: 1, costUsd: 3 })), false);
});

test("失敗も「終わった」として扱う（1件の失敗で PR を出せなくしない）", () => {
  assert.equal(readyToFinish(progressOf({ done: 2, failed: 1, costUsd: 3 })), true);
});

// --- 進み具合の集計（ラン専用の表を持たず、兄弟ジョブから数える） ---

test("兄弟ジョブから、成功・失敗・残り・費用を数える", async () => {
  const store = new MemoryJobStore();

  const a = await store.enqueue(featureJob(run, feature, { index: 1, total: 3 }, null));
  const b = await store.enqueue(
    featureJob(run, { ...feature, newDocId: "friends" }, { index: 2, total: 3 }, null),
  );
  await store.enqueue(
    featureJob(run, { ...feature, newDocId: "billing" }, { index: 3, total: 3 }, null),
  );
  // 別のランのジョブは数に入れない
  await store.enqueue(
    featureJob({ ...run, runId: "run-2" }, feature, { index: 1, total: 1 }, null),
  );

  await store.claim({ leaseMs: 1000 });
  await store.succeed(a.job.id, { docId: "post-visibility", costUsd: 1.7 });
  await store.claim({ leaseMs: 1000 });
  await store.fail(b.job.id, "session limit");

  const progress = await runProgress(store, "run-1");
  assert.equal(progress.done, 1);
  assert.equal(progress.failed, 1);
  assert.equal(progress.pending, 1);
  assert.equal(progress.costUsd, 1.7);
});

// 実測を外に出す数字なので、列挙のぶんを落とさない（PR 本文に $0.27 が載っていなかった）
test("列挙（survey）の費用と呼び出し回数もランの合計に入る", async () => {
  const store = new MemoryJobStore();
  const survey = await store.enqueue(makeSurveyJob(run));
  await store.claim({ leaseMs: 1000 });
  await store.succeed(survey.job.id, { surveyed: 2, costUsd: 0.27, agentRuns: 1 });

  const f = await store.enqueue(featureJob(run, feature, { index: 1, total: 1 }, null));
  await store.claim({ leaseMs: 1000 });
  await store.succeed(f.job.id, { docId: "post-visibility", costUsd: 0.51, agentRuns: 3 });

  const progress = await runProgress(store, "run-1");
  assert.equal(Number(progress.costUsd.toFixed(2)), 0.78);
  assert.equal(progress.agentRuns, 4, "ジョブ数ではなくエージェントの呼び出し回数");
  assert.equal(progress.done, 1, "件数は機能ジョブだけを数える");
  assert.ok(progress.startedAt, "所要時間の起点として列挙ジョブの時刻を持つ");
});

test("予算超過でスキップした機能は費用を積まない", async () => {
  const store = new MemoryJobStore();
  const { job } = await store.enqueue(featureJob(run, feature, { index: 1, total: 1 }, null));
  await store.claim({ leaseMs: 1000 });
  await store.succeed(job.id, { skipped: "over-budget", costUsd: 0 });

  const progress = await runProgress(store, "run-1");
  assert.equal(progress.costUsd, 0);
  assert.equal(progress.done, 1);
});

// 仕上げが待ち合わせや再試行で遅れても、所要時間が水増しされないこと
test("所要時間は、開始から最後に動いた仕事までで測る", () => {
  const startedAt = new Date("2026-09-26T00:00:00Z");
  const finishedAt = new Date("2026-09-26T00:05:00Z");
  assert.equal(runElapsedMs(progressOf({ startedAt, finishedAt })), 5 * 60_000);
});

test("起点か終点が分からなければ 0（推測で時間を作らない）", () => {
  assert.equal(runElapsedMs(progressOf({ startedAt: new Date() })), 0);
  assert.equal(runElapsedMs(progressOf()), 0);
});
