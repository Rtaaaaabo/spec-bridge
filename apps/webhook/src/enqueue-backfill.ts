import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { parseRepoFullName, resolveGitHubAuth } from "@spec-bridge/github";
import { PostgresJobStore } from "@spec-bridge/jobs";
import { DEFAULT_BUDGET_USD, surveyJob, type BackfillRun } from "./backfill-job.ts";
import { loadEnv, readConfig } from "./config.ts";

const USAGE = `バックフィルをジョブとして積む（実行は pnpm worker 側）

使い方:
  pnpm backfill-run --repo <org/repo> [options]

  --repo      <org/repo>  解析対象。GitHub App がインストールされている必要がある
  --docs-repo <org/repo>  提出先（省略時は SPEC_BRIDGE_DOCS_REPO）
  --limit     <n>         列挙する機能数の上限（既定 20）
  --budget    <usd>       このランで使ってよい額（既定 ${DEFAULT_BUDGET_USD}）。
                          超えたら残りの機能を書かずに仕上げへ進む
  -h, --help

例:
  pnpm backfill-run --repo acme/backend --limit 5 --budget 10
`;

/**
 * バックフィルのランを積む。
 *
 * **CLI（`pnpm backfill`）は手元で全機能を順に回す。** こちらは機能ごとにジョブを分けるので、
 * 利用上限に当たった1件だけを拾い直せて、予算の上限もランごとに効く。
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      "docs-repo": { type: "string" },
      limit: { type: "string" },
      budget: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || !values.repo) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  loadEnv();
  const config = readConfig();
  const docsRepo = values["docs-repo"] ?? config.docsRepo;

  if (!config.databaseUrl) {
    console.error("エラー: DATABASE_URL が必要です（ジョブの置き場所）。");
    return 1;
  }
  if (!docsRepo) {
    console.error("エラー: --docs-repo か SPEC_BRIDGE_DOCS_REPO が必要です。");
    return 1;
  }

  const limit = values.limit ? Number(values.limit) : 20;
  const budgetUsd = values.budget ? Number(values.budget) : DEFAULT_BUDGET_USD;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`エラー: --limit は1以上の整数で指定してください: "${values.limit}"`);
    return 1;
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    console.error(`エラー: --budget は正の数で指定してください: "${values.budget}"`);
    return 1;
  }

  // ここで通らない認証は worker でも通らない。数十分かけてから気づくより、積む前に落とす
  const auth = resolveGitHubAuth();
  await auth.forRepo(values.repo);
  await auth.forRepo(docsRepo);

  const runId = randomUUID();
  const run: BackfillRun = {
    runId,
    repo: values.repo,
    docsRepo,
    branch: `spec-bridge/backfill-${parseRepoFullName(values.repo).repo}-${runId.slice(0, 8)}`,
    limit,
    budgetUsd,
  };

  const store = new PostgresJobStore(config.databaseUrl);
  try {
    await store.migrate();
    const { job, created } = await store.enqueue(surveyJob(run));
    console.log(`▸ バックフィルを積みました（run ${runId}）`);
    console.log(`  解析対象: ${run.repo} → 提出先: ${run.docsRepo}`);
    console.log(`  上限 ${limit} 機能 / 予算 $${budgetUsd}`);
    console.log(`  ブランチ: ${run.branch}`);
    console.log(`  ジョブ: ${job.id}${created ? "" : "（既存）"}`);
    console.log("");
    console.log("実行するには worker を動かしてください: pnpm worker");
    return 0;
  } finally {
    await store.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\nエラー: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
