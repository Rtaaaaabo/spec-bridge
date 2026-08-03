# spec-bridge

**Turn merged pull requests into feature specs your support and QA teams can actually use — with mandatory source citations.**

日本語版: [README.ja.md](README.ja.md)

AI has made teams ship faster than their support and QA functions can keep up with. The gap shows up as
a steady stream of "is this a bug or is it supposed to work that way?" questions aimed at engineers.

There are plenty of tools that help *developers* understand a codebase. This one is different:
**the reader is not an engineer.**

- **Support** can tell whether a customer report is expected behavior or a real bug, without asking engineering.
- **QA** learns what to test and what this change might have broken.
- **It refuses to answer without evidence.** Claims that can't cite a source never make it into the docs,
  and answers that can't cite a source are forced to "can't determine" by the system — not by the prompt.

## The support desk

Support pastes in a customer inquiry. The answer is grounded only in the generated feature specs.

![Verdict "matches the spec", a customer-ready reply, and three citations with file and line numbers](docs/screenshot.png)

You get a verdict, a reply you can send to the customer as-is, an internal note explaining the reasoning,
**citations down to `file:line`**, and anything worth confirming with engineering. If the underlying doc is
still unreviewed (`draft`), that warning is attached automatically.

### No evidence, no answer

![Verdict "can't determine" with zero citations and no customer-facing reply](docs/screenshot-unknown.png)

For vague inquiries, or topics the docs simply don't cover, it returns **"can't determine" and generates
no customer-facing reply at all**. If the model asserts something without citing a source, the system
overwrites the verdict rather than trusting it.

A support agent relaying a confidently wrong AI answer to a customer is the failure mode this project
is built to prevent.

## Three design decisions

### 1. Documents are per-feature, not per-pull-request

A pull request is a *change*, not a *specification*. A hundred records of "changed payment retry count from 3 to 5"
still won't tell support how payments work.

So **one feature is one durable document, and each PR is applied to it as a patch.** A useful side effect:
you get a timeline of when each rule changed, which is what you need to answer "the customer saw this on March 12."

### 2. Unsourced claims are never written

- `SpecRule.sources` is `min(1)` in the zod schema — a spec item with zero citations cannot exist.
- `mergeAnalysis()` drops any unsourced item before writing and reports it as a warning.
- Generated Markdown carries citations as footnotes (`[^1]`).
- `status` goes `draft` (AI-generated) → `verified` (human-reviewed). Any automated update knocks
  `verified` back down to `draft`.

### 3. Saying "I don't know" is a feature

The agent is instructed not to fill gaps with guesses. Anything it can't determine from the code goes into
`openQuestions`, which the CLI surfaces in its output. Those gaps are the seed for automatically drafting
questions to engineering in a later phase.

## Validation

Run against four repositories in two languages, including three open source projects the author did not write.

