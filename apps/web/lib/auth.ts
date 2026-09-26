import { cookies } from "next/headers";
import { sessionSecret } from "./config.ts";
import { SESSION_COOKIE, verifySession, type Session } from "./session.ts";

/**
 * ログインしている本人を返す。**これが本当の認証。**
 *
 * `middleware.ts` は Cookie の有無しか見ない（Edge ランタイムからは
 * モノレポルートの `.env` を読めず、署名鍵を持てないため）。
 * **画面と API は必ずこの関数を通すこと。** 通さない経路を1つ作ると、そこが穴になる。
 */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  try {
    return await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  } catch {
    // 署名鍵が未設定。素通しにせず、ログインしていない扱いにする
    return null;
  }
}
