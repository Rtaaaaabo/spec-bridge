import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, type JobStore } from "@spec-bridge/jobs";
import { checkGitHubAuthConfig, resolveGitHubAuth, type GitHubAuth } from "@spec-bridge/github";
import { ANALYZE_PR, parseAnalyzePayload } from "./analyze-job.ts";
import { createJobStore, loadEnv, readConfig } from "./config.ts";
import { handleMergedPullRequest } from "./handler.ts";

export interface AnalyzeWorkerOptions {
  store: JobStore;
  auth: GitHubAuth;
  docsRepo: string;
  log?: (line: string) => void;
}

/**
 * 解析ジョブを処理するワーカーを組み立てる。
 *
 * 解析は1件あたり数分かかるので、リースは長めに取り、処理中はハートビートで延ばす。
 */
export function createAnalyzeWorker(options: AnalyzeWorkerOptions): Worker {
  const log = options.log ?? ((line: string) => console.log(line));

  return new Worker({
    store: options.store,
    leaseMs: 10 * 60_000,
    heartbeatMs: 60_000,
    log,
    handlers: {
      [ANALYZE_PR]: async (job) => {
        const event = parseAnalyzePayload(job.payload);
        const result = await handleMergedPullRequest(
          event,
          { docsRepo: options.docsRepo, auth: options.auth },
          log,
        );

        // 失敗は投げて `Worker` の再試行判定に渡す。
        // 「待てば直る」ものだけが積み直され、権限不足などはその場で終わる
        if (result.status === "failed") {
          throw new Error(result.detail);
        }
        return { status: result.status, detail: result.detail, prUrl: result.prUrl ?? null };
      },
    },
  });
}

/** `pnpm worker` の入口。webhook と同じ .env を読む */
async function main(): Promise<void> {
  loadEnv();
  const config = readConfig();

  const problems: string[] = [];
  if (!config.docsRepo) problems.push("SPEC_BRIDGE_DOCS_REPO が未設定です");
  problems.push(...checkGitHubAuthConfig());
  if (problems.length > 0) {
    console.error("起動できません:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const auth = resolveGitHubAuth();
  const store = await createJobStore(config.databaseUrl);
  const worker = createAnalyzeWorker({ store, auth, docsRepo: config.docsRepo });

  // 受信側とは別プロセスなので、メモリ置き場では仕事が届かない
  if (!config.databaseUrl) {
    console.error("DATABASE_URL が必要です（webhook とジョブを共有できません）");
    process.exit(1);
  }

  console.log("spec-bridge worker 起動");
  console.log(`  docs リポジトリ: ${config.docsRepo}`);
  console.log(
    `  GitHub 認証: ${auth.kind === "app" ? "GitHub App（installation トークン）" : "PAT（GITHUB_TOKEN）"}`,
  );

  const shutdown = () => {
    console.log("停止します（処理中のジョブが終わるまで待ちます）");
    worker.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.start();
  await store.close();
}

// `pnpm worker` で直接起動したときだけ main を走らせる（index.ts が import しても走らせない）
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main();
}
