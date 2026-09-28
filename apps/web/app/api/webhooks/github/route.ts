import { handleWebhookDelivery } from "@spec-bridge/ingest";
import { PostgresJobStore } from "@spec-bridge/jobs";
import { PostgresTenantStore } from "@spec-bridge/tenants";
import { databaseUrl, webhookSecret } from "@/lib/config";

export const runtime = "nodejs";

/**
 * GitHub からの配信を受ける。
 *
 * **ログインの外側にある唯一の口**（`proxy.ts` の matcher から外してある）。
 * 認証は署名検証だけで、それは共有実装（`@spec-bridge/ingest`）が行う。
 *
 * 画面と同じプロセスに置いているのは、ホスト名を1つで済ませるため
 * （Fly は1つのホスト名を複数プロセスへ振り分けられない）。
 * **ここでは積むだけ**なので、重い依存は要らない。
 */
export async function POST(request: Request): Promise<Response> {
  const jobs = new PostgresJobStore(databaseUrl());
  const tenants = new PostgresTenantStore(databaseUrl());

  try {
    const result = await handleWebhookDelivery(
      {
        rawBody: await request.text(),
        event: request.headers.get("x-github-event"),
        signature: request.headers.get("x-hub-signature-256"),
      },
      {
        secret: webhookSecret(),
        jobs,
        tenants,
        log: (line) => console.log(line),
      },
    );
    return Response.json(result.body, { status: result.status });
  } finally {
    await Promise.all([jobs.close(), tenants.close()]);
  }
}
