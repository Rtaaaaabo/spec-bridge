# GitHub App のセットアップ

English: [github-app-setup.md](github-app-setup.md)

PR がマージされたら自動でドキュメントを更新し、**docs リポジトリへ PR を出す**ところまでを動かす手順です。

CLI（`pnpm analyze`）は手で叩く前提でしたが、こちらは放っておいても更新されます。

## 全体像

```
PR がマージされる
    ↓ webhook
spec-bridge webhook サーバー
    ├─ 署名を検証（これが唯一の認証）
    └─ ジョブを1件積んで 202 を返す（同じマージなら積まない）
    ↓
spec-bridge worker（別プロセス）
    ├─ ジョブを1件ロックして取り出す
    ├─ リポジトリごとに認証を解決（App なら installation トークンへ交換）
    ├─ 解析対象リポジトリを一時ディレクトリへ浅くクローン
    ├─ 分類 →（仕様に影響するなら）解析
    ├─ docs リポジトリへ PR を作成
    └─ クローンを破棄
    ↓
人間がレビューしてマージ  ← ここが承認フロー
```

**受信と実行を分けてあります。** 解析は数分かかるので受信プロセスで走らせると、
再起動で仕事が消え、同時に複数マージされると詰まります。

**ソースコードは一時ディレクトリにしか置かず、処理後に必ず消します。**

## 1. docs リポジトリを用意する

生成されたドキュメントの提出先です。**必ず非公開（Private）にしてください。**
ドキュメントには内部のファイルパス・行番号・仕様が含まれます。

```bash
gh repo create <your-org>/<your-product>-specs --private
```

中身は空で構いません。**コミットが1つもない空リポジトリでも動きます** —
初回実行時に初期コミットを自動で作り、その上に PR を立てます。

## 2. GitHub App を作成する

以下はブラウザでの操作が必要です。

1. https://github.com/settings/apps/new を開く
2. 入力する項目

   | 項目 | 値 |
   | --- | --- |
   | GitHub App name | 任意（例: `spec-bridge-<your-org>`）。**全 GitHub で一意**である必要がある |
   | Homepage URL | **必須**。`https://` から始まる有効な URL。決まっていなければ `https://github.com/Rtaaaaabo/spec-bridge` でよい |
   | Webhook URL | この時点ではまだ確定しないので、仮に `https://example.com/webhooks/github` を入れておく。**手順4でトンネルを張ってから正しい URL に差し替える** |
   | Webhook secret | **強いランダム文字列を生成して控える**（例: `openssl rand -hex 32`） |

3. Repository permissions

   | 権限 | レベル | 用途 |
   | --- | --- | --- |
   | Contents | **Read and write** | 解析対象の読み取り、docs リポジトリへのコミット |
   | Pull requests | **Read and write** | PR の差分取得、docs リポジトリへの PR 作成 |
   | Metadata | Read-only | 自動で付く |

4. Subscribe to events で **Pull request** にチェック
5. 「Where can this GitHub App be installed?」は Only on this account で十分
6. 作成後の画面で:
   - **App ID** を控える
   - **Generate a private key** で秘密鍵（`.pem`）をダウンロード
7. 左メニューの Install App から、**解析対象リポジトリ**にインストールする。
   App のインストールトークンで動かす場合（手順3の推奨構成）は、**docs リポジトリにも**インストールする
   — docs リポジトリへの書き込みもそのトークンで行うためです

> ⚠️ **docs リポジトリに App を入れると、無限ループの防止はコード側のガードだけになります。**
> 生成された PR をマージすると webhook が発火し、docs リポジトリ自身を解析して次の PR を作る、
> という連鎖が起こりえます。これは `isDocsRepoEvent`（`packages/github/src/webhook.ts`）が
> `SPEC_BRIDGE_DOCS_REPO` と一致するリポジトリのイベントを捨てることで止めています。
> **`SPEC_BRIDGE_DOCS_REPO` の綴りが実際の docs リポジトリと一致していることを必ず確認してください**
> （大文字小文字と前後の空白は無視されます）。
> ガードに頼りたくない場合は、docs リポジトリには App を入れず、PAT 運用（手順3の代替）にしてください。

> ⚠️ 秘密鍵と webhook secret はリポジトリにコミットしないでください。
> `.gitignore` は `.env` と `.env.*` を除外しています。

### 作成フォームでよく出るエラー

| エラー | 対処 |
| --- | --- |
| `Homepage URL must be a valid URL` | 必須項目。`https://` から始まる完全な URL を入れる（`github.com/...` だけでは通らない） |
| `Name has already been taken` | App 名は**全 GitHub で一意**。アカウント名などを付けて重複を避ける |
| `Webhook URL is not a valid URL` | こちらも `https://` から始まる完全な URL が必要。仮の URL で先に進んでよい |

