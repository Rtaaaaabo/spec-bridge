import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * エラーメッセージから認証トークンを伏せる。
 *
 * クローン URL にトークンを埋め込んでいるため、git の失敗メッセージがそのまま
 * ログに出るとトークンが漏れる。
 */
export function maskToken(message: string): string {
  // URL の userinfo 部（`user:password@` / `x-access-token:token@`）をまるごと伏せる。
  // 2段構えにすると「1段目でマスクした結果を2段目がさらに置換する」ような
  // 順序依存の穴ができるので、1回の置換で済ませる。
  return message.replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
}

export interface CheckoutOptions {
  repo: string;
  /** この SHA の状態を取り出す。省略時は既定ブランチの最新 */
  sha?: string | null;
  /** プライベートリポジトリ用。URL に埋め込むのでログには出さない */
  token?: string;
}

export interface Checkout {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * 解析用にリポジトリを一時ディレクトリへ浅くクローンする。
 *
 * サーバー上で動かす場合、ローカルチェックアウトは存在しないのでここで用意する。
 * **ソースコードは永続化しない** — 解析が終わったら `cleanup()` で消す。
 */
export async function checkoutForAnalysis(options: CheckoutOptions): Promise<Checkout> {
  const dir = await mkdtemp(join(tmpdir(), "spec-bridge-repo-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };

  // トークンは URL に埋め込まれるため、失敗時のメッセージにも載らないよう注意する
  const url = options.token
    ? `https://x-access-token:${options.token}@github.com/${options.repo}.git`
    : `https://github.com/${options.repo}.git`;

  try {
    if (options.sha) {
      // 特定コミットだけを取得する（履歴全体を落とさない）
      await run("git", ["init", "--quiet", dir]);
      await run("git", ["-C", dir, "remote", "add", "origin", url]);
      await run("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", options.sha]);
      await run("git", ["-C", dir, "checkout", "--quiet", "FETCH_HEAD"]);
    } else {
      await run("git", ["clone", "--quiet", "--depth", "1", url, dir]);
    }
  } catch (error) {
    await cleanup();
    const message = error instanceof Error ? error.message : String(error);
    // トークンが混入しないようマスクする
    throw new Error(
      `リポジトリの取得に失敗しました: ${options.repo}\n${maskToken(message)}`,
    );
  }

  return { path: dir, cleanup };
}

/**
 * git remote の URL から `org/repo` を取り出す。
 *
 * バックフィルはローカルのチェックアウトを起点にするので、PR と違って
 * リポジトリ名がどこにも書かれていない。出典の帰属先になる重要な値なので、
 * 推測を間違えるとマルチリポジトリの保護（`preserveForeign`）が誤動作する。
 */
export function parseRepoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  // https://github.com/org/repo(.git) / git@github.com:org/repo(.git) / ssh://git@github.com/org/repo
  const match = trimmed.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

export interface CheckoutState {
  /** HEAD のコミット。git リポジトリでなければ null */
  sha: string | null;
  /** 追跡ファイルに未コミットの変更があるか */
  dirty: boolean;
}

/**
 * ローカルチェックアウトの状態を見る。
 *
 * バックフィルの提出 PR に「どの状態のコードから起こしたか」を書くために使う。
 * **作業ツリーが汚れていれば、その SHA は起点として嘘になる**ので、
 * 呼び出し側が「コミットに紐づいていない」と書けるよう、汚れも一緒に返す。
 */
export async function detectCheckoutState(repoPath: string): Promise<CheckoutState> {
  try {
    const { stdout: sha } = await run("git", ["-C", repoPath, "rev-parse", "HEAD"]);
    const { stdout: status } = await run("git", ["-C", repoPath, "status", "--porcelain", "-uno"]);
    return { sha: sha.trim() || null, dirty: status.trim().length > 0 };
  } catch {
    // git リポジトリでない、コミットが1つもない、など
    return { sha: null, dirty: false };
  }
}

/** ローカルチェックアウトの origin から `org/repo` を推測する */
export async function detectRepoName(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return parseRepoFromRemoteUrl(stdout);
  } catch {
    return null;
  }
}
