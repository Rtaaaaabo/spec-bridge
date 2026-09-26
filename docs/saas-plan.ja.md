# SaaS 化の設計メモ

**これは進行中の設計記録です。** 実装済みは「1. 認証」と「3. ジョブ」の土台で、2（画面）と 4（提出の一般化）は未着手です。
確定した設計と、その選択理由（あとから読んで判断を蒸し返さないための根拠）を置きます。

いまの CLI / webhook の使い方は [github-app-setup.ja.md](github-app-setup.ja.md) を参照してください。

## 何のための SaaS 化か

最初の範囲は **「backfill を SaaS で回す」** ことだけです。
どの利用者層（FDE・引き継ぎ・技術 DD・自社プロダクト）でも最初に必要になるのが
「いまあるコードから機能ドキュメント一式を起こす」ところなので、ここから作れば無駄になりません。

必要なのは3つです。

1. GitHub App をインストールしてリポジトリを選ぶ
2. backfill をジョブとして実行する（1機能あたり数分・全体で30分級）
3. 結果（機能ドキュメントと `open-questions.md`）を docs リポジトリへの PR として届ける

## 先に決めたこと

| | 決定 | 理由 |
| --- | --- | --- |
| 実行環境 | 画面は Vercel、**ジョブ実行は常駐プロセス1つ**（Fly.io のマシン。Dockerfile に git を同梱） | Agent SDK は Claude Code のバイナリを spawn するので Edge では動かず、サーバーレスの実行時間上限（Vercel は 300 秒）にも収まらない |
| LLM の課金 | **プラットフォーム持ちの `ANTHROPIC_API_KEY` 1本**。テナントごとのキーは持たない | `ANTHROPIC_API_KEY` はプロセス単位でしか持てない（Agent SDK が env から読む）。テナント別にするとプロセス分離が必要になる。従量の計算は `UsageSummary.costUsd` をジョブ1件ごとに記録すれば足りる |
| 状態の置き場所 | **Postgres 1つ**（ジョブ・installation・テナント設定・消費量） | キューのために Redis を増やさない。ジョブ表1つで永続化・リトライ・冪等が揃う |

サブスクリプション認証で当たっていた「利用上限」は、API キーだと 429 / `overloaded_error` に変わります。
リトライの判定条件はそこに置きます。

## 1. 認証：GitHub App のインストールトークン（実装済み）

PAT 1本は、複数テナントでは「1つの認証情報で全テナントのリポジトリを触れる」ことになります。
installation access token に交換すると、トークンがインストール先のリポジトリに限定され、
レート制限も installation ごとに 5,000/時 になります。

- `packages/github/src/app-auth.ts` — App ID と秘密鍵から installation トークンへ交換する。
  `GitHubAuth.forRepo(repo, installationId?)` が「このリポジトリを触るための認証」を返す入口
- `InstallationTokenStore` — トークンは1時間で失効するので、**失効の5分前に捨てる**。
  解析は数分〜30分かかるため、「取得時は有効、処理中に失効」を避ける
- `packages/github/src/octokit.ts` — `createOctokit` から**既定引数 `process.env.GITHUB_TOKEN` を外した**。
  渡し忘れが黙ってグローバル認証情報で動くのは、マルチテナントでは「別テナントとして操作する」ことになる。
  env から作るのは `createOctokitFromEnv()` を明示的に呼んだときだけ（CLI 専用）
- `fetchPullRequest` / `publishDocsAsPullRequest` は認証を**必須の引数**で受ける。
  解析対象リポジトリ用と docs リポジトリ用は別トークンなので、既定値があると取り違えに気づけない
- 半端な設定（App ID だけ・秘密鍵だけ）は**起動時に失敗させる**。
  「App を設定したつもりで、実は PAT で動いていた」が最も気づけない失敗のため

移行のあいだ PAT 運用も残してあります（`resolveGitHubAuth` が App の設定があればそちらを選ぶ）。

**残っている前提**: docs リポジトリへの書き込みも installation トークンで行うため、
App 運用では docs リポジトリにも App を入れる必要があります。その結果、無限ループの防止は
`isDocsRepoEvent` のガード1つに依存します（[SECURITY.ja.md](../SECURITY.ja.md) 参照）。
マルチテナントにするときは、この比較をグローバルな1リポジトリではなく**テナントごとの設定**に変えます。

## 2. 画面：インストールとリポジトリ選択（未着手）

`apps/web` には認証が一切ありません（middleware なし、`/api/ask` は誰でも叩ける）。
「テナント分離が要る」の前に「認証がまだ無い」段階です。

**GitHub App の user-to-server OAuth でログインも兼ねる**のが一番安い。
ログインの主体とインストールの主体が一致するので、テナントの解決が自明になります。

- `GET /api/github/login` → App の OAuth へ（`state` は Cookie と突き合わせる）
- `GET /api/github/callback` → `installation_id` / `setup_action` を受け、`GET /installation/repositories` で一覧
- リポジトリ選択の画面 → 選択を保存
- docs リポジトリは同じ画面で「既存を選ぶ / 新規作成」。空リポジトリの初回コミットは `resolveBaseSha` が面倒を見る