| Repository | Pull request | Expected | Result |
| --- | --- | --- | --- |
| formbricks (TS, monorepo) | [#8665](https://github.com/formbricks/formbricks/pull/8665) `feat:` project memberships to SpiceDB | skip | ✅ skipped |
| formbricks | [#8658](https://github.com/formbricks/formbricks/pull/8658) `fix(billing):` trial-to-paid guard | analyze | ✅ 16/16 citations valid |
| documenso (TS) | [#3095](https://github.com/documenso/documenso/pull/3095) `chore:` dependency upgrade | skip | ✅ skipped |
| documenso | [#3109](https://github.com/documenso/documenso/pull/3109) `feat:` rework command search | analyze | ✅ 28/28 citations valid |
| gitea (**Go**) | [#38678](https://github.com/go-gitea/gitea/pull/38678) `fix:` repo home page 500 | analyze | ✅ 35/35 citations valid |

**All 79 citations across the three generated documents were checked mechanically** — every referenced file
existed in the repository and every line number was within the file. No fabricated sources.

Two results are worth calling out:

- **formbricks #8665 was correctly skipped despite being titled `feat:` and touching 27 files.** Its
  description states that PostgreSQL remains the source of truth and that the change "preserves current
  behavior" — it is an internal projection with no user-visible effect. Naive classification would have
  produced a spurious spec document here.
- **Switching to Go did not degrade the output structure.** Screens, endpoints, permissions, and test points
  were all populated, so nothing depends on Next.js-specific conventions.

### Cross-repository validation

Two purpose-built example repositories reproduce the backend/frontend split, so anyone can rerun this:

- [spec-bridge-example-api](https://github.com/Rtaaaaabo/spec-bridge-example-api) — invitation API, roles, seat limits
- [spec-bridge-example-web](https://github.com/Rtaaaaabo/spec-bridge-example-web) — invitation form, role-gated UI

Both carry a `DEMO-1` issue key. Analyzing the API pull request first, then the web one:

| | After the API PR | After the web PR |
| --- | --- | --- |
| Spec items | 10 | **15** (all 10 API-derived items survived, 5 added) |
| Screens | 0 | 1 |
| Endpoints | 3 | 4 |
| Citations | api 23 | **api 29 + web 12** |

The classifier's own reasoning: *"the issue key DEMO-1 matches the existing document `member-invitation`,
so although this pull request is in a different repository (frontend), link it to the same feature."*

**This run found a real bug.** The first attempt deleted all ten API-derived spec items: source verification
was checking every citation against the *currently checked-out* repository, so backend file paths looked
like fabrications from the frontend checkout and were pruned before the merge layer could protect them.
Unit tests never caught it because they only covered single-repository scenarios. Fixed, with regression
tests.

### End-to-end via the GitHub App

The full automated path has been run against a real GitHub App installation:

```
merged PR → webhook → signature check → shallow clone → classify → analyze (confidence 0.96)
          → pull request against the docs repo → clone deleted
```

Result: [docs PR with 610 lines](https://github.com/Rtaaaaabo/docs-specs/pull/1) from a 2-file source PR.
The source pull request deliberately contained specs that are easy to get wrong — all six were captured:
the expiry extension does **not** apply retroactively, resending does **not** extend the expiry, and only
the invitation's creator or an owner may resend.

Two bugs surfaced only during this real run: empty docs repositories could not be initialized (the Git Data
API rejects `createBlob` before the first commit), and analysis results were discarded when publishing
failed. Both are fixed.

### Not yet validated

- Languages other than TypeScript and Go
- Retries. A failed run must be redelivered manually from the GitHub App's Advanced tab (the generated
  documents are preserved under `~/.spec-bridge/failed/` so the analysis is not lost)

## Quick start

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env   # set GITHUB_TOKEN
```

The only required value is `GITHUB_TOKEN` (`Pull requests: Read-only` + `Contents: Read-only`).

### Authentication

Both classification and analysis run through the Claude Agent SDK, so **there is exactly one auth entry
point** (`packages/core/src/agent.ts`).

| `ANTHROPIC_API_KEY` | Behavior |
| --- | --- |
| Unset | Uses your Claude Code login. **No API credits required.** |
| Set | Uses that key. Billed as API usage. |

Leave it unset for local use. When you run this on a server there is no Claude Code login, so the key
becomes mandatory.

### Analyze a pull request

```bash
pnpm analyze \
  --pr https://github.com/acme/backend/pull/482 \
  --repo ~/dev/acme-backend \
  --docs ~/dev/acme-specs
```

`--repo` is a local checkout the agent explores with Read / Grep / Glob. Feature docs are written to
`--docs` as `features/<id>.md`.

| Option | Description |
| --- | --- |
| `--force` | Analyze even when classified as spec-irrelevant |
| `--allow-bash` | Allow the agent to use Bash (e.g. to follow `git log`) |
| `--quiet` | Suppress progress output |

### Run the support desk

```bash
pnpm web
```

| Output | Contents |
| --- | --- |
| Verdict | `matches spec` / `possible bug` / `can't determine` |
| Customer reply | Plain, jargon-free wording you can send as-is (with a copy button) |
| Internal note | Why the verdict was reached |
| Citations | Quotes from the docs plus source file paths |
| Engineering request | Only for bug verdicts. Detailed enough to file directly |
| To confirm | Open questions from the doc, plus a warning if the doc is still `draft` |

## Narrowing as the corpus grows

Putting every document into the prompt stops working as the corpus grows. Instead the index
(id, title, summary, glossary aliases) is consulted first to pick the relevant documents, and only those
are loaded in full.

This kicks in automatically past six documents; below that the extra round trip isn't worth it.

Measured on a 20-document corpus:

| Question | Consulted | Time |
| --- | --- | --- |
| A feature asked about by a customer-facing synonym | **1 of 20** | 40s |
| A topic the docs don't cover at all | **0 of 20** | **5s** |

When nothing is relevant, that is clear from the index alone — so "can't determine" comes back without
reading a single document in full.

No extra infrastructure (no Postgres, no vector store). Past a few hundred documents, consider adding one.

## What gets generated

```markdown
---
id: payment-retry
status: draft
repos: [acme/backend]
updatedAt: 2026-07-28
confidence: 0.9
---

# Payment retry

## Overview / User-visible behavior   ← for support; no jargon
## Screens / Endpoints                ← extracted from routing definitions
## Permissions and roles              ← the most common source of inquiries
## Specification details              ← citations required
## Test points (happy/error/regression/E2E)  ← for QA
## Questions for engineering          ← what couldn't be determined from code
## Change history
## Sources                            ← file:line + PR number
```

A machine-readable JSON block (`<!-- spec-bridge:data ... -->`) is appended to each file. Re-parsing rendered
Markdown is brittle, so subsequent updates read that instead.

Markdown rendering is **deterministic** — identical input always produces identical bytes — so diffs in the
docs repository stay reviewable.

## Automating with a GitHub App

Instead of running the CLI by hand, run a webhook server that reacts to merged pull requests and
**opens a pull request against your docs repository**.

```bash
pnpm webhook
```

```
merged PR → webhook → verify signature → shallow clone → classify → analyze
          → open PR against the docs repo → delete the clone
```

Source code only ever lands in a temporary directory and is deleted after the run. The pull request
against the docs repository *is* the review gate: generated content is `status: draft` until a human
merges it.

Setup (creating the GitHub App, permissions, tunneling to localhost) is documented in
[docs/github-app-setup.md](docs/github-app-setup.md).

## Multiple repositories

When backend and frontend live in separate repositories, **one feature spans several pull requests.**
Two mechanisms hold that together.

### Linking by issue key

Issue keys (`PROJ-123` and similar) are extracted from the branch name, PR title, and body. If an existing
document carries the same key, the PR is **attached to it instead of creating a new one**.

```
acme/backend#42  feature/PROJ-42-retry        → creates payment-retry.md
acme/frontend#88 feature/PROJ-42-retry-badge  → updates the same payment-retry.md ✅
```

This works even when the titles are unrelated ("Payment retry" vs. "Add retry status badge"). Without a key,
it falls back to semantic matching on title and summary.

**This depends on your branching conventions** — put the issue key in the branch name or PR body.

### Protecting what couldn't be verified

An agent analyzing a frontend PR can only read the frontend checkout, so it cannot verify backend-derived
content already in the document.

`mergeAnalysis()` **carries over any record whose sources don't include the current PR's repository,
regardless of what the model returned.** Instructing the prompt not to delete things isn't enough, so this is
enforced in the merge layer.

| Record's source | When analyzing a PR in `acme/backend` |
| --- | --- |
| `acme/backend` | Replaced by the analysis (updates land) |
| `acme/frontend` | **Carried over from the existing doc** and reported as a warning |

### Not yet supported

The analysis agent reads **one repository at a time** (`analyzeFeature` takes a single `repoPath`).
Verifying across frontend and backend simultaneously requires handing the agent multiple checkouts.

## Tools the agent is not given

The Agent SDK's `allowedTools` is an **auto-approval list, not a restriction**. Combined with
`permissionMode: "bypassPermissions"`, every tool passes through. Only `disallowedTools` actually blocks
anything, so `READ_ONLY_DENY_LIST` in `agent.ts` removes these explicitly:

| Tool | Reason |
| --- | --- |
| `Write` / `Edit` / `NotebookEdit` | Never modify the repository being analyzed |
| `WebFetch` / `WebSearch` | Never send source code to an external service |
| `Bash` | Denied by default; allowed only with `--allow-bash` |

The support desk agent gets **no tools at all**, including read-only ones. It can only see the documents it
was handed, so "the model went and read the code and guessed" cannot happen structurally.

See [SECURITY.md](SECURITY.md) for the full security model and reporting process.

## Project layout

```
packages/core/          the analysis pipeline
  types.ts              FeatureDoc schema (zod) — the contract lives here
  agent.ts              thin Claude Agent SDK wrapper; the single auth entry point
  classify.ts           does this PR affect the spec, and which feature? (no tools, fast)
  analyze.ts            explores the repository and generates document content
  merge.ts              merges results into the existing doc; drops unsourced items
  markdown.ts           FeatureDoc ⇄ Markdown, deterministically
  store.ts              reads/writes the docs directory and its index page
  pipeline.ts           wires the above together
  ask.ts                support Q&A: verdict, customer reply, citations
  select-docs.ts        narrows the corpus to the documents a question needs
  confidence.ts         source verification and machine-derived confidence
  pr-body.ts            builds the docs-repo pull request description
packages/github/        PR retrieval, docs-repo PRs, webhook verification, shallow checkout
apps/cli/               command line interface
apps/web/               support desk UI (Next.js)
apps/webhook/           GitHub App webhook receiver (Hono)
```

## Development

```bash
pnpm test        # fast and free — no LLM calls
pnpm typecheck   # core / cli / web
```

Tests cover the parts that **don't depend on model output**: deterministic Markdown rendering, removal of
unsourced claims, and schema coercion. A regression in any of those puts a wrong answer in front of a
customer, so they act as the safety net.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request — it documents the invariants this
project maintains.

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 (current) | PR → feature docs, CLI + support desk UI |
| 1 | GitHub App webhooks, automatic PRs to the docs repository |
| 2 | Filing to issue trackers, feedback loop from unanswered questions |
| 3 | Impact analysis, screen flow diagrams, E2E test generation |
| 4 | Automated screenshots via Playwright |

## Known gaps

- The analysis agent can only read one repository at a time.
- Duplicate detection only normalizes surrounding whitespace. If the model rephrases a rule, the duplicate
  survives and is expected to be caught in review of the docs repository PR.
- Automatic PRs to the docs repository are not implemented; output is written to a local directory.
- No filtering for very large PRs. Diffs are simply truncated at 20,000 characters per file and
  180,000 characters overall.
- If someone hand-edits the generated Markdown and breaks the `spec-bridge:data` block, that file is skipped
  (with a warning).
- The webhook server processes requests in-process with no queue or retry. High PR volume will back up.
- GitHub App installation tokens are not implemented; API calls use a personal access token.
- Reports from stacks other than TypeScript and Go are very welcome — please use the
  "generated document quality" issue template.

## License

[Apache License 2.0](LICENSE)
