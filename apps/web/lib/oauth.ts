/**
 * GitHub App の user-to-server OAuth。
 *
 * **ログインとインストールの主体を揃える**ための選択。別の OAuth App を用意すると、
 * 「ログインした人」と「App を入れた人」の対応表を自前で持つことになる。
 * 同じ App でログインすれば、その人が見られるインストールを GitHub 側に聞ける。
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** コールバックの絶対 URL。App の設定と一致している必要がある */
  redirectUri: string;
}

export function readOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): OAuthConfig | null {
  const clientId = env["GITHUB_APP_CLIENT_ID"]?.trim();
  const clientSecret = env["GITHUB_APP_CLIENT_SECRET"]?.trim();
  const baseUrl = (env["SPEC_BRIDGE_BASE_URL"] ?? "http://localhost:3000").trim();

  if (!clientId && !clientSecret) return null;
  // 半端な設定で「ログインできるつもり」にさせない（認証まわりの片肺は黙って通さない）
  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID と GITHUB_APP_CLIENT_SECRET は両方必要です（片方だけ設定されています）。",
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl.replace(/\/$/, "")}/api/github/callback`,
  };
}

/** 認可画面の URL。`state` は Cookie と突き合わせて CSRF を防ぐ */
export function authorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * コールバックの `state` を検証する。
 *
 * Cookie に入れた値と一致しなければ、こちらが始めたログインではない。
 */
export function isValidState(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  if (received.length !== expected.length) return false;
  // 長さが同じなので、素直な比較でよい（値は使い捨ての乱数）
  return received === expected;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** `code` をユーザーのアクセストークンに交換する */
export async function exchangeCode(config: OAuthConfig, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  const data = (await response.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`アクセストークンを取得できませんでした: ${data.error_description ?? "不明なエラー"}`);
  }
  return data.access_token;
}

/** ログインした本人を取得する */
export async function fetchViewer(token: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub のユーザー情報を取得できませんでした: ${response.status}`);

  const user = (await response.json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string | null;
  };
  return { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
}
