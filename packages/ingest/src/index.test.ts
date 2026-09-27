import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { MemoryJobStore } from "@spec-bridge/jobs";
import { MemoryTenantStore } from "@spec-bridge/tenants";
import { handleWebhookDelivery, type IngestDeps } from "./index.ts";

const SECRET = "s3cret";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    secret: SECRET,
    jobs: new MemoryJobStore(),
    tenants: new MemoryTenantStore(),
    ...overrides,
  };
}

const merged = JSON.stringify({
  action: "closed",
  pull_request: { number: 42, merged: true, merge_commit_sha: "abc" },
  repository: { full_name: "acme/backend" },
  installation: { id: 999 },
});

// 署名検証はこのエンドポイントの唯一の認証。入口が増えても1箇所で守る
test("署名が正しくなければ 401", async () => {
  const result = await handleWebhookDelivery(
    { rawBody: merged, event: "pull_request", signature: "sha256=" + "0".repeat(64) },
    deps(),
  );
  assert.equal(result.status, 401);
});

test("署名ヘッダが無ければ 401", async () => {
  const result = await handleWebhookDelivery(
    { rawBody: merged, event: "pull_request", signature: null },
    deps(),
  );
  assert.equal(result.status, 401);
});

test("マージされた PR を積む", async () => {
  const jobs = new MemoryJobStore();
  const result = await handleWebhookDelivery(
    { rawBody: merged, event: "pull_request", signature: sign(merged) },
    deps({ jobs }),
  );
  assert.equal(result.status, 202);
  assert.equal(result.body["accepted"], true);
  assert.equal((await jobs.find({})).length, 1);
});

test("同じ配信が再送されても積み直さない", async () => {
  const jobs = new MemoryJobStore();
  const delivery = { rawBody: merged, event: "pull_request", signature: sign(merged) } as const;
  await handleWebhookDelivery(delivery, deps({ jobs }));
  const second = await handleWebhookDelivery(delivery, deps({ jobs }));
  assert.equal(second.body["duplicate"], true);
  assert.equal((await jobs.find({})).length, 1);
});

test("マージされていない PR は無視する（GitHub に再送させない）", async () => {
  const body = JSON.stringify({
    action: "closed",
    pull_request: { number: 1, merged: false },
    repository: { full_name: "acme/backend" },
  });
  const result = await handleWebhookDelivery(
    { rawBody: body, event: "pull_request", signature: sign(body) },
    deps(),
  );
  assert.equal(result.status, 202);
  assert.equal(result.body["ignored"], true);
});

test("インストールのイベントはテナントとして記録する", async () => {
  const tenants = new MemoryTenantStore();
  const body = JSON.stringify({
    action: "created",
    installation: { id: 150693021, account: { login: "acme" } },
  });
  const result = await handleWebhookDelivery(
    { rawBody: body, event: "installation", signature: sign(body) },
    deps({ tenants }),
  );
  assert.equal(result.status, 202);
  assert.equal((await tenants.get(150693021))?.account, "acme");
});

test("アンインストールでテナントを消す", async () => {
  const tenants = new MemoryTenantStore();
  await tenants.upsert({ installationId: 1, account: "acme", docsRepo: "acme/specs" });
  const body = JSON.stringify({ action: "deleted", installation: { id: 1, account: { login: "acme" } } });
  await handleWebhookDelivery(
    { rawBody: body, event: "installation", signature: sign(body) },
    deps({ tenants }),
  );
  assert.equal(await tenants.get(1), null);
});

test("壊れた JSON は 400（署名は通っていても）", async () => {
  const body = "{ not json";
  const result = await handleWebhookDelivery(
    { rawBody: body, event: "pull_request", signature: sign(body) },
    deps(),
  );
  assert.equal(result.status, 400);
});

// 積めないのはこちら側の問題。500 を返して GitHub に再送させる
test("ジョブを積めなければ 500", async () => {
  const jobs = new MemoryJobStore();
  jobs.enqueue = async () => {
    throw new Error("db down");
  };
  const result = await handleWebhookDelivery(
    { rawBody: merged, event: "pull_request", signature: sign(merged) },
    deps({ jobs }),
  );
  assert.equal(result.status, 500);
});
