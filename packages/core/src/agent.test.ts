import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, READ_ONLY_DENY_LIST } from "./agent.ts";

/**
 * `extractJson` は LLM の出力から JSON を取り出す、全処理の入口。
 * ここが壊れると分類も解析も回答も同時に壊れるので、想定される出力の形を固定しておく。
 */

test("素の JSON を取り出せる", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("```json フェンスで囲まれていても取り出せる", () => {
  const text = 'こう考えました。\n\n```json\n{"verdict":"spec"}\n```\n';
  assert.deepEqual(extractJson(text), { verdict: "spec" });
});

test("前後に説明文があっても取り出せる", () => {
  const text = '結論です:\n{"docIds":["a"]}\nよろしくお願いします。';
  assert.deepEqual(extractJson(text), { docIds: ["a"] });
});

test("フェンスが複数あるときは最後のものを採る（推敲後の出力を拾う）", () => {
  const text = [
    "まず素案です。",
    "```json",
    '{"draft":true}',
    "```",
    "修正しました。",
    "```json",
    '{"draft":false}',
    "```",
  ].join("\n");
  assert.deepEqual(extractJson(text), { draft: false });
});

test("入れ子のオブジェクトを含んでいても壊れない", () => {
  const text = '```json\n{"body":{"rules":[{"text":"x","sources":[{"file":"a.ts"}]}]}}\n```';
  const parsed = extractJson(text) as { body: { rules: Array<{ sources: unknown[] }> } };
  assert.equal(parsed.body.rules[0]?.sources.length, 1);
});

test("日本語や記号が入っていても壊れない", () => {
  const text = '{"headline":"「自分のみ」は仕様どおりです（確度 90%）"}';
  assert.deepEqual(extractJson(text), {
    headline: "「自分のみ」は仕様どおりです（確度 90%）",
  });
});

test("JSON が1つも無ければ例外を投げる（黙って空を返さない）", () => {
  assert.throws(() => extractJson("すみません、わかりませんでした。"));
});

test("壊れた JSON は例外を投げる", () => {
  assert.throws(() => extractJson('{"a":'));
});

// --- ツール制限 ---

test("書き込み系とネットワーク系のツールが拒否リストに入っている", () => {
  // ここを緩めるのはセキュリティ上の変更。うっかり外れたら気づけるようにする
  for (const tool of ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"]) {
    assert.ok(
      (READ_ONLY_DENY_LIST as readonly string[]).includes(tool),
      `${tool} が拒否リストから外れている`,
    );
  }
});
