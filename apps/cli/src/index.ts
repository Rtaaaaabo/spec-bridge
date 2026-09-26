#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  coverageLabel,
  formatQuestion,
  formatUsageSummary,
  QUESTION_KIND_LABEL,
  QUESTION_KINDS,
  questionsOfKind,
  runBackfill,
  runPipeline,
  type RunResult,
  type UsageSummary,
} from "@spec-bridge/core";
import {
  checkGitHubAuthConfig,
  checkoutForAnalysis,
  createOctokit,
  createOctokitFromEnv,
  detectRepoName,
  fetchPullRequest,
  inspectApp,
  listInstallationRepositories,
  parsePullRequestRef,
  parseRepoFullName,
  readAppCredentials,
  resolveGitHubAuth,
  type GitHubAuth,
} from "@spec-bridge/github";

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

const USAGE = `spec-bridge — コードから機能仕様ドキュメントを生成・更新する

使い方:
  spec-bridge analyze    --pr <PR> --repo <path> --docs <path> [options]
  spec-bridge backfill   --repo <path> --docs <path> [options]
  spec-bridge check-auth [options]

analyze — マージされた PR ひとつを反映する
  --pr     <ref>    PR の URL または owner/repo#123
  --repo   <path>   解析対象リポジトリのローカルチェックアウト
  --docs   <path>   機能ドキュメントの出力先ディレクトリ
  --force           仕様に影響しないと判定されても解析する
  --token   <token> GitHub トークン（省略時は GITHUB_TOKEN）

backfill — いまのコードから一式を書き起こす（初回導入用）
  --repo   <path>   解析対象リポジトリのローカルチェックアウト
  --docs   <path>   機能ドキュメントの出力先ディレクトリ
  --limit  <n>      生成する機能数の上限（既定 20）
  --repo-name <org/repo>  省略時は git remote origin から推測する

check-auth — GitHub の認証設定を確かめる（LLM を呼ばないので無料）
  --repo-name <org/repo>  解析対象として読めるか確かめる
  --docs-repo <org/repo>  提出先として読めるか確かめる（省略時は SPEC_BRIDGE_DOCS_REPO）
  --clone                 トークンで実際に浅いクローンができるかまで確かめる（すぐ破棄する）

共通オプション:
  --allow-bash      エージェントに Bash を許可する（git log 等を辿れる）
  --quiet           進捗ログを抑制する
  -h, --help        このヘルプを表示

例:
  spec-bridge analyze \\
    --pr https://github.com/acme/backend/pull/482 \\
    --repo ~/dev/acme-backend \\
    --docs ~/dev/acme-specs

  spec-bridge backfill --repo ~/dev/acme-backend --docs ~/dev/acme-specs --limit 10

  spec-bridge check-auth --repo-name acme/backend --clone
`;

/** 先頭の `~` をホームディレクトリへ展開して絶対パスにする */
function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

