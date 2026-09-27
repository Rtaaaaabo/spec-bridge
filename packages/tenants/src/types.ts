/**
 * テナント = GitHub App のインストール1つ。
 *
 * **新しい「テナント」という概念を作らない。** 誰が使っているかを表すのは
 * すでにインストールで、そこに独自の ID を重ねると対応表の維持が仕事になる。
 */
export interface Tenant {
  installationId: number;
  /** インストール先のアカウント（表示用） */
  account: string;
  /**
   * 生成物の提出先 `org/repo`。**未設定なら解析しない。**
   *
   * 提出先が分からないまま解析すると、数分〜30分かけた結果の行き先が無い。
   */
  docsRepo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantInput {
  installationId: number;
  account: string;
  docsRepo?: string | null;
}

/** `org/repo` として妥当か。画面から入る値なので、保存前にここで弾く */
export function isValidRepoName(value: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * docs リポジトリとして保存してよい値に整える。
 *
 * 空文字は「未設定に戻す」扱い（`null`）。画面から消せるようにするため。
 */
export function normalizeDocsRepo(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return null;
  if (!isValidRepoName(trimmed)) {
    throw new Error(`提出先は org/repo の形式で指定してください: ${JSON.stringify(value)}`);
  }
  return trimmed;
}
