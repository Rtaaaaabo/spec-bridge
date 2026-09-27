import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { checkGitHubAuthConfig, resolveGitHubAuth } from "@spec-bridge/github";
import { handleWebhookDelivery } from "@spec-bridge/ingest";
import { createJobStore, createTenantStore, loadEnv, readConfig } from "./config.ts";
import { createAnalyzeWorker } from "./worker.ts";

loadEnv();
const config = readConfig();

function preflight(): string[] {
  const problems: string[] = [];
  if (!config.secret) problems.push("GITHUB_WEBHOOK_SECRET が未設定です");
  // 提出先はインストールごとに設定できるので、env は必須ではない
  problems.push(...checkGitHubAuthConfig());
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("起動できません:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nspec-bridge/.env を確認してください。");
  process.exit(1);
}

// 認証方式はプロセスの寿命で固定する。起動ログに出すのは、
// 「App を設定したつもりで PAT で動いていた」を運用側から見えるようにするため
const auth = resolveGitHubAuth();
const store = await createJobStore(config.databaseUrl);
const tenants = await createTenantStore(config.databaseUrl);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, docsRepo: config.docsRepo || null }));

app.post("/webhooks/github", async (c) => {
  // 受け口は Hono だが、署名検証とジョブ投入は共有実装（Next 側の入口と同じ道を通す）
  const result = await handleWebhookDelivery(
    {
      rawBody: await c.req.text(),
      event: c.req.header("x-github-event"),
      signature: c.req.header("x-hub-signature-256"),
    },
    {
      secret: config.secret,
      jobs: store,
      tenants,
      log: (line) => console.log(line),
    },
  );
  return c.json(result.body, result.status as 200);
});

if (config.inlineWorker) {
  const worker = createAnalyzeWorker({
    store,
    tenants,
    auth,
    docsRepo: config.docsRepo,
    prBudgetUsd: config.prBudgetUsd,
    analyzeConcurrency: config.analyzeConcurrency,
  });
  void worker.start();
  console.log("インラインのワーカーを起動しました（SPEC_BRIDGE_INLINE_WORKER=1）");
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`spec-bridge webhook listening on http://localhost:${info.port}`);
  console.log(`  POST /webhooks/github`);
  console.log(`  提出先の既定: ${config.docsRepo || "（なし。インストールごとの設定を使う）"}`);
  console.log(
    `  GitHub 認証: ${auth.kind === "app" ? "GitHub App（installation トークン）" : "PAT（GITHUB_TOKEN）"}`,
  );
  if (!config.inlineWorker) {
    console.log("  ジョブの実行は別プロセスです: pnpm worker");
  }
});
