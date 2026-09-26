import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/session.ts";

/**
 * ログイン画面への振り分け。**これは認証ではない。**
 *
 * Edge ランタイムからはモノレポルートの `.env` を読めないので、ここでは署名鍵を持てない。
 * したがって Cookie の**有無**しか見ていない。
 * **本当の検証はサーバー側の `currentSession()`**（`lib/auth.ts`）で、
 * 画面と API はそちらを必ず通す。
 */
export function middleware(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  // 画面はログインへ、API は 401（リダイレクトされた HTML を JSON として読ませない）
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/github|_next/static|_next/image|favicon.ico).*)"],
};
