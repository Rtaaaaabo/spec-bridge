import { cookies } from "next/headers";
import { ALLOWLIST_HINT, isAllowedLogin } from "@/lib/access";
import { allowedLogins, baseUrl, oauthConfig, sessionSecret } from "@/lib/config";
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

    // OAuth を通っただけでは「GitHub アカウントを持っている」しか分からない
    if (!isAllowedLogin(viewer.login, allowedLogins())) {
      console.warn(`[oauth] 許可されていないログインを拒否しました: ${viewer.login}`);
      return Response.json(
        { error: `${viewer.login} はログインを許可されていません。${ALLOWLIST_HINT}` },
        { status: 403 },
      );
    }

    const session = await signSession(newSession(viewer), sessionSecret());

    // プロキシの裏では request.url が http で届くので、公開 URL の設定から決める
    // （`url.protocol` を見ていたため、HTTPS なのに Secure が付かなかった）
    const secure = baseUrl().startsWith("https:") ? " Secure;" : "";
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
