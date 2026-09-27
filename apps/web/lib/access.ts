/**
 * 誰がログインしてよいか。
 *
 * OAuth を通っただけでは「GitHub アカウントを持っている」しか分からない。
 * 画面には機能ドキュメント（内部のファイルパス・仕様）が出るうえ、
 * **`/runs` からランを開始できる＝お金を使わせられる**ので、明示した人だけを通す。
 *
 * 本筋は「そのインストールのアカウントに属する人」だが、
 * それには GitHub への問い合わせが要る。まず許可リストで塞ぐ。
 */

/**
 * 許可する GitHub ログイン名。**未設定は「誰も通さない」。**
 *
 * 未設定を「全員許可」にすると、設定を忘れたまま公開したときに全部見えてしまう。
 * 設定漏れは事故だが、事故の向きは安全側に倒す
 * （`SPEC_BRIDGE_SESSION_SECRET` が未設定なら誰も通さないのと同じ考え方）。
 */
export function readAllowedLogins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env["SPEC_BRIDGE_ALLOWED_LOGINS"] ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
}

/** GitHub のログイン名は大文字小文字を区別しない */
export function isAllowedLogin(login: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.includes(login.trim().toLowerCase());
}

/** 設定されていないときに画面へ出す説明 */
export const ALLOWLIST_HINT =
  "SPEC_BRIDGE_ALLOWED_LOGINS に、ログインを許可する GitHub のユーザー名をカンマ区切りで設定してください（例: octocat,hubot）。";
