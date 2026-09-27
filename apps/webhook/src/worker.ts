import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, type JobStore } from "@spec-bridge/jobs";
import { resolveDocsRepo, type TenantStore } from "@spec-bridge/tenants";
import { checkGitHubAuthConfig, resolveGitHubAuth, type GitHubAuth } from "@spec-bridge/github";
import { ANALYZE_PR, parseAnalyzePayload } from "./analyze-job.ts";
import { BACKFILL_FEATURE, BACKFILL_FINISH, BACKFILL_SURVEY } from "@spec-bridge/backfill";
import { featureHandler, finishHandler, surveyHandler } from "./backfill-handlers.ts";
import { createJobStore, createTenantStore, loadEnv, readConfig } from "./config.ts";
import { handleMergedPullRequest } from "./handler.ts";

export interface AnalyzeWorkerOptions {
  store: JobStore;
  tenants: TenantStore;
  auth: GitHubAuth;
  /** テナントに設定が無いときの提出先（単一テナント運用の後方互換） */
  docsRepo: string | undefined;
  /** PR 1本あたりの上限（USD） */
  prBudgetUsd: number;
  /** 機能の解析を同時に走らせる数 */
  analyzeConcurrency?: number;
  log?: (line: string) => void;
}

/**
 * ジョブを処理するワーカーを組み立てる。
 *
 * 解析は1件あたり数分かかるので、リースは長めに取り、処理中はハートビートで延ばす。
 */
export function createAnalyzeWorker(options: AnalyzeWorkerOptions): Worker {
  const log = options.log ?? ((line: string) => console.log(line));
  const deps = { store: options.store, auth: options.auth };

  return new Worker({
    store: options.store,
    leaseMs: 10 * 60_000,
    heartbeatMs: 60_000,
    log,
    handlers: {
      [BACKFILL_SURVEY]: surveyHandler(deps),
      [BACKFILL_FEATURE]: featureHandler(deps),
      [BACKFILL_FINISH]: finishHandler(deps),
      [ANALYZE_PR]: async (job) => {
        const event = parseAnalyzePayload(job.payload);

        // 提出先はインストールごと。**解析を始める前に決める**
        // （提出先の無いまま数分かけてから気づくのは高すぎる）
        const { docsRepo, source } = await resolveDocsRepo(
          options.tenants,
          event.installationId,
          options.docsRepo,
        );
        log(`  提出先: ${docsRepo}（${source === "installation" ? "インストールの設定" : "環境変数"}）`);

        const result = await handleMergedPullRequest(
          event,
          {
            docsRepo,
            auth: options.auth,
            budgetUsd: options.prBudgetUsd,
            ...(options.analyzeConcurrency !== undefined
              ? { concurrency: options.analyzeConcurrency }
              : {}),
          },
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

  // 提出先はインストールごとに設定できるので、env は必須ではない
  const problems = [...checkGitHubAuthConfig()];
  if (problems.length > 0) {
    console.error("起動できません:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const auth = resolveGitHubAuth();
  const store = await createJobStore(config.databaseUrl);
  const tenants = await createTenantStore(config.databaseUrl);
  const worker = createAnalyzeWorker({
    store,
    tenants,
    auth,
    docsRepo: config.docsRepo,
    prBudgetUsd: config.prBudgetUsd,
    analyzeConcurrency: config.analyzeConcurrency,
  });

  // 受信側とは別プロセスなので、メモリ置き場では仕事が届かない
  if (!config.databaseUrl) {
    console.error("DATABASE_URL が必要です（webhook とジョブを共有できません）");
    process.exit(1);
  }

  console.log("spec-bridge worker 起動");
  console.log(`  提出先の既定: ${config.docsRepo || "（なし。インストールごとの設定を使う）"}`);
  console.log(`  PR 1本あたりの上限: $${config.prBudgetUsd}`);
  console.log(`  機能の同時解析: ${config.analyzeConcurrency} 件`);
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
