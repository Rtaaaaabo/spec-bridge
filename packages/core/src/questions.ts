import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FeatureDocBody, OpenQuestion, QuestionKind } from "./types.ts";

/** 表示する順番。人に聞くべきものを先に出す */
export const QUESTION_KINDS: readonly QuestionKind[] = ["intent", "unverified", "scope"];

export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = {
  intent: "聞くべきこと",
  unverified: "追加で調べれば埋まる可能性があるもの",
  scope: "ドキュメントの範囲についてのメモ",
};

export function questionsOfKind(
  questions: readonly OpenQuestion[],
  kind: QuestionKind,
): OpenQuestion[] {
  return questions.filter((q) => q.kind === kind);
}

/** 1項目を1行にする。`intent` には探した箇所を添える */
export function formatQuestion(q: OpenQuestion): string {
  if (q.kind !== "intent" || q.searched.length === 0) return q.question;
  return `${q.question}（確認した箇所: ${q.searched.map((f) => `\`${f}\``).join(", ")}）`;
}

export interface QuestionEvidenceResult {
  body: FeatureDocBody;
  /** 探した証拠が無く `unverified` に格下げした確認事項 */
  downgraded: string[];
}

/** `path/to/file.go:42` や `:42-50` の行番号を外す */
function stripLine(path: string): string {
  return path.replace(/:\d+(?:-\d+)?$/, "");
}

/**
 * `intent`（人に聞くしかない）の確認事項に、本当に探した跡があるかを機械的に確かめる。
 *
 * 仕様の項目に出典を必須にしているのと同じ考え方で、「探した跡のない『分からない』」を
 * 人に聞くべきことにしない。`searched` のうち、
 *   - リポジトリの外を指すもの
 *   - 実在しないもの
 *   - エージェントが実際には開いていないもの
 * を落とし、1件も残らなければ `unverified` に格下げする。
 *
 * 項目そのものは消さない。何が分からなかったかは、格下げしても情報として残す価値がある。
 */
export function verifyQuestionEvidence(
  body: FeatureDocBody,
  repoPath: string,
  filesRead: string[],
): QuestionEvidenceResult {
  const root = resolve(repoPath);
  const read = new Set(
    filesRead.map((f) => (isAbsolute(f) ? relative(root, f) : stripLine(f))),
  );

  const downgraded: string[] = [];
  const openQuestions = body.openQuestions.map((q): OpenQuestion => {
    if (q.kind !== "intent") return q;

    const searched = [...new Set(q.searched.map(stripLine))].filter((file) => {
      const abs = resolve(root, file);
      if (abs !== root && !abs.startsWith(root + "/")) return false;
      if (!existsSync(abs) || !statSync(abs).isFile()) return false;
      return read.has(relative(root, abs));
    });

    if (searched.length === 0) {
      downgraded.push(q.question);
      return { ...q, kind: "unverified", searched: [] };
    }
    return { ...q, searched };
  });

  return { body: { ...body, openQuestions }, downgraded };
}
