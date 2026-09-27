import { resolveGitHubAuth } from "@spec-bridge/github";
import { normalizeDocsRepo } from "@spec-bridge/tenants";
import { currentSession } from "@/lib/auth";
import { withTenants } from "@/lib/tenants";

export const runtime = "nodejs";

interface SetDocsRepoBody {
  installationId?: unknown;
  account?: unknown;
  docsRepo?: unknown;
}

/**
 * インストールの提出先を設定する。
 *
 * **保存前に、その App が本当にそのリポジトリを触れるか確かめる。**
 * 触れない提出先を保存すると、失敗するのは数分後の解析の最後になる。
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await currentSession())) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: SetDocsRepoBody;
  try {
    body = (await request.json()) as SetDocsRepoBody;
  } catch {
    return Response.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const installationId = Number(body.installationId);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return Response.json({ error: "installation が不正です" }, { status: 400 });
  }

  let docsRepo: string | null;
  try {
    docsRepo = normalizeDocsRepo(typeof body.docsRepo === "string" ? body.docsRepo : null);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  try {
    if (docsRepo) {
      // App が入っていないリポジトリを提出先にできてしまうと、解析の最後で落ちる
      await resolveGitHubAuth().forRepo(docsRepo);
    }

    const tenant = await withTenants(async (store) => {
      // webhook の installation イベントより先に画面から触られることがある
      await store.upsert({
        installationId,
        account: typeof body.account === "string" ? body.account : String(installationId),
      });
      return store.setDocsRepo(installationId, docsRepo);
    });

    return Response.json({ installationId, docsRepo: tenant?.docsRepo ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[installations]", message);
    return Response.json({ error: message }, { status: 400 });
  }
}
