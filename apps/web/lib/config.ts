import { existsSync } from "node:fs";
import { readAllowedLogins } from "./access.ts";
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

/** ログインを許可する GitHub ユーザー。空なら誰も通さない */
export function allowedLogins(): string[] {
  ensureEnv();
  return readAllowedLogins(process.env);
}

/** 画面の公開 URL。コールバックの組み立てと、手順の表示に使う */
export function baseUrl(): string {
  ensureEnv();
  return (process.env.SPEC_BRIDGE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** ジョブ表の接続先。未設定ならラン一覧は出せない */
export function databaseUrl(): string {
  ensureEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL が設定されていません（ジョブの置き場所）。");
  }
  return url;
}

/**
 * 提出先の既定。**インストールごとの設定が優先**で、これはその後ろに落ちる値。
 * 単一テナント運用の後方互換なので、未設定でも構わない。
 */
export function fallbackDocsRepo(): string | undefined {
  ensureEnv();
  return process.env.SPEC_BRIDGE_DOCS_REPO?.trim() || undefined;
}

/** GitHub webhook の署名鍵。**未設定なら全配信を拒否する**（素通しにしない） */
export function webhookSecret(): string {
  ensureEnv();
  return process.env.GITHUB_WEBHOOK_SECRET ?? "";
}
