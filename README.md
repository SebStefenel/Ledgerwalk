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
| 1b | Find subscriptions in billing emails (alternative source) | **built** |
| 2 | Browser agent reads each provider's billing page | **built** |
| 3 | Suggest open-source alternatives, render the report | **built** |

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

## Phase 1b — read billing emails

An alternative to statements, and a better one for some subscriptions. Statements
have three blind spots that no amount of parsing can fix:

- **Bundled billers.** `APPLE.COM/BILL 19.97` is four subscriptions on one line.
  A statement cannot tell you which. The receipt itemises every one.
- **Trials.** A free trial that converts next month is invisible in a statement
  until it takes your money. The email announcing it arrives weeks earlier.
- **Plan tier and renewal date.** A bank line has neither.

```bash
npm run inbox                                   # IMAP, last 12 months
npm run inbox -- --since 2026-01-01 --limit 400
npm run inbox -- --dir ./exported-emails        # read .eml files, no credentials
npm run inbox -- --dry-run                      # list candidates, call nothing
```

### Getting at the mail

Either connect over IMAP — set `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD` in
`.env` (for Gmail, an app password with 2-step verification on) — or skip
credentials entirely and drag messages out of your mail client into a folder,
then pass `--dir`.

### How it filters

Three stages, cheapest first, because reading a whole mailbox with a model would
be absurdly expensive:

1. **IMAP search** narrows to the date range server-side.
2. **Envelopes only** are downloaded and matched against subject and sender
   patterns. Bodies are fetched only for what survives — on a year of ordinary
   mail that is a couple of hundred messages rather than all of them.
3. **The model** reads those and decides what is actually a receipt.

Stage 2 deliberately over-includes; a newsletter from `noreply@` gets through and
is rejected at stage 3. Missing a real receipt would be the worse error.

### What it extracts

One model call per candidate email, four at a time, returning every recurring
item in that email — with the plan tier, per-item price, cadence, renewal date
and whether it is still a trial. One-off purchases sitting on the same receipt
are excluded. Both behaviours are taught with worked examples rather than only
described, the same way phase 3 teaches refusal.

Twelve monthly receipts for one service collapse to a single row, keeping the
newest — so a price rise shows the current price, not last January's.

### Privacy

Email bodies are sent to the model, so anything that looks like a card number is
stripped before they leave the machine, and bodies are truncated to 4000
characters. Everything else in a receipt does travel: read
[mailbox.ts](src/stage1/mailbox.ts) before pointing this at a sensitive mailbox.

### Both sources together

`scan` and `inbox` write to the same `subscriptions.json` and **neither deletes
the other's rows**. Where both find the same service, the statement keeps
authority over the money — it is what actually left your account — and the
receipt adds what a bank line cannot know: plan tier, currency, renewal date,
trial status. Your `confirmed` and `service` edits survive both.

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

## Phase 3 — alternatives and the report

```bash
npm run alternatives                      # one Claude call per subscription
npm run alternatives -- --service Notion  # just one
npm run alternatives -- --dry-run         # print the prompts, call nothing
npm run report                            # markdown to stdout
npm run report -- --out report.md         # and to a file
```

One call per confirmed subscription, given its name, the plan tier phase 2 read
from the billing page, and the annual cost from phase 1.

**Refusal is the point.** Some categories have no open-source substitute — a
licensed streaming catalogue, physical delivery, a regulated service, anything
whose value is that other people are already on it. The model returns `null` with
a category and a reason for those. That behaviour is taught with two worked
examples sent as real tool calls, one substitutable (Notion) and one not (Amazon
Prime), rather than only described in the instructions — an instruction alone is
easier to drift away from than a demonstrated pattern.

Suggested savings are clamped to what you actually pay, so the total at the top
of the report cannot be inflated by an over-enthusiastic estimate.

When a suggestion has a GitHub repo, its stars and last commit date are looked
up and anything untouched for 18+ months is flagged as unmaintained. This column
is allowed to be imperfect: rate limits and errors are skipped silently. Set
`GITHUB_TOKEN` for a higher rate limit, or pass `--no-github` to skip it.

### The report

`npm run report` renders total annual spend and total plausible savings, then a
row per subscription: service, annual cost, alternative, license, self-host,
migration effort, savings, features lost. Each service links to the trace
directory for its audit run, and the reasoning behind every suggestion —
including every refusal — is listed underneath.

`report` only reads the database, so it costs nothing to re-render.

## Which name a service goes by

Phase 1 normalises `NETFLIX.COM 8667797` to `NETFLIX`, and that cleaned name is
what phases 2 and 3 use. To override it — to match a `tasks/services.yaml` entry,
or just to get the capitalisation right — set `service` on the row in
`subscriptions.json`. That value wins over everything else.

## Tests

```bash
npm test        # 66 tests: parsing heuristics, credential safety, guards,
                # observation against a live fixture site, full agent runs
                # driven by a scripted model, alternative parsing and refusal,
                # repo health, report rendering, and email receipt reading
                # against .eml fixtures including a bundled Apple receipt
npm run typecheck
```

No API key is needed to run the tests: the agent loop is exercised with a
stand-in model against a local fixture site that has a cancel flow, a
shadow-DOM component, an off-screen element and a sign-in page.
