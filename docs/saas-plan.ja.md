# SaaS 化の設計メモ

**これは進行中の設計記録です。** 4段階とも実装済みです（1 認証・2 画面・3 ジョブ・4 提出）。
残りは運用と精度の課題で、下の「残り」を参照してください。
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

## 2. 画面：ログインとインストール（ログインまで実装済み）

`apps/web` には認証が一切なく、`/api/ask` を誰でも叩けた。まずそこを塞いだ。

**GitHub App の user-to-server OAuth でログインも兼ねる。** ログインの主体とインストールの主体が
一致するので、テナントの解決が自明になる（別の OAuth App を用意すると対応表を自前で持つことになる）。

実装したもの:

- `GET /api/github/login` → 認可画面へ（`state` は Cookie と突き合わせる）
- `GET /api/github/callback` → `code` を交換し、**署名付きセッション Cookie** を発行
- `/login`、`/installations`（App が読めるリポジトリの一覧）、ログアウト
- **アクセストークンは保存しない。** Cookie が漏れても、そのままリポジトリを触れる鍵にはしない
- **`proxy.ts`（旧 middleware）は認証ではない。** Edge ランタイムからはルートの `.env` を読めず署名鍵を持てないので、
  Cookie の有無だけを見て振り分ける。本当の検証はサーバー側の `currentSession()`。
  この区別を曖昧にすると「middleware があるから安全」と誤解して穴が空く

**ラン一覧（`/runs`）も実装済み。** `jobs` 表を `runId` で束ねて、進み具合・費用・PR・失敗を出し、
同じ画面からランを始められる。**画面のためにラン表は作らない**（状態を二重に持つと必ず食い違う）。
まとめ方は `@spec-bridge/backfill` の `summarizeRuns`（純関数なのでテストがある）。

**テナント表も入れた**（`packages/tenants`）。**テナント = GitHub App のインストール1つ**で、
独自の ID を重ねない。持つのは「どのインストールの生成物を、どこへ出すか」だけ。

- `installations` 表1つ（`installation_id` / `account` / `docs_repo`）
- webhook の `installation` イベントで記録し、アンインストールで消す。
  **suspend では消さない**（止まっているだけなので、設定を消すと再開時に入れ直しになる）
- 提出先は `resolveDocsRepo` が「インストールの設定 → `SPEC_BRIDGE_DOCS_REPO` → 失敗」の順で決める。
  env は単一テナント運用の後方互換で、設定済みのテナントより優先されることはない
- 画面（`/installations`）から設定でき、**保存前に App がそのリポジトリを触れるか確かめる**
  （触れない提出先を保存できると、失敗するのは数分後の解析の最後になる）

残り:

- 利用者ごとに見える範囲を変える（いまは App 全体のインストールを見せている）。
  いまのところ運用者しかログインしないので困っていない
- ラン一覧に費用は出るが、**PR 解析の費用は画面から見えない**（`analyze.pr` ジョブの結果にはある）
- `isDocsRepoEvent` の比較対象は、解決した提出先（テナントの設定）になった。
  複数テナントでもそれぞれの docs リポジトリで自己ループを防げる

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

**backfill も3分割で載せた**（`apps/webhook/src/backfill-job.ts` / `backfill-handlers.ts`）。
以下の設計どおりに実装してあり、ラン専用の表は作っていない
（`payload @> {runId}` で兄弟ジョブを引き、そこから進み具合と費用を集計する）。

- **予算は着手前に見る。** 走らせてから超過に気づいても、その1件の費用はもう出ている。
  超えた機能は `skipped: over-budget` として費用0で終える
- **仕上げは順番ではなく状態で待つ。** ワーカーが複数いると完了順は保証されないので、
  終わっていない兄弟がいるあいだは自分を30秒後ろへ積み直す
- **失敗も「終わった」として扱う。** 1件の失敗で PR を出せなくしない（失敗件数は PR 本文に出る）

設計（実装済み）:

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

## 4. 提出：backfill の結果を PR にする（実装済み）

`buildDocsPullRequestBody` が `sourcePr: PullRequestInput` を必須にしていたため、
backfill の結果はローカルディレクトリにしか書けなかった。出どころを `DocsPrSource`
（`{ kind: "pull-request", pr } | { kind: "backfill", repo, sha, surveyed, failed, usage }`）に
一般化し、冒頭の段落とタイトルだけを分岐させた。確度の内訳・警告・確認事項は共有している。

- `pnpm backfill --docs-repo org/repo` で、PR 解析と同じ経路に載る
- backfill の本文には、PR 参照の代わりに**起点のコミット／列挙 N 件・生成 M 件・失敗 K 件／
  所要時間と推定コスト**を出す。失敗があれば「このランだけでは全機能を網羅していません」と明記する
- **作業ツリーが汚れていれば起点のコミットを書かない**（`detectCheckoutState`）。
  その SHA は起点として嘘になる
- `docs-repo.ts` から `commitFilesToBranch` と `ensurePullRequest` を切り出した。
  **1本のブランチに積み増して PR は1つ**にできるので、機能ごとに別ジョブで書く形（上の3）に載る

機能ごとのジョブ分割とランの予算上限は実装済み（上の3）。

## 費用の扱い（「安くする」より「先に知らせる」）

大規模 PR は実測で **6機能・約 $15・29分**（gitea #38966）。6機能ぶんのドキュメントが
更新されるなら妥当な額だが、**自動で走る以上、上限と予告が要る**。

- **見積もり**: 分類は $0.27 で機能数が分かる。分類直後に
  「6 機能 / 推定 $15・約27分」をログへ出し、`pnpm analyze --estimate` なら分類だけで止まる。
  見積もりは「実測の平均 × 機能数」で、根拠を併記して精度を装わない
- **上限**: `SPEC_BRIDGE_PR_BUDGET_USD`（既定 $10）。着手前に判定し、
  打ち切った機能は docs の PR 本文に名前を出す（予算を上げて再実行すれば拾える）
- **時間**は費用と別の話。機能どうしは独立なので、`analyze.pr` を機能ごとのジョブに割れば
  ワーカー数ぶん実時間が縮む（費用は変わらない）。**未着手**

残り: `preserveDocs`（`~/.spec-bridge/failed/`、削除されない）の掃除。
backfill は機能ごとにブランチへ積むので、もう要らないはず。
