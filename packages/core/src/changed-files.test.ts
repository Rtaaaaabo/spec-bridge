import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiffBlock, formatChangedFiles, MAX_LISTED_FILES } from "./changed-files.ts";
import type { ChangedFile } from "./types.ts";

const file = (filename: string, patch: string | null = "@@ -1 +1 @@"): ChangedFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

// --- 一覧（大規模 PR で構造が見えるように） ---

test("少なければ平らに並べる", () => {
  const text = formatChangedFiles([file("a.ts"), file("b.ts")]);
  assert.match(text, /a\.ts/);
  assert.doesNotMatch(text, /件\)/);
});

test("多ければディレクトリごとにまとめる", () => {
  const files = [
    ...Array.from({ length: 15 }, (_, i) => file(`services/auth/f${i}.go`)),
    ...Array.from({ length: 10 }, (_, i) => file(`routers/web/g${i}.go`)),
  ];
  const text = formatChangedFiles(files);
  assert.match(text, /services\/auth\/ \(15件\)/);
  assert.match(text, /routers\/web\/ \(10件\)/);
});

// 黙って切ると、モデルは「これで全部」と思って機能を取りこぼす
test("並べきれない場合は件数を明記する", () => {
  const files = Array.from({ length: MAX_LISTED_FILES + 7 }, (_, i) => file(`src/f${i}.ts`));
  assert.match(formatChangedFiles(files), /ほか 7 ファイル/);
});

test("変更が無ければその旨を返す", () => {
  assert.equal(formatChangedFiles([]), "(変更ファイルなし)");
});

// --- 差分の詰め方 ---

test("この機能に関係するファイルの差分を先に載せる", () => {
  const files = [file("other.ts", "OTHER"), file("target.ts", "TARGET")];
  const { text } = buildDiffBlock(files, ["target.ts"], 10_000);
  assert.ok(text.indexOf("TARGET") < text.indexOf("OTHER"), "関係ファイルが先");
});

// 予算を関係ないファイルで使い切って、肝心の差分が切れるのを防ぐ
test("予算が足りなければ、関係ないファイルから落ちる", () => {
  const files = [
    file("other1.ts", "X".repeat(400)),
    file("other2.ts", "Y".repeat(400)),
    file("target.ts", "TARGET"),
  ];
  const { text, omitted } = buildDiffBlock(files, ["target.ts"], 200);
  assert.match(text, /TARGET/);
  assert.equal(omitted, 2);
});

test("落としたファイル数を返す（黙って切らない）", () => {
  const files = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`, "Z".repeat(300)));
  const { omitted } = buildDiffBlock(files, [], 700);
  assert.ok(omitted > 0);
});

test("予算に収まるなら全部載せる", () => {
  const files = [file("a.ts", "AAA"), file("b.ts", "BBB")];
  const { text, omitted } = buildDiffBlock(files, [], 10_000);
  assert.equal(omitted, 0);
  assert.match(text, /AAA/);
  assert.match(text, /BBB/);
});

// 1ファイルだけで予算を超える場合でも、空の差分を渡さない
test("1件目が予算を超えても、その1件は載せる", () => {
  const { text, omitted } = buildDiffBlock([file("huge.ts", "H".repeat(5_000))], [], 100);
  assert.match(text, /huge\.ts/);
  assert.equal(omitted, 0);
});

test("差分が取れないファイルはその旨を書く", () => {
  const { text } = buildDiffBlock([file("image.png", null)], [], 10_000);
  assert.match(text, /差分省略/);
});
