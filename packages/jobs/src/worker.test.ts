import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryJobStore } from "./memory.ts";
import { Worker, type JobHandler } from "./worker.ts";

const input = {
  kind: "analyze.pr",
  tenantId: "local",
  dedupeKey: "acme/backend#1:abc",
  payload: { number: 1 },
};

function worker(store: MemoryJobStore, handler: JobHandler) {
  return new Worker({
    store,
    handlers: { "analyze.pr": handler },
    random: () => 0.5,
    sleep: async () => {},
  });
}

test("処理できたら成功として閉じる", async () => {
  const store = new MemoryJobStore();
  const { job } = await store.enqueue(input);
  const w = worker(store, async () => ({ prUrl: "https://example.com/pr/1" }));

  assert.equal(await w.runOnce(), true);
  const done = await store.get(job.id);
  assert.equal(done?.state, "succeeded");
  assert.deepEqual(done?.result, { prUrl: "https://example.com/pr/1" });
});

test("仕事が無ければ false を返す", async () => {
  const store = new MemoryJobStore();
  assert.equal(await worker(store, async () => {}).runOnce(), false);
});

// 実測で踏んだ利用上限。ここが積み直されないと、失敗した機能を手で拾うことになる
test("待てば直る失敗は、時間を置いて積み直す", async () => {
  const now = new Date("2026-09-26T00:00:00Z");
  const store = new MemoryJobStore({ now: () => now });
  const { job } = await store.enqueue(input);
  const w = new Worker({
    store,
    handlers: {
      "analyze.pr": async () => {
        throw new Error("You've hit your session limit");
      },
    },
    now: () => now,
    random: () => 0.5,
    sleep: async () => {},
  });

  await w.runOnce();
  const retried = await store.get(job.id);
  assert.equal(retried?.state, "queued");
  assert.ok(retried && retried.runAfter > now, "未来に積み直されている");
  assert.match(retried?.lastError ?? "", /session limit/);
});

test("直らない失敗はその場で終わらせる", async () => {
  const store = new MemoryJobStore();
  const { job } = await store.enqueue(input);
  const w = worker(store, async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });

  await w.runOnce();
  assert.equal((await store.get(job.id))?.state, "failed");
});

test("再試行の上限を超えたら終わらせる", async () => {
  let now = new Date("2026-09-26T00:00:00Z");
  const store = new MemoryJobStore({ now: () => now });
  const { job } = await store.enqueue({ ...input, maxAttempts: 2 });
  const w = new Worker({
    store,
    handlers: {
      "analyze.pr": async () => {
        throw new Error("rate limit");
      },
    },
    now: () => now,
    random: () => 0.5,
    sleep: async () => {},
  });

  await w.runOnce();
  assert.equal((await store.get(job.id))?.state, "queued", "1回目は積み直す");

  // 積み直しは未来の時刻なので、待たないと次は取れない
  now = new Date(now.getTime() + 60 * 60_000);
  await w.runOnce();
  assert.equal((await store.get(job.id))?.state, "failed", "上限に達したら終わり");
});

// 1件の失敗で他の仕事を巻き込まないこと（バックフィルの「1件失敗しても続行」と同じ考え方）
test("1件失敗しても次の仕事は処理される", async () => {
  const store = new MemoryJobStore();
  await store.enqueue({ ...input, dedupeKey: "ng" });
  await store.enqueue({ ...input, dedupeKey: "ok" });

  const w = worker(store, async (job) => {
    if (job.dedupeKey === "ng") throw Object.assign(new Error("Not Found"), { status: 404 });
  });

  await w.runOnce();
  await w.runOnce();
  assert.deepEqual(store.countByState(), { failed: 1, succeeded: 1 });
});
