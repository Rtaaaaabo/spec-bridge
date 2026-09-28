# Deploying (Fly.io)

日本語: [deploy.ja.md](deploy.ja.md)

Running it locally is covered in [github-app-setup.md](github-app-setup.md). This page is about running it
**continuously**, which also retires the cloudflared tunnel whose URL changes on every restart.

## Shape

```
one Fly app / two processes
├─ app     the UI (/, /runs, /installations) and the webhook endpoint (/api/webhooks/github)
└─ worker  runs the analyses (long-lived, no HTTP)

Postgres   jobs and per-installation settings
```

**The webhook endpoint lives in the UI process so that one hostname is enough** — Fly cannot route a single
hostname to several processes. Receiving is only "verify the signature and enqueue", so it is cheap; the
worker picks up the expensive part. Signature verification and enqueueing are shared code
(`packages/ingest`), so two entry points still mean one path.

**The UI is not on Vercel** because `/api/ask` uses the Agent SDK, which spawns the Claude Code binary —
that does not work on serverless.

## 0. Prerequisites

```bash
brew install flyctl
fly auth login
```

**This needs billing enabled on Fly** — the free allowance alone will not keep it running. Expect roughly
$10–20/month for the app (1GB) and worker (2GB).

## 1. Create the app

```bash
fly launch --no-deploy --copy-config --name spec-bridge --region nrt
fly config validate    # check fly.toml against your CLI's schema
```

**App names are globally unique on Fly.** If `spec-bridge` is taken, pick another and keep the hostname
consistent in **all three places**: `app` in `fly.toml`, `SPEC_BRIDGE_BASE_URL`, and the GitHub App URLs in
step 5. A mismatch shows up as a webhook that never arrives, a sign-in that never returns, or a cookie
without `Secure`.

`fly launch` may offer to provision Postgres or Redis; decline — the next step covers Postgres.

## 2. Postgres

Fly Postgres or Neon, whichever you prefer; a connection string is all that is needed. The tables (`jobs`,
`installations`) are created at startup.

**`attach` requires the app to exist already** — which is why step 1 comes first.

```bash
fly postgres create --name spec-bridge-db --region nrt
fly postgres attach spec-bridge-db --app spec-bridge   # sets DATABASE_URL
```

> `fly postgres` now warns that it is "unmanaged" and that operations and recovery are your
> responsibility. **That is fine here** — this database holds in-flight jobs and per-installation
> settings, and **the documents themselves live in the docs repository**, so losing it is recoverable.
> If you want a managed one, use `fly mpg` (Managed Postgres); Neon works too. All of them just need to
> hand you a `DATABASE_URL`.

> **These commands change between CLI versions.** If the above does not work, check
> `fly postgres --help` / `fly mpg --help`. All this app needs is a `DATABASE_URL`.

## 3. Secrets

```bash
fly secrets set \
  ANTHROPIC_API_KEY='sk-ant-...' \
  GITHUB_APP_ID='1234567' \
  GITHUB_APP_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' ~/.config/spec-bridge/app.pem)" \
  GITHUB_WEBHOOK_SECRET='...' \
  GITHUB_APP_CLIENT_ID='Iv23li...' \
  GITHUB_APP_CLIENT_SECRET='...' \
  SPEC_BRIDGE_SESSION_SECRET="$(openssl rand -hex 32)" \
  SPEC_BRIDGE_ALLOWED_LOGINS='your-github-login'
```

- **`ANTHROPIC_API_KEY` is required.** There is no Claude Code login inside a container, so this is where
  real spending starts (a large pull request runs $10–15)
- The private key is passed on one line with newlines escaped as `\n` (the `awk` above does that)
- **Without `SPEC_BRIDGE_ALLOWED_LOGINS` nobody can sign in.** Leaving it empty also means nobody can, so
  the failure mode points the safe way

## 4. Deploy

```bash
fly deploy --remote-only   # build on Fly's builders instead of local Docker
fly status
fly logs -a spec-bridge
```

`--remote-only` means you never need Docker Desktop running. To check the build locally first, run
`docker build .` once.

> ⚠️ **Deploying before setting secrets makes the worker fail on startup** (no `DATABASE_URL`; the log
> says so). Do step 3 first.

The worker logs which credential it uses, the default docs repository, the per-PR budget, and the
concurrency.

## 5. Point the GitHub App at the stable URL

| Setting | Value |
| --- | --- |
| Webhook URL | `https://spec-bridge.fly.dev/api/webhooks/github` |
| Callback URL (Identifying and authorizing users) | `https://spec-bridge.fly.dev/api/github/callback` |

Keep `SPEC_BRIDGE_BASE_URL` (in `fly.toml`) on the same host — **the session cookie's `Secure` flag is
derived from it**.

## 6. Verify

```bash
curl https://spec-bridge.fly.dev/api/health          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://spec-bridge.fly.dev/   # 307 to the sign-in page
```

Then merge a small pull request. `fly logs` should show the delivery being enqueued and the worker picking
it up; `/runs` shows progress and cost.

## When something is wrong

| Symptom | Cause |
| --- | --- |
| Worker exits right after starting | No `DATABASE_URL`. Check `fly secrets list` (values are not shown) |
| UI returns 500 | `SPEC_BRIDGE_SESSION_SECRET` or `DATABASE_URL` missing; `fly logs` says which |
| Sign-in bounces back to `/login` | Your account is not in `SPEC_BRIDGE_ALLOWED_LOGINS` |
| "state が一致しません" after authorizing | The App's Callback URL and `SPEC_BRIDGE_BASE_URL` are on different hosts |
| Webhook returns 401 | `GITHUB_WEBHOOK_SECRET` differs from the App's |
| 202 but nothing happens | The worker isn't running. Check `fly status` and `/runs` |
| Analysis fails with "提出先が設定されていません" | Set the docs repository at `/installations`, or set `SPEC_BRIDGE_DOCS_REPO` |
| `fly config validate` errors | Your CLI's schema differs; fix the field it names |

On startup `fly logs` prints the credential type, the default docs repository, the per-PR budget, and the
concurrency — **the fastest way to confirm your settings took effect**.

## Operating it

| | |
| --- | --- |
| Cost | `SPEC_BRIDGE_PR_BUDGET_USD` per pull request, plus an organisation spend limit on the Anthropic side |
| Wall time | Raise `SPEC_BRIDGE_ANALYZE_CONCURRENCY` (same cost, less time). Usage limits get likelier, so raise it gradually |
| Monitoring | `/runs`, the `jobs` table, `fly logs` |
| Backups | Not needed — the documents live in the docs repository |
| Pausing | `fly scale count worker=0`. Queued jobs stay and resume when you scale back up |

**The webhook keeps accepting deliveries while the worker is down** (it only enqueues), so work piles up
rather than being lost.
