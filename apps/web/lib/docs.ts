import { DocStore, isValidDocId, type FeatureDoc } from "@spec-bridge/core";
import { readDocsFromRepo, resolveGitHubAuth } from "@spec-bridge/github";
import { fallbackDocsRepo, localDocsPath } from "./config.ts";
import { tenantsByInstallation } from "./tenants.ts";

/** どこから読んだか。画面に出して、見ているものの出どころを分かるようにする */
export type DocsSource = { kind: "github"; repo: string; ref: string } | { kind: "local"; path: string };

export interface LoadedDocs {
  docs: FeatureDoc[];
  source: DocsSource;
  /** 利用者に知らせたいこと（読めなかったファイル、複数の docs リポジトリなど） */
  notices: string[];
}

/**
 * 読んだ結果を覚えておく時間。画面を開くたびに「2 + ファイル数」回 API を叩かないため。
 * docs の PR をマージしてから一覧に出るまで、最大でこの時間だけ遅れる。
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: LoadedDocs }>();

/**
 * 画面が読む docs リポジトリの候補。リポジトリごとの設定（テナント表）→ `SPEC_BRIDGE_DOCS_REPO` の順。
 * テナント表は DB が無いと引けないので、引けなければ env だけで決める。
 */
async function docsRepoCandidates(): Promise<string[]> {
  const repos: string[] = [];
  try {
    for (const tenant of (await tenantsByInstallation()).values()) {
      if (tenant.docsRepo) repos.push(tenant.docsRepo);
    }
  } catch {
    // DATABASE_URL が無いローカルなど。env の提出先に落ちる
  }
  const fallback = fallbackDocsRepo();
  if (fallback) repos.push(fallback);
  return [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
}

/**
 * 画面に出す機能ドキュメントを読む。
 *
 * **既定は GitHub の docs リポジトリ（既定ブランチ）。** マージされた docs がそのまま見える。
 * docs リポジトリが1つも決まらないときだけ、`SPEC_BRIDGE_DOCS_PATH`（ローカルのディレクトリ）を読む。
 *
 * いまは単一テナント運用なので、docs リポジトリが複数あっても1つ目だけを読み、そのことを知らせる。
 * 利用者ごとに見える範囲を分けるときに、ここをログイン中の利用者のテナントで絞る。
 */
export async function loadDocs(): Promise<LoadedDocs> {
  const repos = await docsRepoCandidates();
  const repo = repos[0];

  if (!repo) {
    const path = localDocsPath();
    if (!path) {
      throw new Error(
        "読む docs リポジトリが決まっていません。「リポジトリ」の画面で提出先を設定するか、" +
          "SPEC_BRIDGE_DOCS_REPO を設定してください。",
      );
    }
    return { docs: await new DocStore(path).list(), source: { kind: "local", path }, notices: [] };
  }

  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const { octokit } = await resolveGitHubAuth().forRepo(repo);
  const result = await readDocsFromRepo(octokit, repo);
  const notices: string[] = [];
  if (repos.length > 1) {
    notices.push(`docs リポジトリが ${repos.length} つあります。いまは ${repo} だけを表示しています。`);
  }
  if (result.skipped.length > 0) {
    notices.push(`機能ドキュメントとして読めなかったファイルがあります: ${result.skipped.join(", ")}`);
  }
  const value: LoadedDocs = {
    docs: result.docs,
    source: { kind: "github", repo, ref: result.ref },
    notices,
  };
  cache.set(repo, { at: Date.now(), value });
  return value;
}

/**
 * 画面が読み書きする docs リポジトリ。`loadDocs` と同じ決め方。
 * 1つも決まらなければ null（ローカルのディレクトリを使う）
 */
export async function viewerDocsRepo(): Promise<string | null> {
  return (await docsRepoCandidates())[0] ?? null;
}

/** 書き込んだあとに呼ぶ。次に開いたときに、書いた内容が見えるようにする */
export function invalidateDocsCache(repo: string): void {
  cache.delete(repo);
}

/** 1件だけ。一覧と同じ読み方（同じキャッシュ）を通す */
export async function loadDoc(id: string): Promise<{ doc: FeatureDoc; source: DocsSource } | null> {
  if (!isValidDocId(id)) return null;
  const { docs, source } = await loadDocs();
  const doc = docs.find((d) => d.meta.id === id);
  return doc ? { doc, source } : null;
}
