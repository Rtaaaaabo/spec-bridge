# 本番に出す（Fly.io）

English: [deploy.md](deploy.md)

手元で動かす手順は [github-app-setup.ja.md](github-app-setup.ja.md) にあります。
ここは**常時動かす**ための手順です。cloudflared のトンネル（起動のたびに URL が変わる）から卒業できます。

## 構成

```
1つの Fly アプリ / 2つのプロセス
├─ app     画面（/、/runs、/installations）+ webhook の受け口（/api/webhooks/github）
└─ worker  解析の実行（常駐、HTTP は持たない）

Postgres  ジョブとインストールの設定
```

**webhook の受け口を画面と同じプロセスに置いているのは、ホスト名を1つで済ませるため**です
（Fly は1つのホスト名を複数プロセスへ振り分けられません）。
受信は「署名を検証して積むだけ」なので軽く、重い解析は worker が引き取ります。
署名検証とジョブ投入は共有実装（`packages/ingest`）なので、入口が2つあっても道は1本です。

**画面を Vercel に置かないのは、`/api/ask` が Agent SDK（Claude Code のバイナリを起動）を使うため**です。
サーバーレスでは動きません。

## 0. 準備

```bash
brew install flyctl
fly auth login
```

**この手順は Fly の課金設定が要ります**（無料枠だけでは常時稼働できません）。
月あたりの目安は、app（1GB）と worker（2GB）で $10〜20 程度です。

## 1. アプリを作る

```bash
fly launch --no-deploy --copy-config --name spec-bridge --region nrt
fly config validate    # fly.toml がその版のスキーマに合うか確かめる
```

**アプリ名は Fly 全体で一意です。** `spec-bridge` が取られていたら別の名前にして、
`fly.toml` の `app` と `SPEC_BRIDGE_BASE_URL`、そして手順5の GitHub App の URL を
**3か所とも**同じホスト名に揃えてください。ここがずれると、
webhook が届かない／ログイン後に戻ってこない／Cookie に `Secure` が付かない、のどれかが起きます。

`fly launch` は対話で Postgres や Redis の追加を聞いてくることがあります。
**いいえ**で構いません（Postgres は次の手順で用意します）。

## 2. Postgres を用意してつなぐ

Fly Postgres でも Neon でも構いません。接続文字列が取れれば十分です。
表（`jobs` / `installations`）は起動時に自動で作られます。

**`attach` はアプリが先に存在している必要があります**（だから手順1が先）。

```bash
fly postgres create --name spec-bridge-db --region nrt
fly postgres attach spec-bridge-db --app spec-bridge   # DATABASE_URL が設定される
```

> `fly postgres` は「サポート対象外（unmanaged）」の扱いになり、
> 運用と復旧は自分持ちだという警告が出ます。**このアプリでは気にしなくて構いません** —
> ここに置くのは実行中のジョブとインストールの設定だけで、
> **生成物は docs リポジトリにあるので、消えても復旧できます**。
> 管理されたものが欲しければ `fly mpg`（Managed Postgres）、
> 外部でよければ Neon でも構いません。どれでも `DATABASE_URL` を渡すだけです。

> **コマンドは Fly の版で変わります。** 上が通らなければ `fly postgres --help` /
> `fly mpg --help` を見てください。このアプリが要るのは `DATABASE_URL` だけです。

## 3. 秘密情報を入れる

手元の `.env` と鍵ファイルに値があるなら、**手で写さずに流し込む**のが安全です。
API キーは `read -rs` で受け取るので、シェルの履歴にも残りません。

```bash
read -rs -p "ANTHROPIC_API_KEY: " ANTHROPIC_KEY; echo

{
  grep -E '^(GITHUB_APP_ID|GITHUB_WEBHOOK_SECRET|GITHUB_APP_CLIENT_ID|GITHUB_APP_CLIENT_SECRET|SPEC_BRIDGE_DOCS_REPO|SPEC_BRIDGE_ALLOWED_LOGINS)=' .env
  printf '%s\n' "GITHUB_APP_PRIVATE_KEY=$(awk '{printf "%s\\n", $0}' ~/.config/spec-bridge/app.pem)"
  printf '%s\n' "SPEC_BRIDGE_SESSION_SECRET=$(openssl rand -hex 32)"
  printf '%s\n' "ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
} | fly secrets import --app spec-bridge

unset ANTHROPIC_KEY
```

> ⚠️ **`printf` を `echo` にしないでください。** zsh の `echo` は `\n` を改行として解釈するので、
> せっかく1行に畳んだ秘密鍵が元の複数行に戻り、
> `Secrets must be provided as NAME=VALUE pairs` で失敗します（実際に踏みました）。

秘密鍵だけ別に入れてもよく、そのほうがエスケープの問題は起きません
（読み込み側は改行そのままでも `\n` でも受け付けます）。

```bash
fly secrets set --app spec-bridge \
  GITHUB_APP_PRIVATE_KEY="$(cat ~/.config/spec-bridge/app.pem)"
```