テーブルは最小5つ: `tenants` / `installations` / `repos` / `docs_targets` / `jobs`。

## 3. ジョブ：backfill を分割して実行する（土台は実装済み）

キューは **`jobs` 表 + `FOR UPDATE SKIP LOCKED` のポーリング**（`packages/jobs`）。
PR 解析（`analyze.pr`）を先にこの仕組みへ載せ替えた。webhook は署名を検証して**積むだけ**になり、
実行は `pnpm worker` が行う。backfill の3分割はこの土台の上に乗せる。

実装したもの:

- `packages/jobs/src/store.ts` — 置き場所の口。Postgres 実装（本番）とメモリ実装（テストと、
  DB を用意していないローカル）を差し替える
- `packages/jobs/src/worker.ts` — 取り出し → 実行 → 成否の記録。処理中はハートビートでリースを延ばす
- `packages/jobs/src/retry.ts` — **待てば直るものだけ**再試行する判定（利用上限・429・5xx など）と
  指数バックオフ + ジッタ
- `apps/webhook/src/worker.ts` — `analyze.pr` の処理（`handleMergedPullRequest` を呼ぶ）

**`dedupe_key` の一意制約が「再送で PR が2つできる」を塞いだ。**
判定に `xmax = 0` を使うと「もともと queued」と「failed から復活」が区別できず、
重複を「積んだ」と報告してしまう（実 DB で踏んだ）。CTE で実行前の状態を取って判定している。

残りの分割:

**backfill 1回を1ジョブにしない。** 3種類に割ります。

| kind | やること | 目安 |
| --- | --- | --- |
| `backfill.survey` | 機能を列挙し、機能ごとに `backfill.feature` を積む | 数十秒 |
| `backfill.feature` | 1機能を解析し、docs ブランチへコミット | 約 $1.7・4分半 |
| `backfill.finish` | `README.md` と `open-questions.md` を再生成して PR を開く | 数秒 |

理由は実データで踏んだ失敗そのものです。7機能を連続実行したら4件目で利用上限に当たり、
**1件ずつ独立していたから成功した4件が残った**。ジョブも同じ粒度にすれば、リトライが機能単位になり、
進捗が「3/12」で出せて、1ジョブが5分以内に収まります。
既存 docId をここで弾けば、欲しかった `--only-new` も自然に入ります。

そのために core を割ります（`runBackfill` は CLI 用に3つを回すループとして残すので、
既存のテストと CLI の挙動は変わりません）。

```ts
export async function surveyForBackfill(options: BackfillOptions): Promise<...>
export async function backfillOneFeature(feature: SurveyedFeature, options: BackfillOptions): Promise<...>
```

- **機能ジョブ間の受け渡しは docs リポジトリのブランチに寄せる。** ランナーのローカルに置くと
  マシンの再起動で消える。1ラン = 1ブランチ（`spec-bridge/backfill-<run>`）、コミットは機能ごと
- 解析対象リポジトリは機能ジョブごとに浅くクローンし直す。「ソースコードを永続化しない」約束を崩さない
- 同時実行はグローバル2・テナント1。`lease_until` のハートビートで、死んだワーカーのジョブを回収
- リトライは 429 / `overloaded_error` / 利用上限のときだけ指数バックオフ。
  それ以外は即失敗（プロンプトのバグを何度も課金しない）
- `dedupe_key` を一意制約にする。webhook の再送で PR が2つできる問題も同時に消える
- **ランごとの予算上限（`budgetUsd`）を最初から入れる。** 12機能で $20 前後になるので、
  誰かに触らせる前に必須。超えたら残りの機能ジョブを積まずに `finish` へ落とす

## 4. 提出：backfill の結果を PR にする（未着手）

`publishDocsAsPullRequest` は出所に依存していませんが、`buildDocsPullRequestBody` が
`sourcePr: PullRequestInput` を必須にしているため、いまは backfill 結果を PR にできません。

- 入力を `ChangeSource` と同じ形に一般化する
  （`{ kind: "pull-request", pr } | { kind: "backfill", repo, sha, surveyed, usage }`）。
  冒頭の段落とタイトルだけを分岐させ、確度の内訳・警告・確認事項のセクションは共有する。
  既存の2関数は薄いラッパとして残してテストを通す
- `docs-repo.ts` から `commitFilesToBranch` と `ensurePullRequest` を切り出す。
  backfill は「機能ごとに commit → 最後に PR を1つ」で同じ部品を使う
- backfill の PR 本文には、PR 参照の代わりに
  **どのコミットから起こしたか（sha）／列挙 N 件・生成 M 件・失敗 K 件／所要時間と推定コスト**を出す。
  途中で終わったランを人が見て分かるようにするため
- 副産物として `preserveDocs`（`~/.spec-bridge/failed/`、削除されない）が不要になる。
  成功した機能はその時点でブランチに乗っているため
