import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook の署名を検証する。
 *
 * これが唯一の認証。**検証前のペイロードを一切信用してはいけない。**
 * タイミング攻撃を避けるため、比較は `timingSafeEqual` を使う。
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const received = signatureHeader.trim();

  // 長さが違うと timingSafeEqual が例外を投げるので先に弾く
  if (expected.length !== received.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

/**
 * その PR が docs リポジトリ自身のものか。
 *
 * docs リポジトリに App をインストールすると、生成された PR をマージするたびに
 * webhook が発火し、docs リポジトリ自身を解析して次の PR を作る**無限ループ**になる。
 * インストール漏れではなく仕組み上の事故なので、コード側で止める。
 */
export function isDocsRepoEvent(repo: string, docsRepo: string): boolean {
  return repo.trim().toLowerCase() === docsRepo.trim().toLowerCase();
}

export interface MergedPullRequestEvent {
  repo: string;
  number: number;
  mergeCommitSha: string | null;
  installationId: number | null;
}

interface PullRequestWebhookPayload {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
  };
  repository?: { full_name?: string };
  installation?: { id?: number };
}

/**
 * webhook のペイロードから「マージされた PR」だけを取り出す。
 * それ以外（オープン、クローズのみ、他イベント）は null を返して無視する。
 */
export function parseMergedPullRequest(
  event: string | null | undefined,
  payload: unknown,
): MergedPullRequestEvent | null {
  if (event !== "pull_request") return null;

  const p = payload as PullRequestWebhookPayload;
  if (p.action !== "closed") return null;
  if (p.pull_request?.merged !== true) return null;

  const repo = p.repository?.full_name;
  const number = p.pull_request.number;
  if (!repo || typeof number !== "number") return null;

  return {
    repo,
    number,
    mergeCommitSha: p.pull_request.merge_commit_sha ?? null,
    installationId: p.installation?.id ?? null,
  };
}

export interface InstallationEvent {
  /** `created` / `deleted` / `new_permissions_accepted` など */
  action: string;
  installationId: number;
  account: string;
  /** インストールが消えたか（テナントを消してよいか） */
  removed: boolean;
}

interface InstallationWebhookPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; name?: string } | null;
  };
}

/**
 * `installation` / `installation_repositories` イベントを取り出す。
 *
 * これを受け取って初めて「誰が使っているか」が分かる。
 * **提出先の設定は installation に紐づく**ので、まずこの記録が要る。
 */
export function parseInstallationEvent(
  event: string | null | undefined,
  payload: unknown,
): InstallationEvent | null {
  if (event !== "installation" && event !== "installation_repositories") return null;

  const p = payload as InstallationWebhookPayload;
  const installationId = p.installation?.id;
  if (typeof installationId !== "number") return null;

  const account = p.installation?.account;
  return {
    action: p.action ?? "",
    installationId,
    account: account?.login ?? account?.name ?? "?",
    // suspend は「止まっているだけ」で設定は残したいので、消すのは deleted だけ
    removed: p.action === "deleted",
  };
}
