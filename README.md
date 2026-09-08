# Ledgerwalk

Audits your recurring subscriptions from bank/card statements, then (later phases)
drives a browser agent to read each provider's billing page and suggests
open-source alternatives.

**This tool reads billing pages. It never completes a cancellation.** Phase 2 ships
hard guards that block cancel/downgrade/delete controls before they are clicked,
independently of what the model asks for.

## Status

| Phase | What it does | State |
| ----- | ------------ | ----- |
| 1 | Find recurring charges in CSV statement exports | **built** |
| 2 | Browser agent reads each provider's billing page | **built** |
| 3 | Suggest open-source alternatives | not built yet |

## Setup

```bash
npm install
cp .env.example .env    # fill in as later phases need it
```

Node 20+ required.

## Phase 1 — scan statements

Export CSV from your bank or card issuer, drop the files in `statements/`
(gitignored — it holds your financial data), then:

```bash
npm run scan -- --csv ./statements/*.csv
```

Flags: `--db <path>` (default `./ledgerwalk.db`), `--out <path>` (default
`./subscriptions.json`), `--dry-run` (print only, write nothing), `--headed`
(accepted everywhere for consistency; no-op for `scan`).

Column names differ between banks, so headers are matched heuristically — any
casing, single signed `Amount` or split `Debit`/`Credit`, US or European date
ordering (decided per column, not per cell), and an account-summary preamble
above the real header row. Merchant strings are fuzzed onto one grouping key, so
`SPOTIFY*P1A2B3`, `NETFLIX.COM 8667797` and `Notion Labs Inc SAN FRANCISCO CA`
collapse to `SPOTIFY`, `NETFLIX`, `NOTION LABS`.

A charge group is called recurring when it has 3+ charges, priced within 10% of
each other, spaced roughly monthly (28–31d) or annually (360–370d).

Output goes to stdout, to SQLite, and to `subscriptions.json`.

### Review before phase 2

`subscriptions.json` is yours to edit. Set `confirmed: false` on anything that is
not really a subscription, and set `service` to the matching name in
`tasks/services.yaml`. **Re-running `scan` preserves both fields** — it will not
overwrite your edits, and re-scanning overlapping statements is idempotent.

## Phase 2 — audit the billing pages

Describe each service in `tasks/services.yaml`: where to start, what to report,
and where its saved session lives.

### One-time login

```bash
npm run login -- --service Notion
```

A real browser opens. Sign in by hand, then close the window (or press Enter in
the terminal). The session is written to `.auth/notion.json` with owner-only
permissions. `.auth/` is gitignored — those files are bearer credentials.

### Run the agent

```bash
npm run audit -- --service Notion            # one service
npm run audit -- --all --headed              # all of them, watching the browser
npm run audit -- --service Notion --dry-run  # propose one action, execute nothing
```

Needs `ANTHROPIC_API_KEY` in `.env`. Override the model with `LEDGERWALK_MODEL`.

### How the loop works

Each step: read the page, ask the model for exactly one action, run it, repeat —
capped at 25 steps. The model gets a fresh prompt every step containing the goal,
the current page, its last five actions with their outcomes, and the step count.
Nothing accumulates, so cost stays flat across a run.

The page reaches the model as an accessibility-tree outline plus a numbered list
of interactable elements, trimmed to roughly 4000 tokens with anything matching
the goal or sitting in the viewport ranked first. Shadow DOM and iframes are
included. **The model answers with an element id, never a selector** — ids are
resolved to real elements on our side.

Its action space is exactly: `click`, `fill`, `scroll`, `navigate`, `extract`,
`giveUp`. Every action carries a `reason`, which is what makes traces readable.

### Credentials

The model never sees a password. `fill` takes the *name* of a credential
(`NOTION_PASSWORD`), resolved from the environment at the moment of typing; a
literal value in that field is rejected before it reaches the page. Credential
key names come from the service name: `Notion` -> `NOTION_EMAIL`,
`NOTION_PASSWORD`, `NOTION_TOTP_SECRET`.

If a session expires mid-run, the agent re-authenticates **once** using those
values (with a TOTP code if a seed is set) and resumes from where it was. A
second failure ends the task as `AUTH_EXPIRED` rather than retrying into a
lockout.

Everything written to disk passes through a redactor that replaces known secret
values with `[REDACTED]`. A test asserts that a complete trace containing a fill
action — including a simulated error message that quotes the password — has the
secret nowhere in it.

### What the agent is not allowed to do

Checked immediately before execution, independently of the prompt:

| Rule | Blocks |
| ---- | ------ |
| `FORBIDDEN_CONTROL` | anything named like cancel subscription/plan, downgrade, delete or close account |
| `SUBMIT_ON_CANCELLATION_PAGE` | any form submit while the URL looks like a cancellation flow |
| `OFF_ORIGIN_NAVIGATION` | leaving the site the task started on |

A blocked action returns `BLOCKED: <rule>` to the model so it can find another
route. Reaching a cancellation confirmation screenshots the page and stops the
run there. Every block is logged to `blocks.jsonl`.

### Traces

One directory per run: `traces/<service>-<timestamp>/`.

```
meta.json              format version, service, goal, run settings
trace.jsonl            one line per step: observation hash, action, result, latency, tokens
result.json            final status, extracted fields, token totals
step-NN.png            screenshot per step
blocks.jsonl           guard blocks, if any
playwright-trace.zip   npx playwright show-trace <path>
```

`meta.json` documents the step schema inline, so the eval harness can read a
trace directory without importing any of this code.

## Tests

```bash
npm test        # 35 tests: parsing heuristics, credential safety, guards,
                # observation against a live fixture site, and full agent runs
                # driven by a scripted model
npm run typecheck
```

No API key is needed to run the tests: the agent loop is exercised with a
stand-in model against a local fixture site that has a cancel flow, a
shadow-DOM component, an off-screen element and a sign-in page.
