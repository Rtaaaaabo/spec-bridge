import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, formatUsageSummary, UsageTally, usageFromResult } from "./usage.ts";

test("result メッセージから推定コストを取る", () => {
  const usage = usageFromResult({ type: "result", subtype: "success", total_cost_usd: 0.42 });
  assert.equal(usage.costUsd, 0.42);
});

test("失敗した呼び出しの result からも費用を取る", () => {
  const usage = usageFromResult({ type: "result", subtype: "error_max_turns", total_cost_usd: 1.5 });
  assert.equal(usage.costUsd, 1.5);
});

test("コストが欠けていれば 0 として数える（推測で水増ししない）", () => {
  assert.equal(usageFromResult({ type: "result" }).costUsd, 0);
  assert.equal(usageFromResult({ type: "result", total_cost_usd: "0.5" }).costUsd, 0);
  assert.equal(usageFromResult({ type: "result", total_cost_usd: Number.NaN }).costUsd, 0);
});

test("呼び出しごとの費用と回数を積み上げ、実時間を測る", () => {
  const tally = new UsageTally(1_000);
  // コールバックとして切り離して渡しても動く（onUsage: tally.add）
  const add = tally.add;
  add({ costUsd: 0.25 });
  add({ costUsd: 1.5 });

  assert.deepEqual(tally.summary(61_000), { costUsd: 1.75, agentRuns: 2, elapsedMs: 60_000 });
});

test("何も呼んでいなければ 0 回・0 ドル", () => {
  const tally = new UsageTally(0);
  assert.deepEqual(tally.summary(0), { costUsd: 0, agentRuns: 0, elapsedMs: 0 });
});

test("所要時間を日本語で表す", () => {
  assert.equal(formatElapsed(0), "0秒");
  assert.equal(formatElapsed(59_400), "59秒");
  assert.equal(formatElapsed(754_000), "12分34秒");
  assert.equal(formatElapsed(3_723_000), "1時間2分3秒");
});

test("結果欄の1行", () => {
  assert.equal(
    formatUsageSummary({ costUsd: 3.214, agentRuns: 11, elapsedMs: 754_000 }),
    "所要時間 12分34秒 / エージェント呼び出し 11 回 / 推定コスト $3.21",
  );
});
