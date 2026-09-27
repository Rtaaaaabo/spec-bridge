import { askSupportQuestion } from "@spec-bridge/core";
import { currentSession } from "@/lib/auth";
import { docsPath } from "@/lib/config";

// Agent SDK は Node のネイティブバイナリを使うので Edge では動かない
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  // middleware は Cookie の有無しか見ていない。署名の検証はここで行う
  if (!(await currentSession())) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    if (typeof body.question !== "string" || body.question.trim() === "") {
      return Response.json({ error: "question が空です" }, { status: 400 });
    }
    question = body.question.trim();
  } catch {
    return Response.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  try {
    const result = await askSupportQuestion(question, { docsPath: docsPath() });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ask]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
