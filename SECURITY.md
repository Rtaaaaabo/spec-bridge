# Security Policy

日本語版: [SECURITY.ja.md](SECURITY.ja.md)

spec-bridge handles **both source code and API credentials**. Please read this before deploying it.

## Reporting a vulnerability

Do not open a public issue. Report privately through
[GitHub Security Advisories](https://github.com/Rtaaaaabo/spec-bridge/security/advisories/new).

Target for a first response is 7 days. This is maintained by one person, so no SLA is guaranteed.

## Supported versions

Only the latest `main`. No backward compatibility is promised during 0.x.

## Design-level defenses

### The analysis agent runs with tools removed

The Claude Agent SDK's `allowedTools` specifies **which tools are auto-approved — it is not a
restriction**. Combined with `permissionMode: "bypassPermissions"`, every tool passes through.

The only mechanism that actually blocks a tool is `disallowedTools`
(`READ_ONLY_DENY_LIST` in [`packages/core/src/agent.ts`](packages/core/src/agent.ts)).

| Tool | Why it's denied |
| --- | --- |
| `Write` / `Edit` / `NotebookEdit` | Never modify the repository being analyzed |
| `WebFetch` / `WebSearch` | Never send source code to an external service |
| `Bash` | Denied by default; allowed only with an explicit `--allow-bash` |

**Treat any loosening of this list as a security change.**

### Source code is never persisted

Analysis reads a local checkout (or a shallow clone into a temp directory when running from the webhook
server) and deletes it afterwards — including when the run fails. Only the generated feature documents
are kept.

### The support desk agent has no tools at all

The question-answering agent is given no tools, not even read-only ones. It can only see the documents
handed to it, so "the model went and read the code and guessed" cannot happen structurally.

## What operators need to know

### Where generated documents end up

**Generated documents contain source file paths, line numbers, and internal specifications.** That is
intentional — they are the citations.

If your docs repository is public, your internal structure is readable by anyone. **Keep the docs
repository private.**

### Do not install the GitHub App on the docs repository

If you do, merging a generated pull request fires a webhook, which analyzes the docs repository itself
and opens another pull request — repeating indefinitely.

Writes to the docs repository use `GITHUB_TOKEN`, so the App does not need to be installed there. The
code also guards against this, but not installing it is the reliable fix.

### Credentials

| Variable | Notes |
| --- | --- |
| `ANTHROPIC_API_KEY` | If unset, the Claude Code login is used |
| `GITHUB_TOKEN` | Needs `Contents` and `Pull requests` at **Read and write** for the webhook flow |
| `GITHUB_WEBHOOK_SECRET` | Signature verification is the **only** authentication on the webhook endpoint |

- `.env` is excluded by `.gitignore` (the `.env.*` pattern also covers backups).
- Scope the GitHub token to the minimum. With fine-grained PATs, prefer `Only select repositories` over
  `All repositories`.
- If `GITHUB_WEBHOOK_SECRET` is unset, the webhook endpoint rejects **every** request rather than
  accepting unsigned ones.

### Review before using generated documents with customers

Generated documents carry `status: draft` (AI-generated, unreviewed). **Have an engineer review them
before support uses them to answer customers.** The support desk attaches a warning to any answer whose
sources are still `draft`.

### Repositories you analyze are untrusted input

Code and comments in the repository under analysis are untrusted input to the agent. Denying write and
network tools is the mitigation, but if you analyze repositories from third parties you don't trust, run
it in an isolated environment.
