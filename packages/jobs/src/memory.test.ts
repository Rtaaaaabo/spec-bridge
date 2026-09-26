import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryJobStore } from "./memory.ts";

const input = (overrides: Partial<Parameters<MemoryJobStore["enqueue"]>[0]> = {}) => ({
  kind: "analyze.pr",
  tenantId: "local",
  dedupeKey: "acme/backend#1:abc",
  payload: { repo: "acme/backend", number: 1 },
  ...overrides,
});

test("同じ鍵の仕事は二度積まない（webhook の再送で PR が2つできない）", async () => {
  const store = new MemoryJobStore();
  const first = await store.enqueue(input());
  const second = await store.enqueue(input());

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
});

test("鍵が違えば別の仕事として積む", async () => {
  const store = new MemoryJobStore();
  await store.enqueue(input());
  const other = await store.enqueue(input({ dedupeKey: "acme/backend#2:def" }));
  assert.equal(other.created, true);
});

// Redeliver で「前回落ちた解析をもう一度」ができないと、手で直す手段が無くなる
test("失敗して終わった仕事は、同じ鍵でも積み直せる", async () => {
  const store = new MemoryJobStore();
  const { job } = await store.enqueue(input());
  await store.claim({ leaseMs: 1000 });
  await store.fail(job.id, "権限がありません");

  const again = await store.enqueue(input());
  assert.equal(again.created, true);
  assert.equal(again.job.state, "queued");
  assert.equal(again.job.attempts, 0);
});

test("成功した仕事は積み直さない", async () => {
  const store = new MemoryJobStore();
  const { job } = await store.enqueue(input());
  await store.claim({ leaseMs: 1000 });
  await store.succeed(job.id);

  const again = await store.enqueue(input());
  assert.equal(again.created, false);
  assert.equal(again.job.state, "succeeded");
});

test("取り出した仕事は他のワーカーから見えない", async () => {
  const store = new MemoryJobStore();
  await store.enqueue(input());

  const claimed = await store.claim({ leaseMs: 60_000 });
  assert.equal(claimed?.state, "running");
  assert.equal(claimed?.attempts, 1);
  assert.equal(await store.claim({ leaseMs: 60_000 }), null);
});

// ワーカーが落ちたときに仕事が永久に running のまま残らないこと
test("リースが切れた仕事は取り直せる", async () => {
  let now = new Date("2026-09-26T00:00:00Z");
  const store = new MemoryJobStore({ now: () => now });
  await store.enqueue(input());

  const first = await store.claim({ leaseMs: 60_000 });
  assert.ok(first);
  now = new Date(now.getTime() + 61_000);

  const retaken = await store.claim({ leaseMs: 60_000 });
  assert.equal(retaken?.id, first.id);
  assert.equal(retaken?.attempts, 2);
});

test("ハートビートでリースが延び、取り直されない", async () => {
  let now = new Date("2026-09-26T00:00:00Z");
  const store = new MemoryJobStore({ now: () => now });
  const { job } = await store.enqueue(input());
  await store.claim({ leaseMs: 60_000 });

  now = new Date(now.getTime() + 50_000);
  await store.heartbeat(job.id, 60_000);
  now = new Date(now.getTime() + 30_000);

  assert.equal(await store.claim({ leaseMs: 60_000 }), null);
});

test("runAfter が未来の仕事は取らない", async () => {
  const now = new Date("2026-09-26T00:00:00Z");
  const store = new MemoryJobStore({ now: () => now });
  await store.enqueue(input({ runAfter: new Date(now.getTime() + 60_000) }));
  assert.equal(await store.claim({ leaseMs: 1000 }), null);
});

test("種類で絞って取れる", async () => {
  const store = new MemoryJobStore();
  await store.enqueue(input({ kind: "backfill.survey", dedupeKey: "b1" }));
  assert.equal(await store.claim({ leaseMs: 1000, kinds: ["analyze.pr"] }), null);
  assert.equal((await store.claim({ leaseMs: 1000, kinds: ["backfill.survey"] }))?.kind, "backfill.survey");
});
