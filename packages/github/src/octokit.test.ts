import assert from "node:assert/strict";
import { test } from "node:test";
import { createOctokit, createOctokitFromEnv, parseRepoFullName } from "./octokit.ts";

// --- 認証の渡し忘れを黙って通さない（マルチテナントで最も危ない失敗） ---

test("空のトークンでは Octokit を作らない", () => {
  assert.throws(() => createOctokit(""), /トークンが空/);
  assert.throws(() => createOctokit("   "), /トークンが空/);
});

test("createOctokit は env を見ない（既定値でグローバル認証情報に落ちない）", () => {
  // 以前は `token = process.env.GITHUB_TOKEN` が既定値で、渡し忘れが黙って通っていた
  assert.throws(() => createOctokit(""), /トークンが空/);
});

test("env から作るのは明示的な関数だけ", () => {
  assert.doesNotThrow(() => createOctokitFromEnv({ GITHUB_TOKEN: "ghp_dummy" }));
  assert.throws(() => createOctokitFromEnv({}), /GITHUB_TOKEN が設定されていません/);
  assert.throws(() => createOctokitFromEnv({ GITHUB_TOKEN: "  " }), /GITHUB_TOKEN/);
});

// --- owner/repo の解釈 ---

test("owner/repo を分解する", () => {
  assert.deepEqual(parseRepoFullName("acme/backend"), { owner: "acme", repo: "backend" });
  assert.deepEqual(parseRepoFullName(" acme/backend "), { owner: "acme", repo: "backend" });
});

test("owner/repo の形でなければ投げる", () => {
  for (const input of ["", "acme", "acme/", "/backend", "acme/back/end", "  /  "]) {
    assert.throws(() => parseRepoFullName(input), /リポジトリ名を解釈できません/, input);
  }
});
