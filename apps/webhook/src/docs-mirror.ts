import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepoFullName, type Octokit } from "@spec-bridge/github";

/**
 * docs リポジトリの `features/*.md` をローカルの作業ディレクトリへ展開する。
 *
 * 取り込んでから解析しないと、毎回「新規作成」になって既存の記述を引き継げない。
 * `ref` を渡すと、その枝（バックフィルのランのブランチ）から読む。
 * 枝がまだ無い場合は既定ブランチにフォールバックする（ランの1件目）。
 */
export async function fetchDocsFromRepo(
  octokit: Octokit,
  docsRepo: string,
  destination: string,
  options: { ref?: string; log?: (line: string) => void } = {},
): Promise<number> {
  const { owner, repo } = parseRepoFullName(docsRepo);
  const log = options.log ?? (() => {});

  for (const ref of options.ref ? [options.ref, undefined] : [undefined]) {
    const count = await copyFeatures(octokit, owner, repo, destination, ref);
    if (count !== null) return count;
  }
  log("  docs リポジトリに既存ドキュメントはありません");
  return 0;
}

/** 取得できたら件数、ディレクトリ自体が無ければ null（呼び出し側がフォールバックを判断する） */
async function copyFeatures(
  octokit: Octokit,
  owner: string,
  repo: string,
  destination: string,
  ref: string | undefined,
): Promise<number | null> {
  try {
    const listing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "features",
      ...(ref ? { ref } : {}),
    });
    if (!Array.isArray(listing.data)) return null;

    await mkdir(join(destination, "features"), { recursive: true });

    let count = 0;
    for (const entry of listing.data) {
      if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
      const file = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: entry.path,
        ...(ref ? { ref } : {}),
      });
      if (Array.isArray(file.data) || file.data.type !== "file") continue;
      await writeFile(
        join(destination, "features", entry.name),
        Buffer.from(file.data.content, "base64").toString("utf8"),
        "utf8",
      );
      count += 1;
    }
    return count;
  } catch {
    // features ディレクトリがまだ無い（初回）、またはその ref が無い
    return null;
  }
}
