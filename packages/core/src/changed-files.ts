import type { ChangedFile } from "./types.ts";

/** プロンプトに並べる変更ファイルの上限。超えたぶんは件数だけ伝える */
export const MAX_LISTED_FILES = 200;
/** この数を超えたらディレクトリごとにまとめる（平らに並べると構造が見えない） */
const GROUP_THRESHOLD = 20;

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "(ルート)" : path.slice(0, index);
}

function line(file: ChangedFile): string {
  return `  ${file.status}\t${file.filename} (+${file.additions}/-${file.deletions})`;
}

/**
 * 変更ファイルの一覧をプロンプト用に整える。
 *
 * 大規模 PR では平らに並べても構造が見えないので、ディレクトリごとにまとめる。
 * **省略するときは必ず件数を書く。** 黙って切ると、モデルは「これで全部」と思って
 * 機能を取りこぼす（71ファイルの PR で認証のドキュメントが更新されなかった原因のひとつ）。
 */
export function formatChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) return "(変更ファイルなし)";

  const listed = files.slice(0, MAX_LISTED_FILES);
  const omitted = files.length - listed.length;

  const body =
    listed.length <= GROUP_THRESHOLD
      ? listed.map(line).join("\n")
      : groupByDirectory(listed);

  return omitted > 0 ? `${body}\n  … ほか ${omitted} ファイル（一覧を省略）` : body;
}

function groupByDirectory(files: ChangedFile[]): string {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const dir = directoryOf(file.filename);
    const group = groups.get(dir);
    if (group) group.push(file);
    else groups.set(dir, [file]);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, group]) => `${dir}/ (${group.length}件)\n${group.map(line).join("\n")}`)
    .join("\n");
}

export interface DiffBlock {
  text: string;
  /** 差分を載せられなかったファイル数 */
  omitted: number;
}

/**
 * 差分をプロンプトに収まる大きさへ詰める。
 *
 * **この機能に関係するファイルを先に載せる。** 予算を先頭から使うので、
 * 関係ないファイルの差分で埋まって肝心の差分が切れる、という事故を防ぐ。
 * 入り切らなかったぶんは件数を明記する（黙って切らない）。
 */
export function buildDiffBlock(
  files: ChangedFile[],
  focus: string[],
  budget: number,
): DiffBlock {
  const focusSet = new Set(focus);
  const ordered = [
    ...files.filter((f) => focusSet.has(f.filename)),
    ...files.filter((f) => !focusSet.has(f.filename)),
  ];

  const chunks: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const file of ordered) {
    const header = `--- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    const chunk = file.patch ? `${header}\n${file.patch}` : `${header}\n(差分省略: バイナリまたは巨大な変更)`;

    if (used + chunk.length > budget && chunks.length > 0) {
      omitted += 1;
      continue;
    }
    chunks.push(chunk);
    used += chunk.length + 2;
  }

  return { text: chunks.join("\n\n"), omitted };
}
