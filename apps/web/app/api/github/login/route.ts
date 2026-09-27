import { randomUUID } from "node:crypto";
import { authorizeUrl } from "@/lib/oauth";
import { oauthConfig } from "@/lib/config";
import { STATE_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export function GET(): Response {
  const config = oauthConfig();
  if (!config) {
    return Response.json(
      { error: "GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET が未設定です" },
      { status: 500 },
    );
  }

  // 使い捨ての state。コールバックで Cookie と突き合わせる（他所から始められたログインを弾く）
  const state = randomUUID();
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(config, state),
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}
