import {
  parseInstallationEvent,
  parseMergedPullRequest,
  verifyWebhookSignature,
} from "@spec-bridge/github";
import type { JobStore } from "@spec-bridge/jobs";
import type { TenantStore } from "@spec-bridge/tenants";
import { analyzeJob } from "./analyze-job.ts";

export * from "./analyze-job.ts";

export interface WebhookDelivery {
  /** **検証前の生の本文。** パースした値ではなく、届いたバイト列そのもの */
  rawBody: string;
  /** `x-github-event` */
  event: string | null | undefined;
  /** `x-hub-signature-256` */
  signature: string | null | undefined;
}

export interface IngestDeps {
  secret: string;
  jobs: JobStore;
  tenants: TenantStore;
  /** どのテナントの仕事として積むか。テナント表が入るまでは `local` */
  tenantId?: string;
  log?: (line: string) => void;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * GitHub からの配信を1件受ける。**受け口の実装（Hono / Next）から独立させてある。**
 *
 * デプロイ先によって HTTP の入口は変わるが、**署名検証とジョブ投入は1箇所であるべき**。
 * 入口ごとに書くと、片方だけ検証が緩い、という事故が起きる。
 *
 * ここでは**積むだけ**。解析は数分かかるうえ、受信プロセスで走らせると
 * 再起動で仕事が消え、同時に複数来たときに詰まる。
 */
export async function handleWebhookDelivery(
  delivery: WebhookDelivery,
  deps: IngestDeps,
): Promise<IngestResult> {
  const log = deps.log ?? (() => {});

  // 署名検証がこのエンドポイントの唯一の認証。検証前の中身は一切信用しない
  if (!verifyWebhookSignature(delivery.rawBody, delivery.signature, deps.secret)) {
    log("[webhook] 署名検証に失敗しました");
    return { status: 401, body: { error: "invalid signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }

  // 「誰が使っているか」はここで分かる。提出先の設定はこの記録に紐づく
  const installation = parseInstallationEvent(delivery.event, payload);
  if (installation) {
    try {
      if (installation.removed) await deps.tenants.remove(installation.installationId);
      else
        await deps.tenants.upsert({
          installationId: installation.installationId,
          account: installation.account,
        });
      log(
        `[webhook] installation ${installation.installationId}（${installation.account}）→ ${installation.action}`,
      );
    } catch (error) {
      log(`[webhook] インストールを記録できませんでした: ${String(error)}`);
    }
    return { status: 202, body: { ok: true } };
  }

  const merged = parseMergedPullRequest(delivery.event, payload);
  if (!merged) {
    // マージされた PR 以外は正常応答で無視する（GitHub 側でリトライされないように）
    return { status: 202, body: { ignored: true } };
  }

  try {
    const { job, created } = await deps.jobs.enqueue(analyzeJob(merged, deps.tenantId));
    log(
      `[webhook] ${merged.repo}#${merged.number} → ${created ? "ジョブを積みました" : "積み済み（重複）"}: ${job.id}`,
    );
    return { status: 202, body: { accepted: true, jobId: job.id, duplicate: !created } };
  } catch (error) {
    // 積めないのはこちら側の問題なので 500 を返す。GitHub が再送してくれる
    log(`[webhook] ジョブを積めませんでした: ${String(error)}`);
    return { status: 500, body: { error: "failed to enqueue" } };
  }
}
