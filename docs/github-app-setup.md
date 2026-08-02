# GitHub App のセットアップ

PR がマージされたら自動でドキュメントを更新し、**docs リポジトリへ PR を出す**ところまでを動かす手順です。

CLI（`pnpm analyze`）は手で叩く前提でしたが、こちらは放っておいても更新されます。

## 全体像

```
PR がマージされる
    ↓ webhook
spec-bridge webhook サーバー
    ├─ 署名を検証（これが唯一の認証）
    ├─ 解析対象リポジトリを一時ディレクトリへ浅くクローン
    ├─ 分類 →（仕様に影響するなら）解析
    ├─ docs リポジトリへ PR を作成
    └─ クローンを破棄
    ↓
人間がレビューしてマージ  ← ここが承認フロー
```

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
7. 左メニューの Install App から、解析対象リポジトリと docs リポジトリの両方にインストールする

> ⚠️ 秘密鍵と webhook secret はリポジトリにコミットしないでください。
> `.gitignore` は `.env` と `.env.*` を除外しています。

### 作成フォームでよく出るエラー

| エラー | 対処 |
| --- | --- |
| `Homepage URL must be a valid URL` | 必須項目。`https://` から始まる完全な URL を入れる（`github.com/...` だけでは通らない） |
| `Name has already been taken` | App 名は**全 GitHub で一意**。アカウント名などを付けて重複を避ける |
| `Webhook URL is not a valid URL` | こちらも `https://` から始まる完全な URL が必要。仮の URL で先に進んでよい |

## 3. 環境変数を設定する

`spec-bridge/.env` に追記します。

```bash
# webhook
GITHUB_WEBHOOK_SECRET=<手順2で控えた secret>
SPEC_BRIDGE_DOCS_REPO=<your-org>/<your-product>-specs
PORT=3939

# 認証（当面は PAT でよい。GitHub App のトークン交換は未実装）
GITHUB_TOKEN=<Contents と Pull requests に read/write がある PAT>
```

> **現状の制約**: webhook の受信と署名検証は GitHub App で行いますが、
> API 呼び出しは `GITHUB_TOKEN`（PAT）を使います。
> インストールトークンへの交換（App ID + 秘密鍵 → installation access token）は未実装です。
> 1組織で使う分には PAT で足りますが、複数テナントに配る場合は必須になります。

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

```bash
pnpm webhook
```

```
spec-bridge webhook listening on http://localhost:3939
  POST /webhooks/github
  docs リポジトリ: your-org/your-product-specs
```

必要な環境変数が足りない場合は起動時に落ちて、何が足りないかを表示します。

## 6. 動作確認

```bash
curl http://localhost:3939/health
# {"ok":true,"docsRepo":"your-org/your-product-specs"}
```

そのうえで、対象リポジトリで小さな PR をマージしてください。ログに以下が流れます。

```
▸ acme/backend#123 feat: ... （8 ファイル）
  docs リポジトリから 3 件のドキュメントを取得
▸ この PR が仕様に影響するか分類中…
  → 影響あり: ...
▸ 「...」を解析中…
  ✓ PR 作成: https://github.com/your-org/your-product-specs/pull/1
```

仕様に影響しない PR（依存更新など）は分類の時点でスキップされ、PR は作られません。

## トラブルシューティング

| 症状 | 原因 |
| --- | --- |
| 401 が返る | `GITHUB_WEBHOOK_SECRET` が GitHub App 側の設定と違う |
| 202 は返るが PR ができない | サーバーログを確認。`GITHUB_TOKEN` の権限不足が多い |
| `{"ignored":true}` | マージされた PR 以外は無視する仕様。正常 |
| 解析が始まらない | 分類でスキップされている。ログの「影響なし」の理由を確認 |

GitHub App の Advanced タブから、送信された webhook の内容と再送（Redeliver）ができます。

## まだできないこと

- **インストールトークンへの交換が未実装**（上記のとおり PAT で代用）
- **キューがない。** リクエストを受けたプロセスがそのまま解析します。
  同時に大量の PR がマージされると詰まるため、本格運用では Trigger.dev などが必要です
- **リトライがない。** 解析が失敗したら、GitHub App の画面から手動で Redeliver してください
