import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedLogin, readAllowedLogins } from "./access.ts";

test("カンマ区切りを読み、前後の空白を落とす", () => {
  assert.deepEqual(
    readAllowedLogins({ SPEC_BRIDGE_ALLOWED_LOGINS: " octocat , hubot " }),
    ["octocat", "hubot"],
  );
});

test("空の項目は無視する", () => {
  assert.deepEqual(readAllowedLogins({ SPEC_BRIDGE_ALLOWED_LOGINS: "a,,b," }), ["a", "b"]);
});

// 設定漏れのまま公開したときに全部見えてしまうのを避ける
test("未設定なら誰も通さない（空リスト）", () => {
  assert.deepEqual(readAllowedLogins({}), []);
  assert.equal(isAllowedLogin("octocat", readAllowedLogins({})), false);
  assert.equal(isAllowedLogin("octocat", []), false);
});

test("GitHub のログイン名は大文字小文字を区別しない", () => {
  const allowed = readAllowedLogins({ SPEC_BRIDGE_ALLOWED_LOGINS: "Rtaaaaabo" });
  assert.equal(isAllowedLogin("rtaaaaabo", allowed), true);
  assert.equal(isAllowedLogin("RTAAAAABO", allowed), true);
});

test("許可されていない人は通さない", () => {
  const allowed = readAllowedLogins({ SPEC_BRIDGE_ALLOWED_LOGINS: "octocat" });
  assert.equal(isAllowedLogin("attacker", allowed), false);
  assert.equal(isAllowedLogin("", allowed), false);
  assert.equal(isAllowedLogin("octocat2", allowed), false);
});
