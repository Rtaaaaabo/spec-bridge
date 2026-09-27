import assert from "node:assert/strict";
import { test } from "node:test";
import { newSession, signSession, verifySession, SESSION_TTL_MS } from "./session.ts";

const secret = "test-secret";
const user = { id: 42, login: "octocat", name: "Octo", avatarUrl: null };

test("署名したセッションを読み戻せる", async () => {
  const token = await signSession(newSession(user), secret);
  const session = await verifySession(token, secret);
  assert.equal(session?.userId, 42);
  assert.equal(session?.login, "octocat");
});

// 空鍵で署名を通すと、誰でも自分でセッションを作れる
test("鍵が無ければ署名も検証もしない", async () => {
  await assert.rejects(() => signSession(newSession(user), ""), /署名鍵が空/);
  assert.equal(await verifySession(await signSession(newSession(user), secret), ""), null);
});

test("別の鍵で署名されたセッションは通さない", async () => {
  const token = await signSession(newSession(user), "other-secret");
  assert.equal(await verifySession(token, secret), null);
});

test("中身を書き換えたセッションは通さない", async () => {
  const token = await signSession(newSession(user), secret);
  const [, signature] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...newSession(user), userId: 1, login: "attacker" }),
    "utf8",
  ).toString("base64url");
  assert.equal(await verifySession(`${forged}.${signature}`, secret), null);
});

test("壊れた入力でも例外を投げずに拒否する", async () => {
  for (const token of ["", "garbage", "a.b", ".", "only-payload."]) {
    assert.equal(await verifySession(token, secret), null, token);
  }
  assert.equal(await verifySession(undefined, secret), null);
  assert.equal(await verifySession(null, secret), null);
});

// 権限を失った人が見続けられないよう、寿命で切る
test("期限切れのセッションは通さない", async () => {
  const now = Date.now();
  const token = await signSession(newSession(user, now), secret);
  assert.ok(await verifySession(token, secret, now + SESSION_TTL_MS - 1_000));
  assert.equal(await verifySession(token, secret, now + SESSION_TTL_MS + 1_000), null);
});

// Cookie が漏れても、そのままリポジトリを触れる鍵にはしない
test("セッションにアクセストークンを入れない", async () => {
  const token = await signSession(newSession(user), secret);
  const payload = Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
  assert.doesNotMatch(payload, /gho_|ghu_|access_token/);
  assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), [
    "avatarUrl",
    "expiresAt",
    "login",
    "name",
    "userId",
  ]);
});
