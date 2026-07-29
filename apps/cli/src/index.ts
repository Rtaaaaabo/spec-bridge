#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runPipeline } from "@spec-bridge/core";
import { fetchPullRequest, parsePullRequestRef } from "@spec-bridge/github";

/**
 * .env を読み込む。ワークスペースルート → カレントディレクトリの順に探す。
 * `pnpm --filter` 経由だと cwd が apps/cli になるため、ルートからの解決が必要。
 */
function loadEnvFile(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const candidate of [resolve(repoRoot, ".env"), resolve(process.cwd(), ".env")]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
loadEnvFile();

const USAGE = `spec-bridge — マージされた PR から機能仕様ドキュメントを生成・更新する

使い方:
  spec-bridge analyze --pr <PR> --repo <path> --docs <path> [options]

引数:
  --pr     <ref>    PR の URL または owner/repo#123
  --repo   <path>   解析対象リポジトリのローカルチェックアウト
  --docs   <path>   機能ドキュメントの出力先ディレクトリ

オプション:
  --force           仕様に影響しないと判定されても解析する
  --allow-bash      エージェントに Bash を許可する（git log 等を辿れる）
  --token   <token> GitHub トークン（省略時は GITHUB_TOKEN）
  --quiet           進捗ログを抑制する
  -h, --help        このヘルプを表示

例:
  spec-bridge analyze \\
    --pr https://github.com/acme/backend/pull/482 \\
    --repo ~/dev/acme-backend \\
    --docs ~/dev/acme-specs
`;

async function assertDirectory(path: string, label: string): Promise<string> {
  const abs = resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  try {
    const info = await stat(abs);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${label} がディレクトリとして見つかりません: ${abs}`);
  }
  return abs;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      docs: { type: "string" },
      token: { type: "string" },
      force: { type: "boolean", default: false },
      "allow-bash": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals[0] !== "analyze") {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!values.pr || !values.repo || !values.docs) {
    console.error("エラー: --pr, --repo, --docs は必須です。\n");
    console.log(USAGE);
    return 1;
  }

  const log = values.quiet ? () => {} : (line: string) => console.log(line);

  const repoPath = await assertDirectory(values.repo, "--repo");
  const docsPath = resolve(values.docs.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));

  const ref = parsePullRequestRef(values.pr);
  log(`▸ PR を取得中: ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = await fetchPullRequest(
    ref,
    values.token ? (await import("@spec-bridge/github")).createOctokit(values.token) : undefined,
  );
  log(`  ${pr.title}（${pr.changedFiles.length} ファイル変更）`);

  const result = await runPipeline(pr, {
    repoPath,
    docsPath,
    force: values.force,
    allowBash: values["allow-bash"],
    log,
  });

  console.log("");
  if (result.skipped) {
    console.log("── 結果 ──");
    console.log(`スキップ: ${result.classification.reason}`);
    console.log("（強制的に解析するには --force を付けてください）");
    return 0;
  }

  console.log("── 結果 ──");
  for (const doc of result.updated) {
    const b = doc.breakdown;
    console.log(`✓ ${doc.id}  確度 ${doc.confidence.toFixed(2)}`);
    console.log(`  ${doc.path}`);
    console.log(
      `  内訳: 出典の実在 ${b.sourceValidity.toFixed(2)} / ` +
        `変更ファイル読了 ${b.readCoverage.toFixed(2)} / ` +
        `出典の密度 ${b.citationDensity.toFixed(2)} / ` +
        `確定度 ${b.determinacy.toFixed(2)}` +
        `（モデル自己申告 ${b.selfReported.toFixed(2)}）`,
    );
    for (const w of doc.warnings) console.log(`  ⚠ ${w.detail}`);
    if (doc.openQuestions.length > 0) {
      console.log(`  ? 開発者への確認事項 ${doc.openQuestions.length} 件:`);
      for (const q of doc.openQuestions) console.log(`    - ${q}`);
    }
  }
  for (const f of result.failures) {
    console.log(`✗ ${f.id}: ${f.error}`);
  }

  return result.failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\nエラー: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
