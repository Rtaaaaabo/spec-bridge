import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, isTransient } from "./retry.ts";

// 実測で踏んだ「待てば通る」失敗。ここを外すと、上限に当たった機能が拾い直されない
test("待てば直るものを再試行の対象とみなす", () => {
  assert.equal(isTransient(new Error("You've hit your session limit · resets 10:40pm")), true);
  assert.equal(isTransient(new Error("API rate limit exceeded")), true);
  assert.equal(isTransient(new Error("overloaded_error")), true);
  assert.equal(isTransient(new Error("socket hang up")), true);
  assert.equal(isTransient(Object.assign(new Error("Too Many Requests"), { status: 429 })), true);
  assert.equal(isTransient(Object.assign(new Error("Bad Gateway"), { status: 502 })), true);
});

// 何度やっても直らないものに課金し続けないための線引き
test("直らないものは再試行しない", () => {
  assert.equal(isTransient(new Error("Not Found")), false);
  assert.equal(isTransient(Object.assign(new Error("Not Found"), { status: 404 })), false);
  assert.equal(isTransient(Object.assign(new Error("Bad credentials"), { status: 401 })), false);
  assert.equal(isTransient(new Error("更新されたドキュメントがありません")), false);
  assert.equal(isTransient(null), false);
});

test("待ち時間は試行ごとに伸び、上限で頭打ちになる", () => {
  const noJitter = { random: () => 0.5, baseMs: 1000, maxMs: 10_000 };
  assert.equal(backoffMs(1, noJitter), 1000);
  assert.equal(backoffMs(2, noJitter), 2000);
  assert.equal(backoffMs(3, noJitter), 4000);
  assert.equal(backoffMs(10, noJitter), 10_000);
});

// 同じ上限に当たったジョブが揃って再試行し、また全滅するのを避ける
test("ジッタで待ち時間がばらける", () => {
  const options = { baseMs: 1000, maxMs: 10_000 };
  assert.equal(backoffMs(1, { ...options, random: () => 0 }), 750);
  assert.equal(backoffMs(1, { ...options, random: () => 1 }), 1250);
});
