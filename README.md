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
| 2 | Browser agent reads each provider's billing page | not built yet |
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

## Tests

```bash
npm test        # heuristics, against two synthetic bank exports in test/fixtures
npm run typecheck
```
