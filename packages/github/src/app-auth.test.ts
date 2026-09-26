import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkGitHubAuthConfig,
  createTokenAuth,
  InstallationTokenStore,
  normalizePrivateKey,
  readAppCredentials,
  resolveGitHubAuth,
} from "./app-auth.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----";

// --- 秘密鍵の受け取り方 ---

test("env に1行で入れた秘密鍵（\\n エスケープ）を PEM に戻す", () => {
  const inline = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEow==\\n-----END RSA PRIVATE KEY-----";
  assert.equal(normalizePrivateKey(inline), PEM);
});

test("すでに改行済みの秘密鍵はそのまま（前後の空白だけ落とす）", () => {
  assert.equal(normalizePrivateKey(`\n${PEM}\n\n`), PEM);
});

// --- 資格情報の読み取り ---

test("App の設定が何も無ければ null（PAT 運用にフォールバックできる）", () => {
  assert.equal(readAppCredentials({}), null);
  assert.equal(readAppCredentials({ GITHUB_TOKEN: "ghp_dummy" }), null);
});

test("App ID と秘密鍵が揃っていれば読む", () => {
  assert.deepEqual(readAppCredentials({ GITHUB_APP_ID: " 123 ", GITHUB_APP_PRIVATE_KEY: PEM }), {
    appId: "123",
    privateKey: PEM,
  });
});

test("秘密鍵はファイルパスでも渡せる", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-bridge-pem-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, `${PEM}\n`, "utf8");

  assert.deepEqual(
    readAppCredentials({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: path }),
    { appId: "123", privateKey: PEM },
  );
});

// 「App を設定したつもりで、実は PAT で動いていた」を作らないための強制。
// 半端な設定は null（フォールバック）ではなく必ず失敗させる。
test("App の設定が半端なら PAT に落とさず投げる", () => {
  assert.throws(
    () => readAppCredentials({ GITHUB_APP_ID: "123" }),
    /秘密鍵がありません/,
  );
  assert.throws(
    () => readAppCredentials({ GITHUB_APP_PRIVATE_KEY: PEM }),
    /GITHUB_APP_ID がありません/,
  );
  assert.throws(
    () => readAppCredentials({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "not-a-pem" }),
    /PEM 形式に見えません/,
  );
});

// --- 起動時チェック ---

test("認証が何も無ければ起動時チェックで報告する", () => {
  assert.equal(checkGitHubAuthConfig({}).length, 1);
  assert.match(checkGitHubAuthConfig({})[0] ?? "", /GITHUB_APP_ID/);
});

test("PAT だけ・App だけのどちらでも問題なしとする", () => {
  assert.deepEqual(checkGitHubAuthConfig({ GITHUB_TOKEN: "ghp_dummy" }), []);
  assert.deepEqual(
    checkGitHubAuthConfig({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: PEM }),
    [],
  );
});

test("半端な App 設定は、PAT があっても問題として報告する", () => {
  const problems = checkGitHubAuthConfig({ GITHUB_APP_ID: "123", GITHUB_TOKEN: "ghp_dummy" });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /秘密鍵がありません/);
});

// --- installation トークンのキャッシュ ---

function mintCounter(expiresAt: number) {
  let calls = 0;
  const mint = async (installationId: number) => {
    calls += 1;
    return { token: `token-${installationId}-${calls}`, expiresAt };
  };
  return { mint, calls: () => calls };
}

test("有効なあいだはトークンを使い回す", async () => {
  const { mint, calls } = mintCounter(60 * 60_000);
  const store = new InstallationTokenStore(mint, { marginMs: 0, now: () => 0 });

  assert.equal(await store.get(1), "token-1-1");
  assert.equal(await store.get(1), "token-1-1");
  assert.equal(calls(), 1);
});

test("installation ごとに別のトークンを持つ", async () => {
  const { mint, calls } = mintCounter(60 * 60_000);
  const store = new InstallationTokenStore(mint, { marginMs: 0, now: () => 0 });

  assert.equal(await store.get(1), "token-1-1");
  assert.equal(await store.get(2), "token-2-2");
  assert.equal(calls(), 2);
});

// 解析は数分〜30分かかる。「取得時は有効、処理中に失効」を避けるため手前で捨てる
test("失効が近いトークンは作り直す", async () => {
  const { mint, calls } = mintCounter(60 * 60_000);
  let now = 0;
  const store = new InstallationTokenStore(mint, { marginMs: 5 * 60_000, now: () => now });

  assert.equal(await store.get(1), "token-1-1");
  now = 54 * 60_000; // 失効まで6分 → まだ使う
  assert.equal(await store.get(1), "token-1-1");
  now = 56 * 60_000; // 失効まで4分 → 余裕を切ったので作り直す
  assert.equal(await store.get(1), "token-1-2");
  assert.equal(calls(), 2);
});

test("同じ installation の同時取得で交換は1回だけ", async () => {
  const { mint, calls } = mintCounter(60 * 60_000);
  const store = new InstallationTokenStore(mint, { marginMs: 0, now: () => 0 });

  const [a, b] = await Promise.all([store.get(7), store.get(7)]);
  assert.equal(a, b);
  assert.equal(calls(), 1);
});

test("交換に失敗したらキャッシュせず、次回もう一度試す", async () => {
  let calls = 0;
  const store = new InstallationTokenStore(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { token: "ok", expiresAt: 60 * 60_000 };
    },
    { marginMs: 0, now: () => 0 },
  );

  await assert.rejects(() => store.get(1), /boom/);
  assert.equal(await store.get(1), "ok");
});

// --- 認証方式の選択 ---

test("PAT 運用ではどのリポジトリでも同じトークンを返す", async () => {
  const auth = createTokenAuth("ghp_dummy");
  assert.equal(auth.kind, "token");
  const a = await auth.forRepo("acme/backend");
  const b = await auth.forRepo("acme/specs");
  assert.equal(a.token, "ghp_dummy");
  assert.equal(a.octokit, b.octokit);
});

test("App の資格情報があれば PAT より優先する", () => {
  const auth = resolveGitHubAuth({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_TOKEN: "ghp_dummy",
  });
  assert.equal(auth.kind, "app");
});

test("App が無ければ PAT、どちらも無ければ投げる", () => {
  assert.equal(resolveGitHubAuth({ GITHUB_TOKEN: "ghp_dummy" }).kind, "token");
  assert.throws(() => resolveGitHubAuth({}), /認証情報がありません/);
});
