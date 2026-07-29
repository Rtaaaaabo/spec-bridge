import { existsSync } from "node:fs";
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
