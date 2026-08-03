# Contributing

日本語版: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)

## Development setup

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env
```

| Command | What it does |
| --- | --- |
| `pnpm test` | Tests — no LLM calls, so they're fast and free |
| `pnpm typecheck` | Type checking across core / cli / web |
| `pnpm analyze --pr <PR> --repo <path> --docs <path>` | Analyze a single pull request |
| `pnpm web` | The support desk UI |
| `pnpm webhook` | The GitHub App webhook server |

## Invariants this project maintains

Please check these before opening a pull request. **They are the specification, not implementation
details.**

### 1. Nothing unsourced is ever written

A support agent relaying a confidently wrong AI answer to a customer is the failure this project exists
to prevent.

- `SpecRule.sources` is `min(1)` — a spec item with zero citations cannot exist in the schema.
- `mergeAnalysis()` drops violations before anything is written.
- `pruneInvalidSources()` removes citations pointing at files that don't exist, and drops any spec item
  left with none.
- `askSupportQuestion()` rewrites a `spec` / `bug` verdict to `unknown` when the answer cites no sources.

**Enforce this in the logic layer, not in the UI.** A rendering mistake must never be able to leak a
wrong answer.

### 2. Don't break the ability to say "I don't know"

The prompts instruct the agent not to fill gaps with guesses. If you change a prompt, verify that
`openQuestions` still gets populated and that `verdict: "unknown"` still comes back for questions the
documents can't answer.

### 3. Markdown rendering stays deterministic

Identical input must always produce identical bytes. Once diffs in the docs repository become noisy,
human review stops working — and human review is the approval gate for everything this tool generates.
`markdown.test.ts` guards this.

### 4. The analysis agent gets no write or network tools

The Agent SDK's `allowedTools` is an **auto-approval list, not a restriction**. The only thing that
actually blocks a tool is `disallowedTools` (see `READ_ONLY_DENY_LIST` in
[`packages/core/src/agent.ts`](packages/core/src/agent.ts)).

Loosening this would allow the repository under analysis to be modified, or customer source code to be
sent to an external service. Treat any such change as a security change.

### 5. Citations from other repositories are never pruned

One feature can span several repositories. An agent analyzing the frontend cannot verify backend file
paths, so those citations must be left alone rather than treated as fabrications.

This was a real regression: source verification ran against the currently checked-out repository only,
which silently deleted backend-derived content. Regression tests live in `confidence.test.ts`.

## Testing policy

Tests cover the parts that **don't depend on model output**: deterministic Markdown rendering, merge
behavior, schema coercion, source verification, webhook signature checks.

There are no tests that call an LLM — they would be non-deterministic and would cost money on every CI
run.

**If you loosen the schema to absorb a new shape of model output, add a case to `types.test.ts`.**
What shapes are accepted is effectively this project's contract.

## Issues and pull requests

- For bug reports, include the generated document or CLI output. Redact anything confidential.
- For prompt changes, include a before/after diff of a generated document.
- Reports from stacks other than TypeScript and Go are especially welcome — see the "generated document
  quality" issue template.

## Security

Please don't report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md).
