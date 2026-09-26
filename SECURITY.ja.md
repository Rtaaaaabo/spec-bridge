# セキュリティポリシー

English: [SECURITY.md](SECURITY.md)

spec-bridge は**ソースコードと API 認証情報の両方を扱う**ツールです。
導入前に、以下の設計と注意点を確認してください。

## 脆弱性の報告

公開 Issue で報告しないでください。GitHub の
[Security Advisories](https://github.com/Rtaaaaabo/spec-bridge/security/advisories/new)
から非公開で報告してください。

初回応答の目標は7日以内です。個人で運用しているため SLA は保証できません。

## 対象バージョン

`main` ブランチの最新のみをサポートします。0.x の間は後方互換性を保証しません。

## 設計上の防御

### 解析エージェントに渡すツールを制限している

Claude Agent SDK の `allowedTools` は**「自動承認するツール」の指定であって、使えるツールの制限ではありません**。
`permissionMode: "bypassPermissions"` と併用すると全ツールが素通りします。

実際に禁止できるのは `disallowedTools` だけです
（[`packages/core/src/agent.ts`](packages/core/src/agent.ts) の `READ_ONLY_DENY_LIST`）。

| ツール | 禁止する理由 |
| --- | --- |
| `Write` / `Edit` / `NotebookEdit` | 解析対象リポジトリを書き換えさせない |
| `WebFetch` / `WebSearch` | ソースコードを外部に送信させない |
| `Bash` | 既定で禁止。`--allow-bash` を明示したときのみ許可 |

**この制限を緩める変更は、セキュリティ上の変更として扱ってください。**

### ソースコードを永続化しない

解析時にローカルのチェックアウトを読むだけで、ソースコードそのものは保存しません。
永続化されるのは生成された機能ドキュメントのみです。

### CX サポートデスク画面はドキュメントしか読めない

回答エージェントには `Read` / `Grep` / `Glob` も含めて**ツールを一切渡していません**。
与えられた機能ドキュメント以外は参照できないため、「コードを勝手に読んで推測した回答」が構造的に発生しません。

## 利用者側で注意すべきこと

### 生成されたドキュメントの公開範囲

**生成される機能ドキュメントには、ソースファイルのパス・行番号・内部仕様が含まれます。**
出典として意図的にそうしています。

docs リポジトリを公開設定にすると、内部構造が外部から読めます。
**docs リポジトリは非公開にしてください。**

### 画面（apps/web）のログイン

機能ドキュメントには内部のファイルパス・行番号・仕様が載るうえ、`/api/ask` は LLM を呼びます。
そのため画面と API はログインを必須にしています。

- セッションは**署名付き Cookie**（HttpOnly / SameSite=Lax / 既定12時間）。
  中身は GitHub のユーザー識別子だけで、**アクセストークンは保存しません**
- `SPEC_BRIDGE_SESSION_SECRET` が未設定なら、**誰も通しません**（素通しにしない）
- **`middleware.ts` は認証ではありません。** Edge ランタイムからはルートの `.env` を読めず
  署名鍵を持てないため、Cookie の有無だけを見てログイン画面へ振り分けています。
  本当の検証はサーバー側の `currentSession()`（`apps/web/lib/auth.ts`）です。
  **新しい画面や API を足すときは、必ずこれを通してください**

### docs リポジトリに App を入れる場合の無限ループ

生成された PR をマージすると webhook が発火し、docs リポジトリ自身を解析して次の PR を作る、
という連鎖が起こりえます。`isDocsRepoEvent`（`packages/github/src/webhook.ts`）が
`SPEC_BRIDGE_DOCS_REPO` と一致するリポジトリのイベントを捨てることで止めています。

installation トークンで運用する場合、docs リポジトリへの書き込みにも App が必要なので、
**このガードが唯一の防波堤になります。`SPEC_BRIDGE_DOCS_REPO` の綴りを必ず確認してください。**
ガードに頼りたくなければ、docs リポジトリには App を入れず PAT 運用にしてください。

### 認証情報の扱い

| 変数 | 内容 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 未設定なら Claude Code のログイン情報が使われます |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`（または `_PATH`） | 推奨。installation access token に交換して使います。トークンが**インストール先のリポジトリに限定**されます |
| `GITHUB_TOKEN` | PAT 運用（App の設定が無いときのみ使用）。CLI の解析は読み取りのみ（`Pull requests` / `Contents` は Read-only で足ります）。webhook で docs リポジトリへ PR を作る場合は read/write が必要です |
| `GITHUB_WEBHOOK_SECRET` | webhook エンドポイントの**唯一の認証**。未設定なら全リクエストを拒否します |

- `.env` は `.gitignore` で除外されています（`.env.*` によりバックアップも対象）
- **秘密鍵（`.pem`）はリポジトリに置かないでください。** `GITHUB_APP_PRIVATE_KEY_PATH` で
  リポジトリ外の絶対パスを指すか、`GITHUB_APP_PRIVATE_KEY` に入れて `.env` で管理します
- App の資格情報が半端（ID だけ・鍵だけ）な場合は起動時に失敗します。
  **黙って PAT にフォールバックしません** — 意図しない認証で動くほうが危険なためです
- GitHub トークンは**必要最小限の権限**にしてください。Fine-grained PAT では
  `All repositories` ではなく `Only select repositories` を推奨します
- クローン URL にはトークンを埋め込むため、git の失敗メッセージは `maskToken`（`checkout.ts`）で
  伏せてからログに出します

### 生成されたドキュメントを顧客対応に使う前に

自動生成されたドキュメントは `status: draft`（AI生成・未レビュー）です。
**顧客への回答に使う前に、開発者のレビューを通してください。**
CX サポートデスク画面は、draft を根拠にした回答にその旨の警告を付けます。

### 解析対象リポジトリの信頼性

解析対象のリポジトリに含まれるコードやコメントは、エージェントにとって**信頼できない入力**です。
書き込み・ネットワーク系ツールを禁止しているのはこのためですが、
信頼できない第三者のリポジトリを解析する場合は、隔離された環境で実行してください。
