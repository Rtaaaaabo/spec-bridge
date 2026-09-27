import { randomUUID } from "node:crypto";
import { DEFAULT_BUDGET_USD, surveyJob, type BackfillRun } from "@spec-bridge/backfill";
import {
  installationIdForRepo,
  parseRepoFullName,
  readAppCredentials,
  resolveGitHubAuth,
} from "@spec-bridge/github";
import { PostgresJobStore } from "@spec-bridge/jobs";
import { resolveDocsRepo } from "@spec-bridge/tenants";
import { currentSession } from "@/lib/auth";
import { databaseUrl, fallbackDocsRepo } from "@/lib/config";
import { withTenants } from "@/lib/tenants";

export const runtime = "nodejs";

interface StartRunBody {
  repo?: unknown;
  limit?: unknown;
  budgetUsd?: unknown;
}

/**
 * バックフィルのランを積む。
 *
 * **お金を使う操作なので、予算を必ず持たせる。** 画面から気軽に押せるぶん、
 * 上限の無いランを作れてはいけない（1機能 約 $1.7）。
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await currentSession())) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: StartRunBody;
  try {
    body = (await request.json()) as StartRunBody;
  } catch {
    return Response.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const limit = Number(body.limit ?? 5);
  const budgetUsd = Number(body.budgetUsd ?? DEFAULT_BUDGET_USD);

  if (!repo.includes("/")) {
    return Response.json({ error: "解析対象は org/repo の形式で指定してください" }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return Response.json({ error: "機能数の上限は1以上の整数にしてください" }, { status: 400 });
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return Response.json({ error: "予算は正の数にしてください" }, { status: 400 });
  }

  try {
    // ここで通らない認証は worker でも通らない。積む前に落とす
    const auth = resolveGitHubAuth();
    await auth.forRepo(repo);

    // 提出先は解析対象のインストールに紐づく。**積む前に決める**（後で分からないと困る）。
    // PAT 運用では installation が無いので、env の提出先に落ちる
    const credentials = readAppCredentials();
    const installationId = credentials ? await installationIdForRepo(credentials, repo) : null;
    const { docsRepo } = await withTenants((store) =>
      resolveDocsRepo(store, installationId, fallbackDocsRepo()),
    );

    const runId = randomUUID();
    const run: BackfillRun = {
      runId,
      repo,
      docsRepo,
      branch: `spec-bridge/backfill-${parseRepoFullName(repo).repo}-${runId.slice(0, 8)}`,
      limit,
      budgetUsd,
    };

    const store = new PostgresJobStore(databaseUrl());
    try {
      const { job } = await store.enqueue(surveyJob(run));
      return Response.json({ runId, jobId: job.id, branch: run.branch }, { status: 202 });
    } finally {
      await store.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[runs]", message);
    return Response.json({ error: message }, { status: 400 });
  }
}
