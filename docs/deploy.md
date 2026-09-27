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

## 1. Postgres

Fly Postgres or Neon, whichever you prefer; a connection string is all that is needed. The tables (`jobs`,
`installations`) are created at startup.

```bash
fly postgres create --name spec-bridge-db --region nrt
fly postgres attach spec-bridge-db --app spec-bridge   # sets DATABASE_URL
```

**Losing this database is recoverable.** The documents live in the docs repository on GitHub; this holds
in-flight jobs and per-installation settings only.

## 2. Create the app

```bash
fly launch --no-deploy --copy-config --name spec-bridge --region nrt
```

The `fly.toml` in the repository works as is — change the `app` name to yours.

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
fly deploy
fly status
fly logs -a spec-bridge
```

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
