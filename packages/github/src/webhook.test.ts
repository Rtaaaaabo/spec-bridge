import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { isDocsRepoEvent, parseMergedPullRequest, verifyWebhookSignature } from "./webhook.ts";

const SECRET = "s3cret";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

test("正しい署名を受け入れる", () => {
  const body = '{"action":"closed"}';
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test("本文が改ざんされていたら拒否する", () => {
  const body = '{"action":"closed"}';
  const signature = sign(body);
  assert.equal(verifyWebhookSignature('{"action":"opened"}', signature, SECRET), false);
});

test("秘密鍵が違えば拒否する", () => {
  const body = '{"action":"closed"}';
  assert.equal(verifyWebhookSignature(body, sign(body), "wrong"), false);
});

test("署名ヘッダがなければ拒否する", () => {
  assert.equal(verifyWebhookSignature("{}", null, SECRET), false);
  assert.equal(verifyWebhookSignature("{}", undefined, SECRET), false);
  assert.equal(verifyWebhookSignature("{}", "", SECRET), false);
});

test("秘密鍵が未設定なら常に拒否する（設定漏れで素通りさせない）", () => {
  const body = "{}";
  assert.equal(verifyWebhookSignature(body, sign(body), ""), false);
});

test("長さの違う署名でも例外を投げずに拒否する", () => {
  assert.equal(verifyWebhookSignature("{}", "sha256=short", SECRET), false);
  assert.equal(verifyWebhookSignature("{}", "garbage", SECRET), false);
});

// --- イベントの絞り込み ---

const mergedPayload = {
  action: "closed",
  pull_request: { number: 42, merged: true, merge_commit_sha: "abc123" },
  repository: { full_name: "acme/backend" },
  installation: { id: 999 },
};

test("マージされた PR を取り出す", () => {
  const event = parseMergedPullRequest("pull_request", mergedPayload);
  assert.deepEqual(event, {
    repo: "acme/backend",
    number: 42,
    mergeCommitSha: "abc123",
    installationId: 999,
  });
});

test("マージされずに閉じた PR は無視する", () => {
  const payload = { ...mergedPayload, pull_request: { ...mergedPayload.pull_request, merged: false } };
  assert.equal(parseMergedPullRequest("pull_request", payload), null);
});

test("オープンされただけの PR は無視する", () => {
  assert.equal(parseMergedPullRequest("pull_request", { ...mergedPayload, action: "opened" }), null);
});

test("pull_request 以外のイベントは無視する", () => {
  assert.equal(parseMergedPullRequest("push", mergedPayload), null);
  assert.equal(parseMergedPullRequest(null, mergedPayload), null);
});

test("必須フィールドが欠けていたら無視する", () => {
  assert.equal(
    parseMergedPullRequest("pull_request", { ...mergedPayload, repository: {} }),
    null,
  );
  assert.equal(parseMergedPullRequest("pull_request", {}), null);
});

// --- 自己ループ防止（実運用で踏んだ事故の固定） ---

test("docs リポジトリ自身の PR は処理対象にしない", () => {
  // 生成された PR をマージするたびに次の PR が生まれる無限ループを防ぐ
  assert.equal(isDocsRepoEvent("acme/specs", "acme/specs"), true);
});

test("大文字小文字や前後の空白が違っても同一リポジトリとみなす", () => {
  assert.equal(isDocsRepoEvent("Acme/Specs", "acme/specs"), true);
  assert.equal(isDocsRepoEvent(" acme/specs ", "acme/specs"), true);
});

test("解析対象リポジトリは通す", () => {
  assert.equal(isDocsRepoEvent("acme/backend", "acme/specs"), false);
  assert.equal(isDocsRepoEvent("acme/specs-web", "acme/specs"), false);
});
