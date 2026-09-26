import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  backfillOneFeature,
  buildDocsPullRequestBody,
  buildDocsPullRequestTitle,
  DocStore,
  INDEX_PAGE,
  QUESTIONS_PAGE,
  surveyForBackfill,
  type DocChange,
  type SurveyedFeature,
} from "@spec-bridge/core";
import {
  checkoutForAnalysis,
  commitFilesToBranch,
  ensurePullRequest,
  parseRepoFullName,
  type GitHubAuth,
} from "@spec-bridge/github";
import type { JobHandler, JobStore } from "@spec-bridge/jobs";
import {
  BACKFILL_FEATURE,
  featureJob,
  finishJob,
  FINISH_RETRY_MS,
  parseRun,
  readyToFinish,
  runProgress,
  withinBudget,
  type FeatureJobResult,
} from "./backfill-job.ts";
import { fetchDocsFromRepo } from "./docs-mirror.ts";

export interface BackfillHandlerDeps {
  store: JobStore;
  auth: GitHubAuth;
}

/**
 * 機能の列挙。**ランの起点。**
 *
 * ここでリポジトリを1回クローンして機能を列挙し、機能ごとのジョブを積む。
 * 解析そのものは行わないので数十秒で終わる。
 */
export function surveyHandler(deps: BackfillHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const run = parseRun(job.payload);
    const { octokit: docsOctokit } = await deps.auth.forRepo(run.docsRepo);
    const source = await deps.auth.forRepo(run.repo);

    const checkout = await checkoutForAnalysis({ repo: run.repo, token: source.token });
    const docsDir = await mkdtemp(join(tmpdir(), "spec-bridge-docs-"));
    try {
      // 既存ドキュメントを取り込んでから列挙する（既にある機能を新規作成しないため）
      const existing = await fetchDocsFromRepo(docsOctokit, run.docsRepo, docsDir);
      ctx.log(`  docs リポジトリから ${existing} 件のドキュメントを取得`);

      const survey = await surveyForBackfill({
        repoPath: checkout.path,
        docsPath: docsDir,
        repo: run.repo,
        limit: run.limit,
        log: ctx.log,
      });

      const sha = checkout.sha;
      for (const [index, feature] of survey.features.entries()) {
        await deps.store.enqueue(
          featureJob(run, feature, { index: index + 1, total: survey.features.length }, sha),
        );
      }
      // 仕上げも今のうちに積む。終わっていない機能があれば、自分で後ろへずらす
      await deps.store.enqueue(finishJob(run, { surveyed: survey.features.length, sha }));

      ctx.log(`  ${survey.features.length} 件の機能ジョブを積みました`);
      return {
        surveyed: survey.features.length,
        costUsd: survey.usage.costUsd,
        warnings: survey.warnings,
      };
    } finally {
      await checkout.cleanup();
      await rm(docsDir, { recursive: true, force: true });
    }
  };
}

/**
 * 機能1件の書き起こしと、docs ブランチへのコミット。
 *
 * **1件が1ジョブ。** 実測で1件あたり約 $1.7・4分半かかり、連続実行すると
 * LLM の利用上限に当たる。分けておけば、失敗した1件だけを拾い直せる。
 */
export function featureHandler(deps: BackfillHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const run = parseRun(job.payload);
    const feature = job.payload["feature"] as SurveyedFeature | undefined;
    const sha = typeof job.payload["sha"] === "string" ? job.payload["sha"] : null;
    if (!feature) throw new Error("機能の指定がありません");

    // 予算は着手前に見る。走らせてから気づいても、その1件の費用はもう出ている
    const progress = await runProgress(deps.store, run.runId);
    if (!withinBudget(progress, run.budgetUsd)) {
      ctx.log(
        `  ⏭ 予算に達したので書きません（$${progress.costUsd.toFixed(2)} / 上限 $${run.budgetUsd}）`,
      );
      return { skipped: "over-budget", costUsd: 0 } satisfies Partial<FeatureJobResult>;
    }

    const source = await deps.auth.forRepo(run.repo);
    const { octokit: docsOctokit } = await deps.auth.forRepo(run.docsRepo);
    const checkout = await checkoutForAnalysis({ repo: run.repo, sha, token: source.token });
    const docsDir = await mkdtemp(join(tmpdir(), "spec-bridge-docs-"));

    try {
      // このランのブランチから取り込む。前の機能が書いたものを引き継ぐ
      await fetchDocsFromRepo(docsOctokit, run.docsRepo, docsDir, { ref: run.branch });

      const result = await backfillOneFeature(feature, {
        repoPath: checkout.path,
        docsPath: docsDir,
        repo: run.repo,
        log: ctx.log,
      });

      // 解析に数分かかっている。リースを延ばしてからコミットへ進む
      await ctx.heartbeat();

      const { owner, repo } = parseRepoFullName(run.docsRepo);
      await commitFilesToBranch(
        { owner, repo },
        {
          branch: run.branch,
          files: [
            {
              path: relative(docsDir, result.updated.path),
              content: await readFile(result.updated.path, "utf8"),
            },
          ],
          message: `docs: ${feature.title}（${run.repo} のバックフィル）`,
        },
        docsOctokit,
      );
      ctx.log(`  ✓ ${run.branch} へコミット`);

      return {
        docId: result.updated.id,
        costUsd: result.usage.costUsd,
        confidence: result.updated.confidence,
        breakdown: result.updated.breakdown,
        warnings: result.updated.warnings,
      } satisfies Partial<FeatureJobResult>;
    } finally {
      await checkout.cleanup();
      await rm(docsDir, { recursive: true, force: true });
    }
  };
}

