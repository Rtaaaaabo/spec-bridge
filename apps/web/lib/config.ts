import { existsSync } from "node:fs";
import { readOAuthConfig } from "./oauth.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";

let envLoaded = false;

/**
 * Next.js は apps/web/.env しか見ないので、モノレポルートの .env を明示的に読み込む。
 * CLI と設定ファイルを1つに保つため。
 */
function ensureEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const rootEnv = resolve(process.cwd(), "../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

/** 機能ドキュメントの置き場所。SPEC_BRIDGE_DOCS_PATH で指定する */
export function docsPath(): string {
  ensureEnv();
  const raw = process.env.SPEC_BRIDGE_DOCS_PATH;
  if (!raw) {
    throw new Error(
      "SPEC_BRIDGE_DOCS_PATH が設定されていません。spec-bridge/.env に機能ドキュメントのディレクトリを設定してください。",
    );
  }
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

/**
 * セッション Cookie の署名鍵。
 *
 * **未設定なら例外にする。** 空鍵で署名すると、誰でも自分でセッションを作れてしまう。
 */
export function sessionSecret(): string {
  ensureEnv();
  const secret = process.env.SPEC_BRIDGE_SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "SPEC_BRIDGE_SESSION_SECRET が設定されていません（例: openssl rand -hex 32）。",
    );
  }
  return secret;
}

/** OAuth の設定。未設定なら null（ログイン機能を出さない） */
export function oauthConfig(): ReturnType<typeof readOAuthConfig> {
  ensureEnv();
  return readOAuthConfig(process.env);
}
