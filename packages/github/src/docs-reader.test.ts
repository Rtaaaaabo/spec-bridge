import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDocFile, type FeatureDoc } from "@spec-bridge/core";
import type { Octokit } from "octokit";
import { readDocsFromRepo } from "./docs-reader.ts";

function doc(id: string): FeatureDoc {
  return {
    meta: {
      id,
      status: "draft",
      owners: [],
      repos: ["acme/backend"],
      issueKeys: [],
      updatedAt: "2026-10-01",
      updatedByPRs: [],
      confidence: 0.8,
    },
    body: {
      title: `${id} の機能`,
      summary: `${id} の要約`,
      overview: "概要",
      userBehavior: [],
      screens: [],
      endpoints: [],
      permissions: [],
      rules: [{ text: "ルール", sources: [{ repo: "acme/backend", file: "a.ts", line: 1, pr: null }] }],
      limitations: [],
      featureFlags: [],
      testPoints: { normal: [], abnormal: [], regression: [], e2e: [] },
      glossary: [],
      openQuestions: [],
    },
    changelog: [],
  };
}

/** docs リポジトリを、パス → 中身 で表した偽の GitHub。呼ばれた blob を記録する */
function fakeOctokit(files: Record<string, string>, options: { treeStatus?: number } = {}) {
  const fetched: string[] = [];
  const octokit = {
    rest: {
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
      git: {
        getRef: async () => {
          if (options.treeStatus) throw Object.assign(new Error("tree"), { status: options.treeStatus });
          return { data: { object: { sha: "c0ffee" } } };
        },
        getTree: async ({ tree_sha }: { tree_sha: string }) => {
          // ブランチ名ではなく、getRef で引いたコミットからツリーを取る
          assert.equal(tree_sha, "c0ffee");
          return {
            data: {
              tree: [
                { type: "tree", path: "features", sha: "dir" },
                ...Object.keys(files).map((path) => ({ type: "blob", path, sha: path })),
              ],
            },
          };
        },
        getBlob: async ({ file_sha }: { file_sha: string }) => {
          fetched.push(file_sha);
          return {
            data: { encoding: "base64", content: Buffer.from(files[file_sha] ?? "").toString("base64") },
          };
        },
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, fetched };
}

test("features/ 直下の機能ドキュメントを読み、ID 順に返す", async () => {
  const { octokit } = fakeOctokit({
    "features/b-feature.md": renderDocFile(doc("b-feature")),
    "features/a-feature.md": renderDocFile(doc("a-feature")),
  });
  const result = await readDocsFromRepo(octokit, "acme/specs");
  assert.equal(result.ref, "main");
  assert.equal(result.commitSha, "c0ffee", "書き戻すときの起点に使う");
  assert.deepEqual(
    result.docs.map((d) => d.meta.id),
    ["a-feature", "b-feature"],
  );
  assert.deepEqual(result.skipped, []);
});

// 一覧（README.md）や確認事項（open-questions.md）は機能ドキュメントではない
test("features/ の外や、下の階層、.md 以外は読まない", async () => {
  const { octokit, fetched } = fakeOctokit({
    "README.md": "# 一覧",
    "open-questions.md": "# 確認事項",
    "features/nested/x.md": renderDocFile(doc("x")),
    "features/notes.txt": "メモ",
    "features/ok.md": renderDocFile(doc("ok")),
  });
  const result = await readDocsFromRepo(octokit, "acme/specs");
  assert.deepEqual(fetched, ["features/ok.md"]);
  assert.deepEqual(
    result.docs.map((d) => d.meta.id),
    ["ok"],
  );
});

test("読めないファイルは落とさず、skipped に名前を残す", async () => {
  const { octokit } = fakeOctokit({
    "features/broken.md": "手で壊されたファイル",
    "features/ok.md": renderDocFile(doc("ok")),
  });
  const result = await readDocsFromRepo(octokit, "acme/specs");
  assert.deepEqual(
    result.docs.map((d) => d.meta.id),
    ["ok"],
  );
  assert.deepEqual(result.skipped, ["features/broken.md"]);
});

// 作ったばかりの docs リポジトリは、まだ何も書いていないだけ。エラーにしない
test("空のリポジトリ（ツリーが引けない）は0件として扱う", async () => {
  const { octokit } = fakeOctokit({}, { treeStatus: 409 });
  const result = await readDocsFromRepo(octokit, "acme/specs");
  assert.deepEqual(result.docs, []);
});

test("権限などそれ以外の失敗は投げる", async () => {
  const { octokit } = fakeOctokit({}, { treeStatus: 403 });
  await assert.rejects(readDocsFromRepo(octokit, "acme/specs"), /tree/);
});
