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
