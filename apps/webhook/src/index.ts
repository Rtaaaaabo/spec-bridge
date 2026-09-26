import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  checkGitHubAuthConfig,
  parseMergedPullRequest,
  resolveGitHubAuth,
  verifyWebhookSignature,
} from "@spec-bridge/github";
import { analyzeJob } from "./analyze-job.ts";
import { createJobStore, loadEnv, readConfig } from "./config.ts";
import { createAnalyzeWorker } from "./worker.ts";

loadEnv();
const config = readConfig();

function preflight(): string[] {
  const problems: string[] = [];
  if (!config.secret) problems.push("GITHUB_WEBHOOK_SECRET が未設定です");
  if (!config.docsRepo) problems.push("SPEC_BRIDGE_DOCS_REPO が未設定です（例: owner/my-specs）");
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

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, docsRepo: config.docsRepo || null }));

app.post("/webhooks/github", async (c) => {
  const raw = await c.req.text();

  // 署名検証がこのエンドポイントの唯一の認証。検証前の中身は一切信用しない
  if (!verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), config.secret)) {
    console.warn("[webhook] 署名検証に失敗しました");
    return c.json({ error: "invalid signature" }, 401);
  }

  const event = parseMergedPullRequest(c.req.header("x-github-event"), JSON.parse(raw));
  if (!event) {
    // マージされた PR 以外は正常応答で無視する（GitHub 側でリトライされないように）
    return c.json({ ignored: true }, 202);
  }

  // **ここでは積むだけ。** 解析は数分かかるうえ、受信プロセスで走らせると
  // 再起動で仕事が消え、同時に複数来たときに詰まる。
  try {
    const { job, created } = await store.enqueue(analyzeJob(event));
    console.log(
      `[webhook] ${event.repo}#${event.number} → ${created ? "ジョブを積みました" : "積み済み（重複）"}: ${job.id}`,
    );
    return c.json({ accepted: true, jobId: job.id, duplicate: !created }, 202);
  } catch (error) {
    // 積めないのはこちら側の問題なので 500 を返す。GitHub が再送してくれる
    console.error("[webhook] ジョブを積めませんでした:", error);
    return c.json({ error: "failed to enqueue" }, 500);
  }
});

if (config.inlineWorker) {
  const worker = createAnalyzeWorker({ store, auth, docsRepo: config.docsRepo });
  void worker.start();
  console.log("インラインのワーカーを起動しました（SPEC_BRIDGE_INLINE_WORKER=1）");
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`spec-bridge webhook listening on http://localhost:${info.port}`);
  console.log(`  POST /webhooks/github`);
  console.log(`  docs リポジトリ: ${config.docsRepo}`);
  console.log(
    `  GitHub 認証: ${auth.kind === "app" ? "GitHub App（installation トークン）" : "PAT（GITHUB_TOKEN）"}`,
  );
  if (!config.inlineWorker) {
    console.log("  ジョブの実行は別プロセスです: pnpm worker");
  }
});
