import { isValidDocId } from "@spec-bridge/core";
import { currentSession } from "@/lib/auth";
import { verifyDoc, VerifyError } from "@/lib/verify";

export const runtime = "nodejs";

/**
 * 機能ドキュメントをレビュー済にする。docs リポジトリに書き込むので、ログインを必ず確かめる。
 * 誰が押したかは変更履歴とコミットメッセージに残る。
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { id } = await params;
  if (!isValidDocId(id)) {
    return Response.json({ error: "機能ドキュメントの ID が不正です" }, { status: 400 });
  }

  try {
    return Response.json(await verifyDoc(id, session.login));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof VerifyError ? error.status : 500;
    console.error("[verify]", message);
    return Response.json({ error: message }, { status });
  }
}
