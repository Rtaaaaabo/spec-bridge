import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryJobStore, PostgresJobStore, type JobStore } from "@spec-bridge/jobs";

/** モノレポルートの .env を読む（CLI / web / worker と設定ファイルを1つに保つ） */
export function loadEnv(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const candidate of [resolve(repoRoot, ".env"), resolve(process.cwd(), ".env")]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

/**
 * ジョブの置き場所を用意する。
 *
 * `DATABASE_URL` があれば Postgres。無ければメモリで動かすが、**プロセスを落とすと
 * 積んだ仕事が消える**ので、黙って使わせずに警告する。
 * 受信（webhook）と実行（worker）を別プロセスにする場合、メモリでは成立しない。
 */
export async function createJobStore(
  databaseUrl: string | undefined,
  log: (line: string) => void = console.log,
): Promise<JobStore> {
  if (!databaseUrl) {
    log("⚠ DATABASE_URL が未設定です。ジョブをメモリに置きます（プロセスを落とすと消えます）");
    return new MemoryJobStore();
  }
  const store = new PostgresJobStore(databaseUrl);
  await store.migrate();
  log("ジョブの置き場所: Postgres");
  return store;
}

export interface WebhookConfig {
  secret: string;
  docsRepo: string;
  port: number;
  databaseUrl: string | undefined;
  /** 受信プロセスの中でワーカーも回す（ローカル用。本番はプロセスを分ける） */
  inlineWorker: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  return {
    secret: env.GITHUB_WEBHOOK_SECRET ?? "",
    docsRepo: env.SPEC_BRIDGE_DOCS_REPO ?? "",
    port: Number(env.PORT ?? 3939),
    databaseUrl: env.DATABASE_URL,
    inlineWorker: env.SPEC_BRIDGE_INLINE_WORKER === "1",
  };
}
