import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithConcurrency } from "./concurrency.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("すべて処理し、結果は入力の順に並ぶ", async () => {
  const result = await runWithConcurrency(
    ["a", "b", "c"],
    async (item) => {
      await tick();
      return item.toUpperCase();
    },
    { limit: 2 },
  );
  assert.deepEqual(result.completed.map((c) => c.value), ["A", "B", "C"]);
  assert.equal(result.failed.length, 0);
});

test("同時実行数を超えない", async () => {
  let running = 0;
  let peak = 0;
  await runWithConcurrency(
    [1, 2, 3, 4, 5, 6],
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    },
    { limit: 2 },
  );
  assert.equal(peak, 2);
});

test("limit が1なら直列（いまの挙動と同じ）", async () => {
  let peak = 0;
  let running = 0;
  await runWithConcurrency(
    [1, 2, 3],
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    },
    { limit: 1 },
  );
  assert.equal(peak, 1);
});

// 分類は影響の大きい順。打ち切るなら末尾から落ちてほしい
test("入力の順に始める", async () => {
  const started: number[] = [];
  await runWithConcurrency([0, 1, 2, 3], async () => await tick(), {
    limit: 2,
    onStart: (_item, index) => started.push(index),
  });
  assert.deepEqual(started, [0, 1, 2, 3]);
});

// 直列のときと同じく、1件失敗しても書けたものは残す
test("1件失敗しても他は続く", async () => {
  const result = await runWithConcurrency(
    ["ok1", "ng", "ok2"],
    async (item) => {
      await tick();
      if (item === "ng") throw new Error("boom");
      return item;
    },
    { limit: 2 },
  );
  assert.deepEqual(result.completed.map((c) => c.value), ["ok1", "ok2"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.item, "ng");
});

test("打ち切ると、まだ始めていないものが残る", async () => {
  let done = 0;
  const result = await runWithConcurrency(
    [1, 2, 3, 4, 5],
    async () => {
      await tick();
      done += 1;
    },
    { limit: 1, shouldStop: () => done >= 2 },
  );
  assert.equal(result.completed.length, 2);
  assert.deepEqual(result.notStarted, [3, 4, 5]);
});

// 走っている途中の処理は止めない（止めても費用は戻らない）
test("打ち切りは実行中の仕事を止めない", async () => {
  let finished = 0;
  const result = await runWithConcurrency(
    [1, 2, 3, 4],
    async () => {
      await tick();
      finished += 1;
    },
    { limit: 2, shouldStop: () => finished >= 1 },
  );
  assert.equal(finished, result.completed.length);
  assert.ok(result.completed.length >= 2, "同時に始まった2件は最後まで走る");
});

test("空でも落ちない", async () => {
  const result = await runWithConcurrency([], async () => 1, { limit: 3 });
  assert.deepEqual(result, { completed: [], failed: [], notStarted: [] });
});
