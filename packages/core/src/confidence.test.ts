import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSources, computeConfidence, pruneInvalidSources } from "./confidence.ts";
import { FeatureDocBody } from "./types.ts";

/** 実在するファイルを持つ一時リポジトリを作る */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-bridge-conf-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), Array(50).fill("// line").join("\n"));
  writeFileSync(join(root, "src", "b.ts"), Array(10).fill("// line").join("\n"));
  return root;
}

function body(overrides: Partial<ReturnType<typeof FeatureDocBody.parse>> = {}) {
  return FeatureDocBody.parse({
    title: "t",
    summary: "s",
    overview: "o",
    rules: [
      { text: "ルール1", sources: [{ repo: "a/b", file: "src/a.ts", line: 10, pr: null }] },
    ],
    ...overrides,
  });
}

test("実在するファイル・範囲内の行番号は有効と判定される", () => {
  const repo = fixtureRepo();
  const check = checkSources(body(), repo);
  assert.equal(check.total, 1);
  assert.equal(check.valid, 1);
});

test("存在しないファイルを指す出典を検出する", () => {
  const repo = fixtureRepo();
  const check = checkSources(
    body({
      rules: [
        { text: "架空", sources: [{ repo: "a/b", file: "src/nope.ts", line: 1, pr: null }] },
      ],
    }),
    repo,
  );
  assert.equal(check.valid, 0);
  assert.deepEqual(check.missingFiles, ["src/nope.ts"]);
});

test("行番号がファイル行数を超えていたら無効と判定する", () => {
  const repo = fixtureRepo();
  const check = checkSources(
    body({
      rules: [
        { text: "行超過", sources: [{ repo: "a/b", file: "src/b.ts", line: 999, pr: null }] },
      ],
    }),
    repo,
  );
  assert.equal(check.valid, 0);
  assert.equal(check.outOfRange.length, 1);
});

test("リポジトリ外を指す出典は無効（パストラバーサル対策）", () => {
  const repo = fixtureRepo();
  const check = checkSources(
    body({
      rules: [
        { text: "外部", sources: [{ repo: "a/b", file: "../../etc/passwd", line: 1, pr: null }] },
      ],
    }),
    repo,
  );
  assert.equal(check.valid, 0);
  assert.equal(check.missingFiles.length, 1);
});

test("実在しない出典は除去され、出典が全部消えた仕様項目は落ちる", () => {
  const repo = fixtureRepo();
  const input = body({
    rules: [
      { text: "本物", sources: [{ repo: "a/b", file: "src/a.ts", line: 1, pr: null }] },
      { text: "架空のみ", sources: [{ repo: "a/b", file: "src/nope.ts", line: 1, pr: null }] },
      {
        text: "混在",
        sources: [
          { repo: "a/b", file: "src/a.ts", line: 2, pr: null },
          { repo: "a/b", file: "src/ghost.ts", line: 1, pr: null },
        ],
      },
    ],
  });

  const { body: pruned, droppedSources, droppedRules } = pruneInvalidSources(input, repo);

  assert.equal(droppedSources, 2);
  assert.deepEqual(droppedRules, ["架空のみ"]);
  assert.equal(pruned.rules.length, 2);
  // 混在していた項目は、有効な出典だけ残して生き残る
  assert.equal(pruned.rules[1]?.sources.length, 1);
});

test("確度はモデルの自己申告ではなく実測から算出される", () => {
  const repo = fixtureRepo();

  const good = computeConfidence({
    body: body({
      rules: [
        {
          text: "よく調べた",
          sources: [
            { repo: "a/b", file: "src/a.ts", line: 1, pr: null },
            { repo: "a/b", file: "src/b.ts", line: 2, pr: null },
          ],
        },
      ],
      openQuestions: [],
    }),
    repoPath: repo,
    changedFiles: ["src/a.ts", "src/b.ts"],
    filesRead: ["src/a.ts", "src/b.ts"],
    selfReported: 0.8,
  });

  const poor = computeConfidence({
    body: body({
      rules: [
        { text: "怪しい", sources: [{ repo: "a/b", file: "src/nope.ts", line: 1, pr: null }] },
      ],
      openQuestions: ["あれもこれも不明", "これも不明", "それも不明"],
    }),
    repoPath: repo,
    changedFiles: ["src/a.ts", "src/b.ts"],
    filesRead: [],
    selfReported: 0.8, // 自己申告は同じでも…
  });

  assert.ok(good.score > poor.score, "良い解析のほうが高くならなければならない");
  assert.ok(good.score >= 0.9, `よく調べた場合は高く出るべき (${good.score})`);
  assert.ok(poor.score <= 0.2, `根拠が薄い場合は低く出るべき (${poor.score})`);
  // 自己申告はスコアに influence しない
  assert.equal(good.selfReported, 0.8);
  assert.equal(poor.selfReported, 0.8);
});

test("絶対パスで読まれたファイルも読了率に数える", () => {
  const repo = fixtureRepo();
  const result = computeConfidence({
    body: body(),
    repoPath: repo,
    changedFiles: ["src/a.ts"],
    filesRead: [join(repo, "src/a.ts")],
    selfReported: 0.5,
  });
  assert.equal(result.readCoverage, 1);
});

test("未確認事項が多いほど確定度が下がる", () => {
  const repo = fixtureRepo();
  const base = {
    repoPath: repo,
    changedFiles: ["src/a.ts"],
    filesRead: ["src/a.ts"],
    selfReported: 0.8,
  };
  const few = computeConfidence({ ...base, body: body({ openQuestions: [] }) });
  const many = computeConfidence({
    ...base,
    body: body({ openQuestions: ["a", "b", "c", "d", "e"] }),
  });
  assert.ok(few.determinacy > many.determinacy);
  assert.ok(few.score > many.score);
});
