/**
 * 署名付きセッション Cookie。
 *
 * `apps/web` にはこれまで認証が一切なく、`/api/ask` を誰でも叩けた。
 * 機能ドキュメントには内部のファイルパスと仕様が載るので、まず「誰が見ているか」を確定させる。
 *
 * 保存するのは GitHub のユーザー識別子だけ。**アクセストークンは Cookie に入れない**
 * （Cookie が漏れたときに、そのままリポジトリを触れる鍵にしない）。
 * Web Crypto を使うのは、Next の middleware（Edge ランタイム）でも同じコードで検証するため。
 */
export interface Session {
  /** GitHub のユーザー ID（数値）。login は変わりうるので識別子はこちらを使う */
  userId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** 失効時刻（epoch ミリ秒） */
  expiresAt: number;
}

export const SESSION_COOKIE = "sb_session";
export const STATE_COOKIE = "sb_oauth_state";
/** セッションの寿命。長すぎると、権限を失った人が見続けられる */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  // Buffer は ArrayBufferLike を共有しうるため、Web Crypto に渡せる形へ写し替える
  const decoded = Buffer.from(value, "base64url");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** セッションを署名付き文字列にする（`<payload>.<signature>`） */
export async function signSession(session: Session, secret: string): Promise<string> {
  if (!secret) throw new Error("セッションの署名鍵が空です");
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * 署名付き文字列からセッションを取り出す。**少しでも怪しければ null。**
 *
 * 署名の検証は `crypto.subtle.verify` に任せる（自前で文字列比較しない）。
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): Promise<Session | null> {
  if (!token || !secret) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(signature),
      encoder.encode(payload),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof session.userId !== "number" || typeof session.login !== "string") return null;
    if (typeof session.expiresAt !== "number" || session.expiresAt <= now) return null;
    return session;
  } catch {
    return null;
  }
}

/** ログイン直後のセッションを作る */
export function newSession(
  user: { id: number; login: string; name?: string | null; avatarUrl?: string | null },
  now: number = Date.now(),
): Session {
  return {
    userId: user.id,
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    expiresAt: now + SESSION_TTL_MS,
  };
}