/**
 * 一覧ページの再生成と PR の作成。
 *
 * 機能ジョブが全部終わるまで待つ（終わっていなければ自分を後ろへずらす）。
 * ワーカーが複数いると完了順が保証されないため、**順番ではなく状態で待つ**。
 */
export function finishHandler(deps: BackfillHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const run = parseRun(job.payload);
    const progress = await runProgress(deps.store, run.runId);

    if (!readyToFinish(progress)) {
      ctx.log(`  ⏳ 機能ジョブが ${progress.pending} 件残っているので待ちます`);
      await deps.store.enqueue({
        ...finishJob(run, {
          surveyed: Number(job.payload["surveyed"] ?? 0),
          sha: typeof job.payload["sha"] === "string" ? job.payload["sha"] : null,
        }),
        // 同じ鍵では積み直せないので、この仕事自身を後ろへずらす
        dedupeKey: `${job.dedupeKey}:wait-${Date.now().toString(36)}`,
        runAfter: new Date(Date.now() + FINISH_RETRY_MS),
      });
      return { waiting: progress.pending };
    }

    const { octokit } = await deps.auth.forRepo(run.docsRepo);
    const docsDir = await mkdtemp(join(tmpdir(), "spec-bridge-docs-"));
    try {
      const count = await fetchDocsFromRepo(octokit, run.docsRepo, docsDir, { ref: run.branch });
      if (count === 0) {
        throw new Error("ブランチにドキュメントがありません（全機能が失敗した可能性があります）");
      }

      // 一覧と確認事項を決定論的に作り直す（機能ジョブは個別ファイルしか書かない）
      const store = new DocStore(docsDir);
      await store.writeIndexPage();

      const changes = await collectChanges(deps.store, run.runId, store);
      const files = await Promise.all(
        [INDEX_PAGE, QUESTIONS_PAGE].map(async (page) => ({
          path: page,
          content: await readFile(join(docsDir, page), "utf8"),
        })),
      );

      const { owner, repo } = parseRepoFullName(run.docsRepo);
      await commitFilesToBranch(
        { owner, repo },
        { branch: run.branch, files, message: "docs: 一覧と確認事項を更新" },
        octokit,
      );

      const source = {
        kind: "backfill" as const,
        repo: run.repo,
        sha: typeof job.payload["sha"] === "string" ? job.payload["sha"] : null,
        surveyed: Number(job.payload["surveyed"] ?? changes.length),
        failed: progress.failed,
        usage: {
          costUsd: progress.costUsd,
          agentRuns: progress.done,
          elapsedMs: Date.now() - job.createdAt.getTime(),
        },
      };

      const pr = await ensurePullRequest(
        { owner, repo },
        {
          branch: run.branch,
          title: buildDocsPullRequestTitle(source, changes),
          body: buildDocsPullRequestBody(source, changes),
        },
        octokit,
      );
      ctx.log(`  ✓ PR ${pr.created ? "作成" : "更新"}: ${pr.prUrl}`);

      return { prUrl: pr.prUrl, generated: progress.done, failed: progress.failed, costUsd: progress.costUsd };
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  };
}

/**
 * PR 本文に載せる変更の一覧を組み立てる。
 *
 * ドキュメント本体はブランチから読み、確度の内訳と警告は機能ジョブの結果から拾う
 * （**生成したときにしか分からない値**なので、ドキュメントからは復元できない）。
 */
async function collectChanges(
  store: JobStore,
  runId: string,
  docs: DocStore,
): Promise<DocChange[]> {
  const jobs = await store.find({
    kinds: [BACKFILL_FEATURE],
    states: ["succeeded"],
    payloadMatch: { runId },
  });

  const changes: DocChange[] = [];
  for (const job of jobs) {
    const docId = job.result?.["docId"];
    if (typeof docId !== "string") continue;
    const doc = await docs.get(docId);
    if (!doc) continue;
    changes.push({
      doc,
      breakdown: job.result?.["breakdown"] as DocChange["breakdown"],
      warnings: (job.result?.["warnings"] as DocChange["warnings"]) ?? [],
    });
  }
  return changes;
}
