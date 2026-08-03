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
    ├─ shallow-clone the analyzed repository into a temp directory
    ├─ classify → analyze (only if the change affects the spec)
    ├─ open a pull request against the docs repository
    └─ delete the clone
    ↓
a human reviews and merges  ← this is the approval gate
```

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
6. After creating it, note the **App ID**
7. From **Install App** in the sidebar, install it on **the repositories you want analyzed — and only
   those**

> ⚠️ **Do not install the App on your docs repository.**
> If you do, merging a generated pull request fires a webhook, which analyzes the docs repository itself
> and opens another pull request — indefinitely. Writes to the docs repository use `GITHUB_TOKEN`, so the
> App is not needed there. (The code guards against this too, but not installing it is the reliable fix.)

> ⚠️ Never commit the webhook secret or a private key. `.gitignore` excludes `.env` and `.env.*`.

### Common errors on the creation form

| Error | Fix |
| --- | --- |
| `Homepage URL must be a valid URL` | Required field. Needs a full URL starting with `https://` — `github.com/...` alone won't pass |
| `Name has already been taken` | App names are **globally unique**. Append your account name |
| `Webhook URL is not a valid URL` | Also needs a full `https://` URL. A placeholder is fine for now |

## 3. Configure environment variables

Add to `spec-bridge/.env`:

```bash
# webhook
GITHUB_WEBHOOK_SECRET=<the secret from step 2>
SPEC_BRIDGE_DOCS_REPO=<your-org>/<your-product>-specs
PORT=3939

# auth (a PAT is fine for now — installation token exchange is not implemented)
GITHUB_TOKEN=<a PAT with Contents and Pull requests at read/write>
```

> **Current limitation**: the App handles webhook delivery and signature verification, but API calls use
> `GITHUB_TOKEN` (a PAT). Exchanging the App ID and private key for an installation access token is not
> implemented. A PAT is sufficient for a single organization; multi-tenant deployments will need the
> exchange.

Note that `GET /repos/...` reports `permissions.push` based on **your** access to the repository, not the
token's granted scopes — so it is not a valid way to check whether a fine-grained PAT can write. If in
doubt, attempt a real write and read the `x-accepted-github-permissions` response header.

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

```bash
pnpm webhook
```

```
spec-bridge webhook listening on http://localhost:3939
  POST /webhooks/github
  docs repository: your-org/your-product-specs
```

If required environment variables are missing, it exits at startup and tells you which ones.

## 6. Verify

```bash
curl http://localhost:3939/health
# {"ok":true,"docsRepo":"your-org/your-product-specs"}
```

Then merge a small pull request in an analyzed repository. You should see:

```
▸ acme/backend#123 feat: ... (8 files)
  fetched 3 existing documents from the docs repository
▸ classifying whether this PR affects the spec…
  → affects the spec: ...
▸ analyzing "..."…
  ✓ pull request opened: https://github.com/your-org/your-product-specs/pull/1
```

Pull requests that don't affect the spec (dependency bumps and similar) are skipped at classification and
produce no pull request.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 responses | `GITHUB_WEBHOOK_SECRET` doesn't match the App's configured secret |
| 202 but no pull request appears | Check the server log. Usually insufficient `GITHUB_TOKEN` permissions |
| `{"ignored":true}` | Anything other than a merged pull request is ignored by design |
| Merging a generated PR produces another PR | The App is installed on the docs repository. Remove it |
| Analysis never starts | Classification skipped it. Check the reason in the log |

The App's **Advanced** tab shows delivered webhooks and lets you **Redeliver** them.

## Not implemented yet

- **Installation token exchange** — a PAT is used instead, as described above
- **No queue.** The process that receives the request performs the analysis. Concurrent merges will back
  up; production use needs something like Trigger.dev
- **No retries.** If a run fails, redeliver it from the App's Advanced tab. Generated documents are
  preserved under `~/.spec-bridge/failed/`, so the analysis itself is not lost
