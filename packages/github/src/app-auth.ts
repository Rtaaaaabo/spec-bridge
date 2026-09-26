import { readFileSync } from "node:fs";
import { App } from "octokit";
import { createOctokit, parseRepoFullName, type Octokit } from "./octokit.ts";

/**
 * GitHub App の資格情報。
 *
 * これを使って installation アクセストークンへ交換する。PAT と違い、
 * **トークンがインストール先のリポジトリに限定される**（テナント分離の土台）うえ、
 * レート制限も installation ごとに 5,000/時 になる。
 */
export interface AppCredentials {
  appId: string;
  /** PEM 形式の秘密鍵 */
  privateKey: string;
}

/**
 * 秘密鍵を PEM として使える形に整える。
 *
 * GitHub が配る `.pem` は複数行だが、env に入れるときは `\n` を literal で書くしかない。
 * どちらの形で渡されても同じ鍵として扱えるようにする。
 */
export function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

/**
 * env から App の資格情報を読む。未設定なら `null`（PAT 運用にフォールバックできる）。
 *
 * **半端な設定は `null` を返さずに投げる。** 「App を設定したつもりなのに、
 * 実は PAT で動いていた」が一番まずい失敗の仕方で、しかも気づけない。
 */
export function readAppCredentials(
  env: Record<string, string | undefined> = process.env,
): AppCredentials | null {
  const appId = env["GITHUB_APP_ID"]?.trim();
  const inlineKey = env["GITHUB_APP_PRIVATE_KEY"]?.trim();
  const keyPath = env["GITHUB_APP_PRIVATE_KEY_PATH"]?.trim();

  if (!appId && !inlineKey && !keyPath) return null;

  if (!appId) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY（または _PATH）が設定されていますが GITHUB_APP_ID がありません。",
    );
  }
  if (!inlineKey && !keyPath) {
    throw new Error(
      "GITHUB_APP_ID が設定されていますが秘密鍵がありません" +
        "（GITHUB_APP_PRIVATE_KEY または GITHUB_APP_PRIVATE_KEY_PATH）。",
    );
  }

  const privateKey = normalizePrivateKey(
    inlineKey ?? readFileSync(keyPath as string, "utf8"),
  );
  if (!privateKey.includes("BEGIN")) {
    throw new Error(
      "GitHub App の秘密鍵が PEM 形式に見えません（`-----BEGIN ...` で始まる必要があります）。",
    );
  }

  return { appId, privateKey };
}

/**
 * 起動時チェック用。認証設定の問題を文章で返す（空配列なら問題なし）。
 *
 * `resolveGitHubAuth()` は投げるので、起動時に全部の問題を並べて見せるにはこちらを使う。
 */
export function checkGitHubAuthConfig(
  env: Record<string, string | undefined> = process.env,
): string[] {
  try {
    if (readAppCredentials(env)) return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (!env["GITHUB_TOKEN"]?.trim()) {
    return [
      "GitHub の認証情報が未設定です（GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY を推奨、" +
        "単一組織なら GITHUB_TOKEN でも動きます）",
    ];
  }
  return [];
}

export interface InstallationToken {
  token: string;
  /** 失効時刻（epoch ミリ秒） */
  expiresAt: number;
}

export type MintInstallationToken = (installationId: number) => Promise<InstallationToken>;

/**
 * 失効の何ミリ秒前にトークンを捨てるか。
 *
 * installation トークンの寿命は1時間。解析は数分〜30分かかるので、
 * 「取得直後は有効だが処理中に切れる」を避けるために手前で捨てる。
 */
export const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * installation トークンのキャッシュ。
 *
 * 交換は App の JWT を使った API 呼び出しなので、1リクエストごとに引くと無駄が大きい。
 * 有効なあいだは使い回し、失効が近づいたら作り直す。
 */
export class InstallationTokenStore {
  private readonly cache = new Map<number, InstallationToken>();
  /** 同じ installation について交換を二重に走らせないための進行中の約束 */
  private readonly inflight = new Map<number, Promise<InstallationToken>>();
  private readonly marginMs: number;
  private readonly now: () => number;

  constructor(
    private readonly mint: MintInstallationToken,
    options: { marginMs?: number; now?: () => number } = {},
  ) {
    this.marginMs = options.marginMs ?? TOKEN_MARGIN_MS;
    this.now = options.now ?? Date.now;
  }

  async get(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - this.marginMs > this.now()) return cached.token;

    const pending = this.inflight.get(installationId);
    if (pending) return (await pending).token;

    const promise = this.mint(installationId);
    this.inflight.set(installationId, promise);
    try {
      const minted = await promise;
      this.cache.set(installationId, minted);
      return minted.token;
    } finally {
      this.inflight.delete(installationId);
    }
  }
}