- **`ANTHROPIC_API_KEY` は必須です。** コンテナに Claude Code のログインは無いので、
  ここから実費が発生します（大規模 PR で1本 $10〜15）。
  Anthropic 側でも上限を設定してください（`SPEC_BRIDGE_PR_BUDGET_USD` は PR 1本の上限で、月額ではありません）
- **API キーを手元の `.env` に書かないでください。** 書くと、ローカルの `analyze` / `backfill` が
  サブスクリプションではなく API 課金に切り替わります
- **`DATABASE_URL` は入れません。** 手順2の `attach` が設定済みです
- **セッション鍵は本番用に新しく作ります。** 手元と共有する利点はありません
- **`SPEC_BRIDGE_ALLOWED_LOGINS` を忘れると誰もログインできません。** 逆に、
  ここを空のまま公開しても誰も入れないので、事故の向きは安全側です

## 4. デプロイする

```bash
fly secrets list           # 名前とダイジェストだけ出る（値は出ない）。DATABASE_URL を含めて10個
fly deploy --remote-only   # 手元の Docker を使わず、Fly 側でイメージを作る
fly status                 # app と worker が動いているか
fly logs -a spec-bridge
```

`--remote-only` にすると Docker Desktop を起動しなくて済みます。
手元でビルドを確かめたい場合は `docker build .` を先に一度通してください。

> ⚠️ **秘密情報を入れる前にデプロイすると、worker が起動に失敗します**
> （`DATABASE_URL` が無いため。ログに理由が出ます）。手順3を先に済ませてください。

worker の起動ログに、認証方式・提出先の既定・PR 1本あたりの上限・同時解析数が出ます。

## 5. GitHub App の URL を差し替える

固定 URL になったので、App の設定を1度だけ直します。

| 設定 | 値 |
| --- | --- |
| Webhook URL | `https://spec-bridge.fly.dev/api/webhooks/github` |
| Redirect URI（Identifying and authorizing users。旧称 Callback URL） | `https://spec-bridge.fly.dev/api/github/callback` を**追加**する |

Redirect URI は10個まで登録できます。`http://localhost:3000/api/github/callback` は消さずに残すと、
手元でも同じ App でログインできます。

`SPEC_BRIDGE_BASE_URL`（`fly.toml`）も同じホストに合わせてください。
**この値からセッション Cookie の `Secure` を決めています。**

## 6. 確認する

```bash
curl https://spec-bridge.fly.dev/api/health          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://spec-bridge.fly.dev/   # 307（ログインへ）
```

そのうえで、対象リポジトリで小さな PR をマージします。
`fly logs` に受領（`ジョブを積みました`）が出て、worker 側で解析が始まれば通っています。
画面の `/runs` でも、費用と進み具合が見えます。

## つまずいたら

| 症状 | 原因 |
| --- | --- |
| worker が起動直後に落ちる | `DATABASE_URL` が無い。`fly secrets list` で確認（値は出ません） |
| worker が「データベースに接続できませんでした」で再起動を繰り返す | **DB のマシンが停止している**ことが多い。`fly status -a <db アプリ>` を見て、停止していたら `fly machine start <ID>`。Fly の内部 DNS は停止中のマシンを起こしません |
| 画面が 500 | `SPEC_BRIDGE_SESSION_SECRET` か `DATABASE_URL` が無い。`fly logs` に理由が出る |
| ログインしても `/login` に戻る | `SPEC_BRIDGE_ALLOWED_LOGINS` に自分が入っていない |
| 認可のあと「state が一致しません」 | App の Redirect URI と `SPEC_BRIDGE_BASE_URL` のホストが違う |
| webhook が 401 | `GITHUB_WEBHOOK_SECRET` が App 側と違う |
| 202 は返るが何も起きない | worker が動いていない。`fly status` と `/runs` を見る |
| 解析が「提出先が設定されていません」で失敗 | 画面の `/installations` で提出先を設定するか、`SPEC_BRIDGE_DOCS_REPO` を入れる |
| `fly config validate` がエラー | fly.toml のスキーマがその版と違う。エラーが指す項目を直す |

`fly logs` は起動時に、認証方式・提出先の既定・PR 1本あたりの上限・同時解析数を出します。
**まずここを見れば、設定が意図どおり効いているか分かります。**

## 運用

| | |
| --- | --- |
| 費用 | `SPEC_BRIDGE_PR_BUDGET_USD`（PR 1本）と、Anthropic 側の組織の上限を両方かける |
| 実時間 | `SPEC_BRIDGE_ANALYZE_CONCURRENCY` を上げると縮む（費用は変わらない）。上限に当たりやすくなるので少しずつ |
| 監視 | `/runs` と `jobs` 表。`fly logs` |
| バックアップ | 不要。生成物は docs リポジトリにある |
| 止めるとき | `fly scale count worker=0`。積まれたジョブは残り、再開すると続きから拾う |

**worker を止めても webhook は受け続けます**（積むだけなので）。
仕事が溜まるだけで、取りこぼしはありません。
