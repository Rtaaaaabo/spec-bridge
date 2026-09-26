# GitHub App setup

日本語版: [github-app-setup.ja.md](github-app-setup.ja.md)

This walks through the automated path: a merged pull request updates your feature documents and **opens a
pull request against your docs repository**, with no CLI invocation.

## How it works

```
a pull request is merged
    ↓ webhook
spec-bridge webhook server
    ├─ verify the signature (the only authentication)
    └─ enqueue one job and return 202 (the same merge is never enqueued twice)
    ↓
spec-bridge worker (separate process)
    ├─ claim one job
    ├─ resolve credentials per repository (App: exchange for an installation token)
    ├─ shallow-clone the analyzed repository into a temp directory
    ├─ classify → analyze (only if the change affects the spec)
    ├─ open a pull request against the docs repository
    └─ delete the clone
    ↓
a human reviews and merges  ← this is the approval gate
```

**Receiving and running are separate.** Analysis takes minutes; running it in the receiving process
means work is lost on restart and concurrent merges queue up behind each other.

**Source code only ever lands in a temp directory and is deleted afterwards.**

## 1. Create a docs repository

This is where generated documents are submitted. **Keep it private** — documents contain internal file
paths, line numbers, and specifications.

```bash
gh repo create <your-org>/<your-product>-specs --private
```

It can be completely empty. **A repository with no commits at all works** — the first run creates an
initial commit and opens the pull request on top of it.

## 2. Create the GitHub App

These steps require a browser.

1. Open https://github.com/settings/apps/new
2. Fill in:

   | Field | Value |
   | --- | --- |
   | GitHub App name | Anything (e.g. `spec-bridge-<your-org>`). Must be **globally unique across GitHub** |
   | Homepage URL | **Required.** A full URL starting with `https://`. Your own repository URL is fine |
   | Webhook URL | Not known yet — put `https://example.com/webhooks/github` for now and **replace it in step 4** once the tunnel is up |
   | Webhook secret | **Generate a strong random string and save it** (e.g. `openssl rand -hex 32`) |

3. Repository permissions:

   | Permission | Level | Used for |
   | --- | --- | --- |
   | Contents | **Read and write** | Reading the analyzed repo, committing to the docs repo |
   | Pull requests | **Read and write** | Reading PR diffs, opening the docs PR |
   | Metadata | Read-only | Added automatically |

4. Under "Subscribe to events", check **Pull request**
5. "Where can this GitHub App be installed?" — "Only on this account" is enough
6. After creating it:
   - note the **App ID**
   - click **Generate a private key** and download the `.pem`
7. From **Install App** in the sidebar, install it on **the repositories you want analyzed**. If you run
   with installation tokens (the recommended setup in step 3), install it on **the docs repository too** —
   writes to the docs repository use that token as well

> ⚠️ **With the App installed on the docs repository, the loop protection is the code guard alone.**
> Merging a generated pull request fires a webhook that could analyze the docs repository itself and open
> another pull request. `isDocsRepoEvent` (`packages/github/src/webhook.ts`) stops it by dropping events
> from the repository named in `SPEC_BRIDGE_DOCS_REPO`.
> **Make sure `SPEC_BRIDGE_DOCS_REPO` matches your docs repository exactly** (case and surrounding
> whitespace are ignored). If you would rather not rely on that guard, leave the App off the docs
> repository and use the PAT setup in step 3.

> ⚠️ Never commit the webhook secret or a private key. `.gitignore` excludes `.env` and `.env.*`.

### Common errors on the creation form

| Error | Fix |
| --- | --- |
| `Homepage URL must be a valid URL` | Required field. Needs a full URL starting with `https://` — `github.com/...` alone won't pass |
| `Name has already been taken` | App names are **globally unique**. Append your account name |
| `Webhook URL is not a valid URL` | Also needs a full `https://` URL. A placeholder is fine for now |

## 3. Configure environment variables