## 3. 環境変数を設定する

`spec-bridge/.env` に追記します。API の認証は
**GitHub App のインストールトークン（推奨）** と **PAT** のどちらかです。

```bash
# webhook
GITHUB_WEBHOOK_SECRET=<手順2で控えた secret>
SPEC_BRIDGE_DOCS_REPO=<your-org>/<your-product>-specs
PORT=3939

# 認証（推奨）: App ID + 秘密鍵を installation access token に交換する
GITHUB_APP_ID=<手順2で控えた App ID>
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/your-app.private-key.pem

# 秘密鍵をファイルで置きたくない場合は、改行を \n にエスケープして1行で渡してもよい
# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# 認証（代替）: PAT 1本で動かす。App の設定が無いときだけ使われる
# GITHUB_TOKEN=<Contents と Pull requests に read/write がある PAT>
```

App 運用にすると、PAT 運用と比べて次が変わります。

- トークンが**インストール先のリポジトリに限定**される（PAT は持ち主の権限がそのまま効く）
- docs リポジトリに作られる PR の**作成者が App 自身**（`app/<slug>`）になる。
  PAT 運用ではトークンの持ち主名義だった。生成物であることが一目で分かり、
  自分の PR を自分で承認する形にもならない
- レート制限が **installation ごとに 5,000/時**（PAT は1本を全用途で共有）
- 解析対象リポジトリ用と docs リポジトリ用で**別のトークン**になる。
  取り違えを防ぐため、`fetchPullRequest` と `publishDocsAsPullRequest` は認証を必須の引数で受けます

> ⚠️ `GITHUB_APP_ID` だけ、または秘密鍵だけを設定すると**起動時にエラーになります**。
> 黙って PAT にフォールバックさせていません
> （「App を設定したつもりで、実は PAT で動いていた」が一番気づけない失敗のため）。

### 認証だけ先に確かめる

トンネルを張って PR をマージする前に、認証設定だけを確認できます。**LLM を呼ばないので無料です。**

```bash
pnpm check-auth --repo-name <解析対象の org/repo> --clone
```

```
認証方式: GitHub App（installation トークンに交換）

✓ App: spec-bridge-acme（slug spec-bridge-acme / App ID 123456）
  - acme（installation 789 / 対象 selected / Contents: write / Pull requests: write）

✓ docs リポジトリ: acme/product-specs（private / 既定ブランチ main）
✓ 解析対象: acme/backend（private / 既定ブランチ main）
  ✓ トークンで浅いクローンができた

結果: 使えます
```

確認する内容は次の4つです。

- App ID と秘密鍵の組み合わせが正しいか（JWT が通るか）
- どのアカウントにインストールされていて、Contents / Pull requests が **write** か
- docs リポジトリと解析対象リポジトリに、**実際に使う認証で**アクセスできるか
- `--clone` を付けると、そのトークンで git の浅いクローンまでできるか（すぐ破棄します）

> ⚠️ 非公開リポジトリに権限が無い場合、GitHub は **404**（存在しない）を返します。
> 「リポジトリが無い」と見分けがつかないので、404 が出たら
> fine-grained PAT の対象リポジトリ、または App のインストール先を確認してください。

## 3.5 画面のログインを設定する（任意）

`apps/web`（CX サポートデスク / インストール一覧）には**ログインが必要**です。
GitHub App の user-to-server OAuth を使うので、新しい App は要りません。

1. App の設定画面（General）で **Callback URL** に次を登録する

   ```
   http://localhost:3000/api/github/callback
   ```

2. 同じ画面の **Client ID** を控え、**Generate a new client secret** で secret を作る
3. `.env` に追記する

   ```bash
   SPEC_BRIDGE_SESSION_SECRET=$(openssl rand -hex 32 の結果)
   GITHUB_APP_CLIENT_ID=<Client ID>
   GITHUB_APP_CLIENT_SECRET=<client secret>
   # 公開 URL が localhost 以外なら
   # SPEC_BRIDGE_BASE_URL=https://specs.example.com
   ```

4. `pnpm web` で起動し、http://localhost:3000/ を開く（未ログインなら `/login` に飛びます）

> ⚠️ `SPEC_BRIDGE_SESSION_SECRET` が未設定だと、画面は**誰も通しません**（素通しにはなりません）。
> 署名を検証できない状態で通すと、Cookie を自作した人が入れてしまうためです。

セッション Cookie に入るのは GitHub のユーザー識別子だけで、**アクセストークンは保存しません**。

## 4. ローカルで受け取れるようにする

GitHub からローカルマシンへは直接届かないので、トンネルを張ります。

```bash
# 例: cloudflared
cloudflared tunnel --url http://localhost:3939
```

表示された `https://....trycloudflare.com` に `/webhooks/github` を付けたものが、本当の Webhook URL です。

