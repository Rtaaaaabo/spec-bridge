import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FeatureDocBody, SourceRef } from "./types.ts";

export interface SourceCheck {
  /** 検証した出典の総数（ユニーク） */
  total: number;
  /** ファイルが実在し、行番号もファイル内に収まっていた数 */
  valid: number;
  /** 参照先ファイルが存在しなかった出典 */
  missingFiles: string[];
  /** ファイルはあるが行番号が範囲外だった出典 */
  outOfRange: string[];
}

export interface ConfidenceBreakdown {
  /** 最終スコア 0.0〜1.0 */
  score: number;
  /** 出典が実在した割合。最も重い指標 */
  sourceValidity: number;
  /** PR の変更ファイルのうち、エージェントが実際に開いた割合 */
  readCoverage: number;
  /** 仕様1項目あたりの出典数（2件で満点に正規化） */
  citationDensity: number;
  /** 推測が必要だった度合いの裏返し */
  determinacy: number;
  /** モデルの自己申告（比較用に保持するだけで、スコアには使わない） */
  selfReported: number;
}

function fileLineCount(path: string): number | null {
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return null;
  }
}

function collectSources(body: FeatureDocBody): SourceRef[] {
  return [
    ...body.rules.flatMap((r) => r.sources),
    ...body.permissions.flatMap((p) => p.sources),
    ...body.featureFlags.flatMap((f) => f.sources),
  ];
}

function sourceKey(s: SourceRef): string {
  return `${s.file}:${s.line ?? ""}`;
}

/**
 * その出典が、いま解析しているリポジトリのものか。
 *
 * `repo` が空なのは「単一リポジトリなので省略された」ケースなので、自リポジトリ扱いにする。
 */
function isSameRepo(source: SourceRef, currentRepo: string): boolean {
  return source.repo === "" || source.repo === currentRepo;
}

/**
 * 出典が実在するかをファイルシステムで検証する。
 *
 * 存在しないファイルを指す出典は**ハルシネーション**なので、確度を下げるだけでなく
 * 除去する（`pruneInvalidSources`）。「出典があるように見えるが実在しない」が
 * 一番たちが悪い状態なので、ここは機械的に潰す。
 */
export function checkSources(
  body: FeatureDocBody,
  repoPath: string,
  currentRepo: string,
): SourceCheck {
  const seen = new Set<string>();
  const check: SourceCheck = { total: 0, valid: 0, missingFiles: [], outOfRange: [] };

  for (const source of collectSources(body)) {
    // 他リポジトリ由来の出典は、いまのチェックアウトでは検証しようがない。
    // 検証できないものを「無効」と扱うとマルチリポジトリで記述が消えるため対象外にする。
    if (!isSameRepo(source, currentRepo)) continue;

    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    check.total += 1;

    const abs = resolve(repoPath, source.file);
    // リポジトリ外を指す出典は不正扱い
    if (!abs.startsWith(resolve(repoPath))) {
      check.missingFiles.push(source.file);
      continue;
    }
    if (!existsSync(abs)) {
      check.missingFiles.push(source.file);
      continue;
    }
    const lines = fileLineCount(abs);
    if (source.line !== null && lines !== null && source.line > lines) {
      check.outOfRange.push(`${source.file}:${source.line} (実際 ${lines} 行)`);
      continue;
    }
    check.valid += 1;
  }

  return check;
}

/** 実在しない出典を落とす。出典が全部消えた仕様項目も落とす */
export function pruneInvalidSources(
  body: FeatureDocBody,
  repoPath: string,
  currentRepo: string,
): { body: FeatureDocBody; droppedSources: number; droppedRules: string[] } {
  let droppedSources = 0;
  const droppedRules: string[] = [];

  const isValid = (s: SourceRef): boolean => {
    // 検証できない他リポジトリの出典は残す（消すと BE/FE 間で記述が失われる）
    if (!isSameRepo(s, currentRepo)) return true;
    const abs = resolve(repoPath, s.file);
    if (!abs.startsWith(resolve(repoPath)) || !existsSync(abs)) return false;
    const lines = fileLineCount(abs);
    return !(s.line !== null && lines !== null && s.line > lines);
  };

  const filterSources = <T extends { sources: SourceRef[] }>(item: T): T => {
    const kept = item.sources.filter((s) => {
      if (isValid(s)) return true;
      droppedSources += 1;
      return false;
    });
    return { ...item, sources: kept };
  };

  const rules = body.rules
    .map(filterSources)
    .filter((rule) => {
      if (rule.sources.length > 0) return true;
      droppedRules.push(rule.text);
      return false;
    });

  return {
    body: {
      ...body,
      rules,
      permissions: body.permissions.map(filterSources),
      featureFlags: body.featureFlags.map(filterSources),
    },
    droppedSources,
    droppedRules,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** エージェントが読んだファイルのうち、PR の変更ファイルと一致した割合 */
function computeReadCoverage(
  filesRead: string[],
  changedFiles: string[],
  repoPath: string,
): number {
  if (changedFiles.length === 0) return 1;

  const normalized = new Set(
    filesRead.map((f) => (isAbsolute(f) ? relative(repoPath, f) : f)),
  );
  const hit = changedFiles.filter((f) => normalized.has(f)).length;
  return clamp01(hit / changedFiles.length);
}

export interface ConfidenceInput {
  body: FeatureDocBody;
  repoPath: string;
  /** いま解析しているリポジトリ `owner/name` */
  currentRepo: string;
  /** PR で変更されたファイル（リポジトリルートからの相対パス） */
  changedFiles: string[];
  /** エージェントが実際に開いたファイル */
  filesRead: string[];
  /** モデルの自己申告値 */
  selfReported: number;
}

/**
 * 確度を機械的に算出する。
 *
 * モデルの自己申告は当てにならない（実測で全実行が 0.75〜0.80 に収束した）ので、
 * 観測できる指標だけからスコアを作る。自己申告は比較用に残すだけで加点には使わない。
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const { body, repoPath, currentRepo, changedFiles, filesRead, selfReported } = input;

  const check = checkSources(body, repoPath, currentRepo);
  const sourceValidity = check.total === 0 ? 0 : check.valid / check.total;

  const readCoverage = computeReadCoverage(filesRead, changedFiles, repoPath);

  // 仕様1項目あたり出典2件を満点とする
  const totalSources = collectSources(body).filter((s) => isSameRepo(s, currentRepo)).length;
  const citationDensity =
    body.rules.length === 0 ? 0 : clamp01(totalSources / (body.rules.length * 2));

  // 未確認事項が仕様項目数に対して多いほど、推測に頼っている
  const determinacy =
    body.rules.length === 0
      ? 0
      : clamp01(1 - body.openQuestions.length / (body.rules.length + body.openQuestions.length));

  const score = clamp01(
    0.4 * sourceValidity + 0.25 * readCoverage + 0.2 * citationDensity + 0.15 * determinacy,
  );

  return {
    score: Math.round(score * 100) / 100,
    sourceValidity: Math.round(sourceValidity * 100) / 100,
    readCoverage: Math.round(readCoverage * 100) / 100,
    citationDensity: Math.round(citationDensity * 100) / 100,
    determinacy: Math.round(determinacy * 100) / 100,
    selfReported,
  };
}