Add to `spec-bridge/.env`. API calls authenticate either with **GitHub App installation tokens
(recommended)** or with a **PAT**.

```bash
# webhook
GITHUB_WEBHOOK_SECRET=<the secret from step 2>
SPEC_BRIDGE_DOCS_REPO=<your-org>/<your-product>-specs
PORT=3939

# auth (recommended): exchange the App ID + private key for installation access tokens
GITHUB_APP_ID=<the App ID from step 2>
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/your-app.private-key.pem

# or pass the key inline, with newlines escaped as \n
# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# auth (fallback): a single PAT. Used only when no App credentials are configured
# GITHUB_TOKEN=<a PAT with Contents and Pull requests at read/write>
```

Compared with a PAT, installation tokens mean:

- the token is **scoped to the repositories the App is installed on** (a PAT carries your own access)
- pull requests in the docs repository are **authored by the App itself** (`app/<slug>`) rather than by the
  token's owner — the provenance is visible at a glance, and nobody ends up approving their own pull request
- rate limits are **5,000/hour per installation** (one PAT shares a single budget)
- the analyzed repository and the docs repository get **separate tokens** — which is why
  `fetchPullRequest` and `publishDocsAsPullRequest` take credentials as a required argument

> ⚠️ Setting `GITHUB_APP_ID` without a private key (or the reverse) **fails at startup**. It never falls
> back to the PAT silently — "I configured the App but it was really running on the PAT" is the failure
> you cannot see.

Note that `GET /repos/...` reports `permissions.push` based on **your** access to the repository, not the
token's granted scopes — so it is not a valid way to check whether a fine-grained PAT can write. If in
doubt, attempt a real write and read the `x-accepted-github-permissions` response header.

### Check the credentials first

Before opening a tunnel and merging a pull request, verify the credentials on their own. **This calls no
LLM, so it is free.**

```bash
pnpm check-auth --repo-name <org/repo to analyze> --clone
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

It checks four things:

- that the App ID and private key belong together (the JWT is accepted)
- which accounts the App is installed on, and whether Contents / Pull requests are at **write**
- that the docs repository and the analyzed repository are reachable **with the credential actually used**
- with `--clone`, that the token can also perform a shallow git clone (discarded immediately)

> ⚠️ When a credential lacks access to a private repository, GitHub returns **404** — indistinguishable
> from "no such repository". If you see a 404, check the fine-grained PAT's selected repositories, or where
> the App is installed.

## 3.5 Set up sign-in for the web UI (optional)

`apps/web` (the support desk and the installations page) **requires sign-in**. It uses the GitHub App's
user-to-server OAuth, so no second app is needed.

1. In the App settings (General), set the **Callback URL**:

   ```
   http://localhost:3000/api/github/callback
   ```

2. Copy the **Client ID** from the same page and click **Generate a new client secret**
3. Add to `.env`:

   ```bash
   SPEC_BRIDGE_SESSION_SECRET=<output of openssl rand -hex 32>
   GITHUB_APP_CLIENT_ID=<client id>
   GITHUB_APP_CLIENT_SECRET=<client secret>
   # if the UI is served somewhere other than localhost
   # SPEC_BRIDGE_BASE_URL=https://specs.example.com
   ```

4. Run `pnpm web` and open http://localhost:3000/ (you land on `/login` when signed out)

> ⚠️ With `SPEC_BRIDGE_SESSION_SECRET` unset, the UI lets **nobody** in rather than everybody: a session
> that cannot be verified is a session anyone could forge.

The session cookie carries only the GitHub user identity — **the access token is never stored**.

## 4. Make localhost reachable

GitHub cannot reach your machine directly, so open a tunnel.

```bash
# for example, with cloudflared
cloudflared tunnel --url http://localhost:3939
```

The printed `https://....trycloudflare.com` plus `/webhooks/github` is your real webhook URL.

```
https://xxxx-yyyy.trycloudflare.com/webhooks/github
```

