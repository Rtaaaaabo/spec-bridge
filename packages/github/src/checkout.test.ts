import assert from "node:assert/strict";
import { test } from "node:test";
import { maskToken } from "./checkout.ts";

/**
 * クローン URL にトークンを埋め込んでいるため、git の失敗メッセージが
 * そのままログへ出るとトークンが漏れる。
 */

const TOKEN = "ghs_AbCdEf1234567890XyZ";

test("x-access-token 形式のトークンを伏せる（ユーザー名部ごと落とす）", () => {
  const message = `fatal: could not read from 'https://x-access-token:${TOKEN}@github.com/acme/backend.git'`;
  const masked = maskToken(message);
  assert.ok(!masked.includes(TOKEN), "トークンが残っている");
  assert.match(masked, /https:\/\/\*\*\*@github\.com/);
});

test("同じメッセージに複数回出てきても全部伏せる", () => {
  const message = `https://x-access-token:${TOKEN}@github.com/a.git と https://x-access-token:${TOKEN}@github.com/b.git`;
  const masked = maskToken(message);
  assert.ok(!masked.includes(TOKEN));
  assert.equal(masked.split("***").length - 1, 2);
});

test("user:password 形式の埋め込みも伏せる", () => {
  const masked = maskToken("remote: https://someuser:s3cr3tp4ss@github.com/acme/x.git failed");
  assert.ok(!masked.includes("s3cr3tp4ss"));
  assert.ok(!masked.includes("someuser"));
  assert.match(masked, /https:\/\/\*\*\*@github\.com/);
});

test("認証情報を含まないメッセージは変えない", () => {
  const message = "fatal: repository 'https://github.com/acme/backend.git' not found";
  assert.equal(maskToken(message), message);
});

test("トークンらしき文字列が改行を跨いでも巻き込まない", () => {
  const message = `https://x-access-token:${TOKEN}@github.com/a.git\n次の行は無関係です`;
  const masked = maskToken(message);
  assert.ok(!masked.includes(TOKEN));
  assert.ok(masked.includes("次の行は無関係です"));
});

test("空文字でも落ちない", () => {
  assert.equal(maskToken(""), "");
});
