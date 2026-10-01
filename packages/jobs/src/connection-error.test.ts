import assert from "node:assert/strict";
import { test } from "node:test";
import { describeConnectionFailure } from "./connection-error.ts";

// 実際に Fly で出たメッセージ。これだけでは何を見ればいいか分からない
test("接続できない系には、確かめる場所を添える", () => {
  const text = describeConnectionFailure(new Error("Connection terminated unexpectedly"));
  assert.match(text, /接続できませんでした/);
  assert.match(text, /DATABASE_URL の宛先が起動しているか/);
  assert.match(text, /Connection terminated unexpectedly/, "元のメッセージも残す");
});

test("よくある接続エラーのコードを拾う", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]) {
    const text = describeConnectionFailure(Object.assign(new Error("boom"), { code }));
    assert.match(text, /確かめること/, code);
  }
});

test("接続タイムアウトも拾う", () => {
  assert.match(
    describeConnectionFailure(new Error("timeout expired")),
    /確かめること/,
  );
});

// 接続とは関係ない失敗に、接続の話を足すと誤誘導になる
test("SQL の誤りなど、接続以外はそのまま伝える", () => {
  const text = describeConnectionFailure(new Error('syntax error at or near "slect"'));
  assert.match(text, /データベースの初期化に失敗しました/);
  assert.doesNotMatch(text, /確かめること/);
});

test("Error でない値でも落ちない", () => {
  assert.match(describeConnectionFailure("なにか"), /なにか/);
  assert.match(describeConnectionFailure(null), /初期化に失敗/);
});