**Go back to the App settings and replace the placeholder Webhook URL with this**
(App settings → General → Webhook → Webhook URL).

`smee.io` and `ngrok` work too.

> ⚠️ The URL from `cloudflared tunnel --url` **changes every time you start it**. Update the Webhook URL
> each time you restart the tunnel. For a stable URL, use `smee.io` or a named cloudflared tunnel.

## 5. Start the server

Jobs live in Postgres. Add the connection string to `.env`:

```bash
DATABASE_URL=postgres://user@localhost:5432/spec_bridge
```

The table is created on startup (`packages/jobs/src/schema.sql`).

Run the two processes:

```bash
pnpm webhook   # receive and enqueue
pnpm worker    # run the queued jobs
```

For local use, `SPEC_BRIDGE_INLINE_WORKER=1 pnpm webhook` runs both in one process.

> ⚠️ Without `DATABASE_URL`, jobs are kept in memory: they are lost on restart and never reach a separate
> `pnpm worker` process. The startup log warns about this.

```
ジョブの置き場所: Postgres
spec-bridge webhook listening on http://localhost:3939
  POST /webhooks/github
  docs repository: your-org/your-product-specs
  GitHub auth: GitHub App (installation token)
  ジョブの実行は別プロセスです: pnpm worker
```

If required environment variables are missing, it exits at startup and tells you which ones. **The last
line tells you which credential is in use** (a PAT shows as `PAT (GITHUB_TOKEN)`).

## 6. Verify

```bash
curl http://localhost:3939/health
# {"ok":true,"docsRepo":"your-org/your-product-specs"}
```

Then merge a small pull request in an analyzed repository. The webhook only acknowledges it:

```
[webhook] acme/backend#123 → ジョブを積みました: 3f7c...
```

The work itself shows up in the worker's log:

```
▸ analyze.pr analyze.pr:acme/backend#123:9fbe…（1 回目）
▸ acme/backend#123 feat: ... (8 files)
  docs repository credentials checked (app)
  fetched 3 existing documents from the docs repository
▸ classifying whether this PR affects the spec…
  → affects the spec: ...
▸ analyzing "..."…
  ✓ pull request opened: https://github.com/your-org/your-product-specs/pull/1
  ✓ 完了
```

The queue is also just a table:

```sql
select kind, state, attempts, left(last_error, 80), created_at from jobs order by created_at desc;
```

Pull requests that don't affect the spec (dependency bumps and similar) are skipped at classification and
produce no pull request.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 responses | `GITHUB_WEBHOOK_SECRET` doesn't match the App's configured secret |
| 202 but no pull request appears | Check the server log. Usually missing permissions (Contents / Pull requests not at read/write) |
| Log says `GitHub App が <repo> にインストールされていません` ("the App is not installed on \<repo\>") | The App isn't installed on that repository — the docs repository needs it too (step 2.7) |
| Startup says `秘密鍵がありません` ("no private key") | Only `GITHUB_APP_ID` is set. Provide the private key, or drop the App settings and use a PAT |
| `{"ignored":true}` | Anything other than a merged pull request is ignored by design |
| `{"duplicate":true}` | A job for that merge already exists — redeliveries cannot produce a second pull request |
| 202 but nothing happens | `pnpm worker` isn't running. Check for rows left `queued` in `jobs` |
| Jobs pile up as `queued` | The worker died. Expired leases are reclaimed the next time it starts |
| Merging a generated PR produces another PR | `SPEC_BRIDGE_DOCS_REPO` doesn't match the docs repository, so the loop guard can't match it |
| Analysis never starts | Classification skipped it. Check the reason in the log |

The App's **Advanced** tab shows delivered webhooks and lets you **Redeliver** them.

## Not implemented yet

- **One job at a time.** A worker processes a single job per process. To go wider, start several
  `pnpm worker` processes — they don't contend for the same row
- **A single tenant.** `SPEC_BRIDGE_DOCS_REPO` is the only "tenant configuration", and every job carries
  `tenant_id = local`
