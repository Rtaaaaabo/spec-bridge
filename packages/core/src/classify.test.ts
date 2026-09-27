import assert from "node:assert/strict";
import { test } from "node:test";
import { ClassifyResult } from "./classify.ts";

const base = { affectsSpec: true, reason: "r" };

// 既存の出力（files / unclassified を知らないモデル）でも読み込めること
test("古い形の出力も受け付ける", () => {
  const parsed = ClassifyResult.parse({
    ...base,
    targets: [{ docId: "invite", newDocId: null, title: "招待", why: "w" }],
  });
  assert.deepEqual(parsed.targets[0]?.files, []);
  assert.deepEqual(parsed.unclassified, { files: [], note: "" });
});

test("機能ごとの変更ファイルを受け取る", () => {
  const parsed = ClassifyResult.parse({
    ...base,
    targets: [
      { docId: null, newDocId: "auth", title: "認証", why: "w", files: ["services/auth/oauth2.go"] },
    ],
    unclassified: { files: ["ci/build.yml"], note: "CI のみ" },
  });
  assert.deepEqual(parsed.targets[0]?.files, ["services/auth/oauth2.go"]);
  assert.equal(parsed.unclassified.note, "CI のみ");
});

test("unclassified が片方だけでも既定で埋まる", () => {
  const parsed = ClassifyResult.parse({ ...base, unclassified: { note: "全部見た" } });
  assert.deepEqual(parsed.unclassified.files, []);
});