```
https://xxxx-yyyy.trycloudflare.com/webhooks/github
```

**GitHub App の設定画面に戻り、手順2で仮に入れた Webhook URL をこれに差し替えてください。**
（App の設定ページ → General → Webhook → Webhook URL）

`smee.io` や `ngrok` でも構いません。

> ⚠️ `cloudflared tunnel --url` で発行される URL は**起動のたびに変わります**。
> トンネルを張り直したら、その都度 Webhook URL を更新する必要があります。
> 固定 URL が欲しい場合は `smee.io` を使うか、cloudflared の名前付きトンネルを設定してください。

## 5. 起動する

ジョブの置き場所に Postgres を使います。`.env` に追記してください。

```bash
DATABASE_URL=postgres://user@localhost:5432/spec_bridge
```

表は起動時に自動で作られます（`packages/jobs/src/schema.sql`）。

受信と実行の2プロセスを別々に起動します。

```bash
pnpm webhook   # 受信して積むだけ
pnpm worker    # 積まれた仕事を処理する
```

ローカルで1つにまとめたい場合は `SPEC_BRIDGE_INLINE_WORKER=1` を付けて `pnpm webhook` だけでも動きます。

> ⚠️ `DATABASE_URL` が無いとジョブはメモリに載ります。プロセスを落とすと消え、
> 別プロセスの `pnpm worker` にも届きません（起動時に警告が出ます）。

```
ジョブの置き場所: Postgres
spec-bridge webhook listening on http://localhost:3939
  POST /webhooks/github
  docs リポジトリ: your-org/your-product-specs
  GitHub 認証: GitHub App（installation トークン）
  ジョブの実行は別プロセスです: pnpm worker
```

必要な環境変数が足りない場合は起動時に落ちて、何が足りないかを表示します。
**どちらの認証で動いているかは最後の行で確認できます**（PAT のときは `PAT（GITHUB_TOKEN）`）。

## 6. 動作確認

```bash
curl http://localhost:3939/health
# {"ok":true,"docsRepo":"your-org/your-product-specs"}
```

そのうえで、対象リポジトリで小さな PR をマージしてください。
webhook 側には受領だけが出ます。

```
[webhook] acme/backend#123 → ジョブを積みました: 3f7c...
```

実際の処理は worker 側のログに流れます。

```
▸ analyze.pr analyze.pr:acme/backend#123:9fbe...（1 回目）
▸ acme/backend#123 feat: ... （8 ファイル）
  docs リポジトリの認証を確認（app）
  docs リポジトリから 3 件のドキュメントを取得
▸ この PR が仕様に影響するか分類中…
  → 影響あり: ...
▸ 「...」を解析中…
  ✓ PR 作成: https://github.com/your-org/your-product-specs/pull/1
  ✓ 完了
```

積まれた仕事は SQL でも見られます。

```sql
select kind, state, attempts, left(last_error, 80), created_at from jobs order by created_at desc;
```

仕様に影響しない PR（依存更新など）は分類の時点でスキップされ、PR は作られません。

## トラブルシューティング

| 症状 | 原因 |
| --- | --- |
| 401 が返る | `GITHUB_WEBHOOK_SECRET` が GitHub App 側の設定と違う |
| 202 は返るが PR ができない | サーバーログを確認。権限不足（Contents / Pull requests が read/write でない）が多い |
| `GitHub App が <repo> にインストールされていません` | その App を対象リポジトリに入れていない。docs リポジトリにも必要（手順2の7） |
| 起動時に `秘密鍵がありません` | `GITHUB_APP_ID` だけ設定されている。秘密鍵も渡すか、App の設定を消して PAT 運用にする |
| `{"ignored":true}` | マージされた PR 以外は無視する仕様。正常 |
| `{"duplicate":true}` | 同じマージのジョブが既にある。再送では PR が2つできない（正常） |
| 202 は返るが何も起きない | `pnpm worker` が動いていない。`jobs` 表に `queued` のまま残っていないか確認 |
| ジョブが `queued` のまま増える | worker が落ちている。リースが切れた仕事は次回起動時に取り直されます |
| 生成された PR をマージすると、また PR ができる | `SPEC_BRIDGE_DOCS_REPO` が docs リポジトリと一致しておらず、ループのガードが効いていない |
| 解析が始まらない | 分類でスキップされている。ログの「影響なし」の理由を確認 |

GitHub App の Advanced タブから、送信された webhook の内容と再送（Redeliver）ができます。

## まだできないこと

- **同時実行は1件。** worker は1プロセスで1件ずつ処理します。
  台数を増やしたい場合は `pnpm worker` を複数起動してください（行ロックで取り合いません）
- **テナントは1つ。** `SPEC_BRIDGE_DOCS_REPO` が唯一の「テナント設定」で、
  ジョブの `tenant_id` は `local` 固定です
