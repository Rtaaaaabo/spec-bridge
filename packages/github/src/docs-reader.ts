import { parseDocFile, type FeatureDoc } from "@spec-bridge/core";
import type { Octokit } from "octokit";
import { parseRepoFullName } from "./octokit.ts";

/** 機能ドキュメントの置き場所（docs リポジトリのルートからの相対）。`DocStore` と同じ */
const FEATURES_PREFIX = "features/";

/** blob を同時に取りに行く数。GitHub の二次レート制限に当たらない程度に抑える */
const BLOB_CONCURRENCY = 8;

export interface ReadDocsResult {
  docs: FeatureDoc[];
  /** 読んだ ref（既定ブランチ名） */
  ref: string;
  /**
   * 読んだ時点のコミット。書き戻すときに「読んでから誰も積んでいない」ことを確かめるのに使う。
   * 空のリポジトリでは null
   */
  commitSha: string | null;
  /** FeatureDoc として読めなかったファイル。手で壊された可能性がある */
  skipped: string[];
}

/**
 * docs リポジトリの `features/*.md` を GitHub から直接読む。
 *
 * 画面がサーバーのローカルディレクトリ（`SPEC_BRIDGE_DOCS_PATH`）を読んでいると、
 * docs の PR をマージしても `git pull` するまで一覧に出ず、本番ではそもそも置き場所が無い。
 * **マージされたものがそのまま見える**ように、既定ブランチを読む。
 *
 * ツリーを1回で引いてから blob を取るので、API 呼び出しは「2 + ファイル数」回。
 */
export async function readDocsFromRepo(octokit: Octokit, repo: string): Promise<ReadDocsResult> {
  const { owner, repo: name } = parseRepoFullName(repo);
  const { data: info } = await octokit.rest.repos.get({ owner, repo: name });
  const ref = info.default_branch;

  let entries: { path: string; sha: string }[];
  let commitSha: string;
  try {
    // ブランチ名ではなくコミットで引く。読んだものと、書き戻すときの起点を一致させるため
    const { data: head } = await octokit.rest.git.getRef({ owner, repo: name, ref: `heads/${ref}` });
    commitSha = head.object.sha;
    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo: name,
      tree_sha: commitSha,
      recursive: "true",
    });
    entries = tree.tree
      .filter((e) => e.type === "blob" && e.path && e.sha)
      .map((e) => ({ path: e.path!, sha: e.sha! }));
  } catch (error) {
    // 空のリポジトリ（コミットが1つも無い）はツリーが引けない。まだ何も書いていないだけ
    if ((error as { status?: number }).status === 409 || (error as { status?: number }).status === 404) {
      return { docs: [], ref, commitSha: null, skipped: [] };
    }
    throw error;
  }

  // features/ 直下の .md だけ（DocStore と同じ範囲）
  const targets = entries.filter((e) => {
    if (!e.path.startsWith(FEATURES_PREFIX) || !e.path.endsWith(".md")) return false;
    return !e.path.slice(FEATURES_PREFIX.length).includes("/");
  });

  const docs: FeatureDoc[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < targets.length; i += BLOB_CONCURRENCY) {
    const batch = targets.slice(i, i + BLOB_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const { data: blob } = await octokit.rest.git.getBlob({ owner, repo: name, file_sha: entry.sha });
        const raw = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
        return { path: entry.path, doc: parseDocFile(raw) };
      }),
    );
    for (const { path, doc } of results) {
      if (doc) docs.push(doc);
      else skipped.push(path);
    }
  }

  docs.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  return { docs, ref, commitSha, skipped };
}
