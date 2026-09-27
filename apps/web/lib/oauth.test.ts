import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeUrl, isValidState, readOAuthConfig } from "./oauth.ts";

const config = {
  clientId: "Iv23liABC",
  clientSecret: "secret",
  redirectUri: "http://localhost:3000/api/github/callback",
};

test("設定が無ければ null（ログイン機能を出さない）", () => {
  assert.equal(readOAuthConfig({}), null);
});

// 半端な設定で「ログインできるつもり」にさせない
test("片方だけ設定されていたら投げる", () => {
  assert.throws(() => readOAuthConfig({ GITHUB_APP_CLIENT_ID: "x" }), /両方必要/);
  assert.throws(() => readOAuthConfig({ GITHUB_APP_CLIENT_SECRET: "x" }), /両方必要/);
});

test("コールバック URL は基準 URL から組み立てる", () => {
  const read = readOAuthConfig({
    GITHUB_APP_CLIENT_ID: "Iv23liABC",
    GITHUB_APP_CLIENT_SECRET: "secret",
    SPEC_BRIDGE_BASE_URL: "https://specs.example.com/",
  });
  assert.equal(read?.redirectUri, "https://specs.example.com/api/github/callback");
});

test("基準 URL の既定はローカル", () => {
  const read = readOAuthConfig({ GITHUB_APP_CLIENT_ID: "a", GITHUB_APP_CLIENT_SECRET: "b" });
  assert.equal(read?.redirectUri, "http://localhost:3000/api/github/callback");
});

test("認可 URL に client_id と state を載せる", () => {
  const url = new URL(authorizeUrl(config, "state-123"));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv23liABC");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
});

test("認可 URL に秘密鍵を載せない", () => {
  assert.doesNotMatch(authorizeUrl(config, "s"), /secret/);
});

// こちらが始めたログインでなければ通さない
test("state が一致しなければ拒否する", () => {
  assert.equal(isValidState("abc", "abc"), true);
  assert.equal(isValidState("abc", "abd"), false);
  assert.equal(isValidState("abc", "abcd"), false);
  assert.equal(isValidState(null, "abc"), false);
  assert.equal(isValidState("abc", undefined), false);
  assert.equal(isValidState("", ""), false);
});