async function assertDirectory(path: string, label: string): Promise<string> {
  const abs = expandHome(path);
  try {
    const info = await stat(abs);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${label} がディレクトリとして見つかりません: ${abs}`);
  }
  return abs;
}

/** 生成されたドキュメント1件分の結果を表示する */
function reportDoc(doc: RunResult["updated"][number]): void {
  const b = doc.breakdown;
  console.log(`✓ ${doc.id}  確度 ${doc.confidence.toFixed(2)}`);
  console.log(`  ${doc.path}`);
  console.log(
    `  内訳: 出典の実在 ${b.sourceValidity.toFixed(2)} / ` +
      `${coverageLabel(b.coverageKind)} ${b.readCoverage.toFixed(2)} / ` +
      `出典の密度 ${b.citationDensity.toFixed(2)} / ` +
      `確定度 ${b.determinacy.toFixed(2)}` +
      `（モデル自己申告 ${b.selfReported.toFixed(2)}）`,
  );
  for (const w of doc.warnings) console.log(`  ⚠ ${w.detail}`);
  for (const kind of QUESTION_KINDS) {
    const questions = questionsOfKind(doc.openQuestions, kind);
    if (questions.length === 0) continue;
    console.log(`  ? ${QUESTION_KIND_LABEL[kind]} ${questions.length} 件:`);
    for (const q of questions) console.log(`    - ${formatQuestion(q)}`);
  }
}

/** 所要時間と推定コストを表示する。LP や記事に載せる実測値の出どころになる */
function reportUsage(usage: UsageSummary): void {
  console.log("");
  console.log(formatUsageSummary(usage));
  console.log(
    "  推定コストは API 料金換算です。Claude のサブスクリプションで認証している場合、実際の請求額とは異なります。",
  );
}

/** コマンドラインから受け取った値。`parseArgs` の生の形をコマンド側へ持ち込まない */
interface CliOptions {
  pr?: string;
  repo?: string;
  docs?: string;
  token?: string;
  limit?: string;
  repoName?: string;
  docsRepo?: string;
  force: boolean;
  allowBash: boolean;
  clone: boolean;
}

async function runAnalyzeCommand(
  options: CliOptions,
  log: (line: string) => void,
): Promise<number> {
  if (!options.pr || !options.repo || !options.docs) {
    console.error("エラー: analyze には --pr, --repo, --docs が必須です。\n");
    console.log(USAGE);
    return 1;
  }

  const repoPath = await assertDirectory(options.repo, "--repo");
  const docsPath = expandHome(options.docs);

  const ref = parsePullRequestRef(options.pr);
  log(`▸ PR を取得中: ${ref.owner}/${ref.repo}#${ref.number}`);
  // 認証は呼び出し側で明示する（`fetchPullRequest` に既定値を持たせない理由は octokit.ts 参照）
  const octokit = options.token ? createOctokit(options.token) : createOctokitFromEnv();
  const pr = await fetchPullRequest(ref, octokit);
  log(`  ${pr.title}（${pr.changedFiles.length} ファイル変更）`);

  const result = await runPipeline(pr, {
    repoPath,
    docsPath,
    force: options.force,
    allowBash: options.allowBash,
    log,
  });

  console.log("");
  if (result.skipped) {
    console.log("── 結果 ──");
    console.log(`スキップ: ${result.classification.reason}`);
    console.log("（強制的に解析するには --force を付けてください）");
    reportUsage(result.usage);
    return 0;
  }

  console.log("── 結果 ──");
  for (const doc of result.updated) reportDoc(doc);
  for (const f of result.failures) console.log(`✗ ${f.id}: ${f.error}`);
  reportUsage(result.usage);

  return result.failures.length > 0 ? 1 : 0;
}

async function runBackfillCommand(
  options: CliOptions,
  log: (line: string) => void,
): Promise<number> {
  if (!options.repo || !options.docs) {
    console.error("エラー: backfill には --repo, --docs が必須です。\n");
    console.log(USAGE);
    return 1;
  }

  const repoPath = await assertDirectory(options.repo, "--repo");
  const docsPath = expandHome(options.docs);

  // 出典の帰属先になる値。間違えるとマルチリポジトリの記述保護が誤動作するので、
  // 推測できなければ黙って続けず止める。
  const repoName = options.repoName ?? (await detectRepoName(repoPath));
  if (!repoName) {
    console.error(
      `エラー: リポジトリ名（org/repo）を判別できませんでした。\n` +
        `${repoPath} に GitHub の origin が無いようです。--repo-name で明示してください。`,
    );
    return 1;
  }

  const limit = options.limit ? Number(options.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`エラー: --limit は1以上の整数で指定してください: "${options.limit}"`);
    return 1;
  }

  log(`▸ バックフィル対象: ${repoName}（最大 ${limit} 件）`);

  const result = await runBackfill({
    repoPath,
    docsPath,
    repo: repoName,
    limit,
    allowBash: options.allowBash,
    log,
  });

  console.log("");
  console.log("── 結果 ──");
  console.log(`列挙された機能 ${result.surveyed} 件 / 生成 ${result.updated.length} 件`);
  console.log("");
  for (const doc of result.updated) reportDoc(doc);
  for (const f of result.failures) console.log(`✗ ${f.id}: ${f.error}`);
  reportUsage(result.usage);

  if (result.updated.length === 0) {
    console.log("生成されたドキュメントはありません。");
    return 1;
  }
  return result.failures.length > 0 ? 1 : 0;
}

/** `check-auth` でインストール対象を並べる上限。多いときは件数だけ足す */
const MAX_LISTED_REPOS = 20;

/**
 * リポジトリ1件ぶんのアクセスを確かめる。
 *
 * 認証の取り違えは「解析が数分走ったあとに PR 作成で落ちる」形で出るので、
 * **その前に、使う認証そのもので API を1回叩いて確かめる**。
 */
