# Build: Subscription Auditor Agent

Build a TypeScript CLI tool that audits my recurring subscriptions using an LLM-driven browser agent, then suggests open-source alternatives.

Work through the phases in order. After each phase, stop and show me what you built plus how to run it. Do not scaffold later phases early.

---

## Stack

- TypeScript, Node 20+, ESM
- Playwright (browser automation, direct — no agent framework)
- `@anthropic-ai/sdk` with tool use for the agent loop
- `better-sqlite3` for storage
- `otplib` for TOTP
- `dotenv` for secrets
- `commander` for CLI, `csv-parse` for stage 1

Do not add LangChain, browser-use, Stagehand, or any agent framework. The loop is mine to own.

---

## Repo layout

```
src/
  cli.ts
  stage1/parse-statements.ts     # CSV -> recurring charges
  stage2/
    agent.ts                     # the loop
    actions.ts                   # action schema + executor
    observe.ts                   # page -> model-readable state
    guards.ts                    # forbidden actions
    auth.ts                      # storageState + TOTP
  stage3/alternatives.ts         # OSS suggestions
  db/schema.sql
  trace/logger.ts
tasks/services.yaml              # per-site config
.auth/                           # gitignored, storageState JSON
traces/                          # gitignored
```

First commit must include a `.gitignore` containing `.auth/`, `traces/`, `.env`, `*.db`. Do this before writing anything else — those files are bearer credentials.

---

## Phase 1 — Find the charges

`npm run scan -- --csv ./statements/*.csv`

Parse bank/card CSV exports. Column names vary between banks, so normalize with a small header-mapping heuristic (look for date / description / amount in any casing, handle debit-credit split columns).

Detect recurring charges: group by fuzzy-normalized merchant string (strip trailing store numbers, city names, `*` prefixes like `SPOTIFY*P1A2B3`), then flag any group with 3+ charges at roughly monthly (28-31d) or annual (360-370d) spacing, amounts within 10% of each other.

Output a table to stdout and write to SQLite. Include: merchant, normalized name, cadence, amount, count, first seen, last seen, inferred annual cost.

Let me confirm/edit the list before phase 2 runs — write it to `subscriptions.json` that I can hand-edit.

---

## Phase 2 — The agent

This is the core. Take your time here.

### Task input

`tasks/services.yaml`:

```yaml
- name: Notion
  url: https://www.notion.so/
  goal: >
    Find the workspace billing settings. Report the current plan name,
    the amount billed, the billing cadence, and the next renewal date.
  authFile: .auth/notion.json
```

### The loop

```
observe page -> ask model for one action -> execute -> repeat
```

Cap at 25 steps. Each iteration sends the model: the goal, a compact page representation, the last 5 actions with their outcomes, and the step count.

**Page representation:** use Playwright's ARIA snapshot (`page.locator('body').ariaSnapshot()`) as the default. Assign each interactable element a stable integer ID and present the model with a numbered list — the model returns an ID, never a CSS selector. Selectors are resolved in my code, not the model's. Truncate to ~4000 tokens, prioritizing elements in the viewport and anything whose accessible name matches goal keywords.

**Action space** (as Anthropic tool-use tools, one call per step):

- `click(elementId, reason)`
- `fill(elementId, valueRef, reason)` — `valueRef` is a key like `NOTION_PASSWORD`, never a literal. The executor resolves it from env at fill time.
- `scroll(direction)`
- `navigate(url, reason)` — same-origin only
- `extract(fields, reason)` — returns structured JSON, ends the task
- `giveUp(reason)`

Every action requires a `reason` string. It costs a few tokens and it makes traces readable.

### Auth

Login is manual and one-time: `npm run login -- --service notion` opens a headed browser, I log in by hand, and on close it saves `storageState` to `.auth/notion.json`. Runs load that state.

Handle mid-run session expiry: if the agent lands on a login page during a task, attempt one re-auth using env credentials plus `otplib` for TOTP if a seed is present, then resume the task from the current step rather than restarting. If re-auth fails, fail the task with reason `AUTH_EXPIRED` — do not loop.

### Credential safety — non-negotiable

Passwords and TOTP seeds must never appear in a prompt, a model response, or a trace file. The model emits `valueRef` keys only. The trace logger runs every string through a redactor that replaces any known secret value with `[REDACTED]` before writing to disk. Add a unit test that asserts a full trace containing a fill action does not contain the secret.

### Guards

A pre-execution check that hard-blocks actions before they run, independent of the prompt:

- Any element whose accessible name matches `/cancel (subscription|plan)|delete account|close account|downgrade|confirm cancel/i`
- Any form submit on a page whose URL matches `/cancel|close|delete/`
- Navigation off-origin

Blocked actions return a tool result of `BLOCKED: <rule>` so the model can adapt. The agent may walk up to a cancel confirmation to observe it, and must screenshot and stop there. Log every block.

### Traces

Per task, write `traces/<service>-<timestamp>/`: a `trace.jsonl` with one line per step (observation hash, action, result, latency, tokens), a screenshot per step, and the final extraction. This directory is the input format for the eval harness later, so keep it stable and self-describing.

Also enable Playwright's own tracing (`context.tracing.start`) so I get Trace Viewer for free.

---

## Phase 3 — Alternatives

For each audited subscription, one Claude call: given service name, plan tier, and annual cost, return open-source or free alternatives.

Return JSON: `{ alternative, repoUrl, license, selfHostRequired, migrationEffort, annualSavings, featuresLost, confidence }`.

Instruct it to return `null` with a reason for categories where no real alternative exists — content licensing, physical logistics, regulated services, network-effect products. Give it two few-shot examples, one substitutable (Notion) and one not (Amazon Prime), so refusal is a modeled behavior rather than an instruction it can drift from.

If `repoUrl` is present, hit the GitHub API for stars and last commit date; flag anything untouched for 18+ months. Skip verification silently if rate-limited — this column is allowed to be imperfect.

---

## Output

`npm run report` renders a markdown table: service, annual cost, alternative, license, self-host, migration effort, savings, features lost. Total annual spend and total plausible savings at the top. Link each row to its trace directory.

---

## Constraints

- Strict TypeScript, no `any` in the action or trace types
- Every model call wrapped with retry on 429/500 and a token counter
- `--headed` and `--dry-run` flags on every command
- README with setup, the one-time login step, and an explicit note that this tool reads billing pages and never completes a cancellation