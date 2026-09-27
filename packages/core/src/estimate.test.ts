import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateOptionsFromEnv,
  estimateRun,
  formatEstimate,
  COST_PER_FEATURE_USD,
} from "./estimate.ts";

test("機能数 × 実測の平均で見積もる", () => {
  const estimate = estimateRun(6, { costPerFeatureUsd: 2.5, minutesPerFeature: 4.5 });
  assert.equal(estimate.estimatedUsd, 15);
  assert.equal(estimate.estimatedMinutes, 27);
  assert.equal(estimate.willSkip, 0);
});

test("分類で使ったぶんも足す", () => {
  const estimate = estimateRun(2, { costPerFeatureUsd: 2.5, spentUsd: 0.27 });
  assert.equal(estimate.estimatedUsd, 5.27);
});

// 「高い PR を事前に知らせる」ための中核。走らせる前に何件落ちるか分かる
test("予算に達して書けない件数を出す", () => {
  const estimate = estimateRun(6, { costPerFeatureUsd: 2.5, budgetUsd: 10 });
  // 上限は着手前に見るので、$10 を超える1件までは走る（0→2.5→5→7.5→10 で4件）
  assert.equal(estimate.willSkip, 2);
});

test("予算が十分なら何も落ちない", () => {
  assert.equal(estimateRun(3, { costPerFeatureUsd: 2.5, budgetUsd: 100 }).willSkip, 0);
});

test("予算を指定しなければ打ち切りを出さない", () => {
  assert.equal(estimateRun(10, { costPerFeatureUsd: 2.5 }).willSkip, 0);
});

test("機能が0件なら費用も0", () => {
  const estimate = estimateRun(0, { budgetUsd: 10 });
  assert.equal(estimate.estimatedUsd, 0);
  assert.equal(estimate.willSkip, 0);
});

// 精度を装わないこと（根拠を必ず添える）
test("見積もりには根拠の文言が付く", () => {
  assert.match(estimateRun(1).basis, /実測の平均/);
  assert.match(estimateRun(1).basis, new RegExp(String(COST_PER_FEATURE_USD)));
});

test("表示は1行で、打ち切りがあれば添える", () => {
  assert.equal(
    formatEstimate(estimateRun(2, { costPerFeatureUsd: 2.5, minutesPerFeature: 4.5 })),
    "2 機能 / 推定 $5.00・約9分",
  );
  assert.match(
    formatEstimate(estimateRun(6, { costPerFeatureUsd: 2.5, budgetUsd: 10 })),
    /2 件は書かれません/,
  );
});

// リポジトリの大きさで1件あたりの費用は変わる（小さい例示リポジトリでは約 $0.4 だった）
test("係数は env で上書きできる", () => {
  assert.deepEqual(
    estimateOptionsFromEnv({ SPEC_BRIDGE_COST_PER_FEATURE_USD: "0.4" }),
    { costPerFeatureUsd: 0.4 },
  );
  assert.deepEqual(estimateOptionsFromEnv({}), {});
  assert.deepEqual(estimateOptionsFromEnv({ SPEC_BRIDGE_COST_PER_FEATURE_USD: "0" }), {});
  assert.deepEqual(estimateOptionsFromEnv({ SPEC_BRIDGE_COST_PER_FEATURE_USD: "abc" }), {});
});