async function checkRepoAccess(
  auth: GitHubAuth,
  fullName: string,
  label: string,
  options: { clone: boolean },
): Promise<boolean> {
  try {
    const { owner, repo } = parseRepoFullName(fullName);
    const { octokit, token } = await auth.forRepo(fullName);
    const { data } = await octokit.rest.repos.get({ owner, repo });
    console.log(
      `✓ ${label}: ${fullName}（${data.private ? "private" : "public"} / ` +
        `既定ブランチ ${data.default_branch}）`,
    );

    if (options.clone) {
      // git でもそのトークンが通るかは API とは別問題（クローン URL に埋め込むため）
      const checkout = await checkoutForAnalysis({ repo: fullName, token });
      try {
        console.log(`  ✓ トークンで浅いクローンができた（${checkout.path} → 破棄）`);
      } finally {
        await checkout.cleanup();
      }
    }
    return true;
  } catch (error) {
    console.log(`✗ ${label}: ${fullName}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    // 非公開リポジトリに権限が無い場合も 404 になる。「存在しない」と見分けがつかず必ず迷うので明示する
    if ((error as { status?: number }).status === 404) {
      console.log(
        "  ※ 404 は「リポジトリが無い」だけでなく「この認証情報に権限が無い」ときも返ります。" +
          "非公開リポジトリなら、fine-grained PAT の対象リポジトリ、または App のインストール先を確認してください",
      );
    }
    return false;
  }
}

/**
 * GitHub の認証設定を確かめる。**LLM を呼ばないので無料で何度でも回せる。**
 *
 * セットアップの最後に「PR をマージして待つ」より先に、ここで切り分けられるようにする。
 */
async function runCheckAuthCommand(options: CliOptions): Promise<number> {
  const problems = checkGitHubAuthConfig();
  if (problems.length > 0) {
    console.error("認証設定に問題があります:");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  const auth = resolveGitHubAuth();
  console.log(
    `認証方式: ${auth.kind === "app" ? "GitHub App（installation トークンに交換）" : "PAT（GITHUB_TOKEN）"}`,
  );
  console.log("");

  let ok = true;

  if (auth.kind === "app") {
    const credentials = readAppCredentials();
    // kind が app ならここは必ず取れる（resolveGitHubAuth と同じ判定）
    if (!credentials) throw new Error("App の資格情報を読み直せませんでした");
    try {
      const info = await inspectApp(credentials);
      console.log(`✓ App: ${info.app.name}（slug ${info.app.slug} / App ID ${info.app.id}）`);
      if (info.installations.length === 0) {
        console.log("✗ どのアカウントにもインストールされていません（Install App から追加してください）");
        ok = false;
      }
      for (const installation of info.installations) {
        console.log(
          `  - ${installation.account}（installation ${installation.id} / ` +
            `対象 ${installation.repositorySelection} / ` +
            `Contents: ${installation.permissions["contents"] ?? "なし"} / ` +
            `Pull requests: ${installation.permissions["pull_requests"] ?? "なし"}）`,
        );
        // 「App は入れたのに 404」の原因はほぼインストール対象の選び忘れなので、届く範囲を見せる
        try {
          const repositories = await listInstallationRepositories(credentials, installation.id);
          const shown = repositories.slice(0, MAX_LISTED_REPOS);
          for (const repository of shown) console.log(`      ${repository}`);
          if (repositories.length > shown.length) {
            console.log(`      … ほか ${repositories.length - shown.length} 件`);
          }
          if (repositories.length === 0) {
            console.log("      （1件も選ばれていません）");
          }
        } catch {
          console.log("      （リポジトリ一覧を取得できませんでした）");
        }
      }
      // docs リポジトリへ PR を作るには両方 write が必要
      for (const installation of info.installations) {
        for (const [key, label] of [
          ["contents", "Contents"],
          ["pull_requests", "Pull requests"],
        ] as const) {
          if (installation.permissions[key] !== "write") {
            console.log(
              `  ⚠ ${installation.account}: ${label} が write ではありません` +
                `（webhook から docs リポジトリへ PR を作るには write が必要）`,
            );
          }
        }
      }
    } catch (error) {
      console.log("✗ App の情報を取得できませんでした（App ID と秘密鍵の組み合わせを確認してください）");
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log("");
  }

  const docsRepo = options.docsRepo ?? process.env.SPEC_BRIDGE_DOCS_REPO;
  if (docsRepo) {
    ok = (await checkRepoAccess(auth, docsRepo, "docs リポジトリ", { clone: false })) && ok;
  } else {
    console.log("- docs リポジトリは未指定（SPEC_BRIDGE_DOCS_REPO か --docs-repo で確かめられます）");
  }

  if (options.repoName) {
    ok = (await checkRepoAccess(auth, options.repoName, "解析対象", { clone: options.clone })) && ok;

    if (docsRepo && options.repoName.trim().toLowerCase() === docsRepo.trim().toLowerCase()) {
      console.log(
        "⚠ 解析対象と docs リポジトリが同じです。webhook は自己ループ防止のためこのイベントを捨てます",
      );
    }
  } else {
    console.log("- 解析対象は未指定（--repo-name owner/repo で確かめられます）");
  }

  console.log("");
  console.log(ok ? "結果: 使えます" : "結果: 上の ✗ を解消してください");
  return ok ? 0 : 1;
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
      limit: { type: "string" },
      "repo-name": { type: "string" },
      "docs-repo": { type: "string" },
      clone: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "allow-bash": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  const known = ["analyze", "backfill", "check-auth"];
  if (values.help || !command || !known.includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const log = values.quiet ? () => {} : (line: string) => console.log(line);

  const options: CliOptions = {
    pr: values.pr,
    repo: values.repo,
    docs: values.docs,
    token: values.token,
    limit: values.limit,
    repoName: values["repo-name"],
    docsRepo: values["docs-repo"],
    force: values.force,
    allowBash: values["allow-bash"],
    clone: values.clone,
  };

  if (command === "check-auth") return runCheckAuthCommand(options);
  return command === "analyze"
    ? runAnalyzeCommand(options, log)
    : runBackfillCommand(options, log);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\nエラー: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
