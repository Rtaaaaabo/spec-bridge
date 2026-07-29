import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { parseMergedPullRequest, verifyWebhookSignature } from "@spec-bridge/github";
import { handleMergedPullRequest } from "./handler.ts";

// モノレポルートの .env を読む（CLI / web と設定ファイルを1つに保つ）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const candidate of [resolve(repoRoot, ".env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const DOCS_REPO = process.env.SPEC_BRIDGE_DOCS_REPO ?? "";
const PORT = Number(process.env.PORT ?? 3939);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, docsRepo: DOCS_REPO || null }));

app.post("/webhooks/github", async (c) => {
  const raw = await c.req.text();

  // 署名検証がこのエンドポイントの唯一の認証。検証前の中身は一切信用しない
  if (!verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), SECRET)) {
    console.warn("[webhook] 署名検証に失敗しました");
    return c.json({ error: "invalid signature" }, 401);
  }

  const event = parseMergedPullRequest(c.req.header("x-github-event"), JSON.parse(raw));
  if (!event) {
    // マージされた PR 以外は正常応答で無視する（GitHub 側でリトライされないように）
    return c.json({ ignored: true }, 202);
  }

  // 解析は数分かかる。GitHub は10秒で切るので、受領だけ返して裏で処理する
  void handleMergedPullRequest(event, { docsRepo: DOCS_REPO }, (line) => console.log(line))
    .then((result) => {
      console.log(`[webhook] ${event.repo}#${event.number} → ${result.status}: ${result.detail}`);
    })
    .catch((error: unknown) => {
      console.error(
        `[webhook] ${event.repo}#${event.number} の処理に失敗:`,
        error instanceof Error ? error.message : error,
      );
    });

  return c.json({ accepted: true, repo: event.repo, number: event.number }, 202);
});

function preflight(): string[] {
  const problems: string[] = [];
  if (!SECRET) problems.push("GITHUB_WEBHOOK_SECRET が未設定です");
  if (!DOCS_REPO) problems.push("SPEC_BRIDGE_DOCS_REPO が未設定です（例: owner/my-specs）");
  if (!process.env.GITHUB_TOKEN) problems.push("GITHUB_TOKEN が未設定です");
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("起動できません:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nspec-bridge/.env を確認してください。");
  process.exit(1);
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`spec-bridge webhook listening on http://localhost:${info.port}`);
  console.log(`  POST /webhooks/github`);
  console.log(`  docs リポジトリ: ${DOCS_REPO}`);
});