/** 1リポジトリを操作するための認証。REST と git clone の両方に必要なものを揃える */
export interface RepoAuth {
  octokit: Octokit;
  /** クローン URL に埋め込む生のトークン。**ログに出さない**（`maskToken` 参照） */
  token: string;
}

/**
 * リポジトリごとに認証を解決する口。
 *
 * App 運用（installation トークン）と PAT 運用の違いを、呼び出し側から隠す。
 * webhook / ジョブ実行側は「このリポジトリを触りたい」だけを言えばよい。
 */
export interface GitHubAuth {
  /** どちらの方式で動いているか。起動ログと運用の切り分けに使う */
  readonly kind: "app" | "token";
  /**
   * @param repo `owner/repo`
   * @param installationId webhook のペイロードに入っていれば渡す（App の JWT 呼び出しを1回省ける）
   */
  forRepo(repo: string, installationId?: number | null): Promise<RepoAuth>;
}

/** PAT 1本で全リポジトリを触る認証。単一組織向け */
export function createTokenAuth(token: string): GitHubAuth {
  const octokit = createOctokit(token);
  return {
    kind: "token",
    forRepo: async () => ({ octokit, token }),
  };
}

/**
 * GitHub App の installation トークンで認証する。
 *
 * `installationId` が分からない場合は「そのリポジトリにどの installation が入っているか」を
 * App の JWT で引く。**App が入っていないリポジトリは 404 になる**ので、
 * 「入れ忘れ」が黙って別の認証で成功することはない。
 */
export function createAppInstallationAuth(credentials: AppCredentials): GitHubAuth {
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });

  const tokens = new InstallationTokenStore(async (installationId) => {
    const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
    });
    return { token: data.token, expiresAt: Date.parse(data.expires_at) };
  });

  // repo → installation id。インストールし直すと変わるが、プロセスの寿命では十分
  const installationIds = new Map<string, number>();

  async function resolveInstallationId(fullName: string): Promise<number> {
    const key = fullName.trim().toLowerCase();
    const cached = installationIds.get(key);
    if (cached !== undefined) return cached;

    const { owner, repo } = parseRepoFullName(fullName);
    try {
      const { data } = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
      installationIds.set(key, data.id);
      return data.id;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        throw new Error(
          `GitHub App が ${fullName} にインストールされていません。` +
            `App の Install App から対象に追加してください。`,
        );
      }
      throw error;
    }
  }

  return {
    kind: "app",
    async forRepo(repo, installationId) {
      const id = installationId ?? (await resolveInstallationId(repo));
      const token = await tokens.get(id);
      return { octokit: createOctokit(token), token };
    },
  };
}

/**
 * env から認証方式を決める。App の資格情報があればそれを使い、無ければ PAT。
 *
 * 移行のあいだ両方を同居させるための分岐。App 側が設定されていれば必ず App を使う
 * （「設定したのに PAT で動いていた」を作らない）。
 */
export function resolveGitHubAuth(
  env: Record<string, string | undefined> = process.env,
): GitHubAuth {
  const credentials = readAppCredentials(env);
  if (credentials) return createAppInstallationAuth(credentials);

  const token = env["GITHUB_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "GitHub の認証情報がありません。GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY（推奨）か " +
        "GITHUB_TOKEN を設定してください。",
    );
  }
  return createTokenAuth(token);
}
