import { Octokit } from "octokit";

export type { Octokit };

/**
 * トークンから Octokit を作る。
 *
 * **既定引数を置かない。** 以前は `token = process.env.GITHUB_TOKEN` だったため、
 * 渡し忘れがエラーにならず、プロセス全体のグローバルな認証情報で黙って動いた。
 * テナントごとに認証が変わる構成では、これは「別のテナントとして操作する」ことになる。
 * env から作りたい場合は `createOctokitFromEnv()` を明示的に呼ぶ。
 */
export function createOctokit(token: string): Octokit {
  if (!token.trim()) {
    throw new Error(
      "GitHub のトークンが空です。呼び出し側で認証情報を明示してください" +
        "（env から作る場合は createOctokitFromEnv を使う）。",
    );
  }
  return new Octokit({ auth: token });
}

/**
 * `GITHUB_TOKEN` から Octokit を作る。**単一テナントのローカル利用（CLI）向け。**
 *
 * webhook サーバーからは呼ばない。あちらは installation ごとに認証が変わるため、
 * `resolveGitHubAuth()`（`app-auth.ts`）経由で取得する。
 */
export function createOctokitFromEnv(
  env: Record<string, string | undefined> = process.env,
): Octokit {
  const token = env["GITHUB_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN が設定されていません。.env に設定するか --token で渡してください。",
    );
  }
  return createOctokit(token);
}

/**
 * `owner/repo` を分解する。
 *
 * 認証・クローン・PR 作成の入口すべてでこの形の文字列を受け取るので、
 * 解釈を1箇所に集める。空要素（`acme/`）や3階層（`a/b/c`）は弾く。
 */
export function parseRepoFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.trim().split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) {
    throw new Error(`リポジトリ名を解釈できません: ${JSON.stringify(fullName)}（owner/repo の形式）`);
  }
  return { owner, repo };
}
