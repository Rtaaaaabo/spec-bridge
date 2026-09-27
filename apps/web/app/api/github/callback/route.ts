import { cookies } from "next/headers";
import { oauthConfig, sessionSecret } from "@/lib/config";
import { exchangeCode, fetchViewer, isValidState } from "@/lib/oauth";
import { newSession, signSession, SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const config = oauthConfig();
  if (!config) return Response.json({ error: "OAuth が設定されていません" }, { status: 500 });

  const url = new URL(request.url);
  const jar = await cookies();

  if (!isValidState(url.searchParams.get("state"), jar.get(STATE_COOKIE)?.value)) {
    // こちらが始めたログインではない
    return Response.json({ error: "state が一致しません" }, { status: 400 });
  }

  const code = url.searchParams.get("code");
  if (!code) return Response.json({ error: "code がありません" }, { status: 400 });

  try {
    const token = await exchangeCode(config, code);
    const viewer = await fetchViewer(token);
    const session = await signSession(newSession(viewer), sessionSecret());

    const secure = url.protocol === "https:" ? " Secure;" : "";
    return new Response(null, {
      status: 302,
      headers: [
        ["location", "/installations"],
        // アクセストークンは保存しない。必要なときに再取得する
        [
          "set-cookie",
          `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${SESSION_TTL_MS / 1000}`,
        ],
        ["set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0`],
      ],
    });
  } catch (error) {
    console.error("[oauth]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
