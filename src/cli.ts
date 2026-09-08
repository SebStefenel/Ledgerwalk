#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { existsSync, globSync } from 'node:fs';

import { latestAudit, openDb, saveAlternative, saveAudit, saveSubscriptions } from './db/index.js';
import { detectRecurring, parseStatements } from './stage1/parse-statements.js';
import { mergeEmailFindings, mergeWithExisting, writeReviewFile } from './stage1/review-file.js';
import { fetchFromImap, imapOptionsFromEnv, looksLikeReceipt, readFromDirectory } from './stage1/mailbox.js';
import type { EmailMessage } from './stage1/mailbox.js';
import { annualCostOf, dedupeSubscriptions, extractSubscriptions } from './stage1/receipts.js';
import { DEFAULT_MAX_STEPS, loadServices, runTask } from './stage2/agent.js';
import type { ServiceTask } from './stage2/agent.js';
import { credentialRefs, hasAuthFile, interactiveLogin } from './stage2/auth.js';
import { ModelClient } from './model/client.js';
import { renderRequest, suggestAlternative } from './stage3/alternatives.js';
import { loadConfirmed, serviceNameFor } from './stage1/review-file.js';
import { buildRows, renderReport } from './report.js';
import { writeFileSync } from 'node:fs';

/* ---------------------------------------------------------------- helpers */

function expandPaths(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    // The shell usually expands these; handle the quoted case ourselves.
    if (/[*?[\]]/.test(pattern)) out.push(...globSync(pattern).sort());
    else out.push(pattern);
  }
  return [...new Set(out)];
}

function money(value: number): string {
  return value.toFixed(2);
}

function renderTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const width: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      width[index] = Math.max(width[index] ?? 0, cell.length);
    });
  }
  // Right-align every column except the first two (merchant, normalized name).
  const line = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index < 2 ? cell.padEnd(width[index] ?? 0) : cell.padStart(width[index] ?? 0)))
      .join('  ')
      .trimEnd();

  const header = rows[0];
  if (header === undefined) return '';
  const divider = width.map((w) => '-'.repeat(w)).join('  ');
  return [line(header), divider, ...rows.slice(1).map(line)].join('\n');
}

/* -------------------------------------------------------------------- cli */

const program = new Command();

program
  .name('ledgerwalk')
  .description('Audit recurring subscriptions from statements, then look for open-source alternatives.')
  .version('0.1.0');

program
  .command('scan')
  .description('Phase 1 — find recurring charges in bank/card CSV exports')
  .requiredOption('--csv <paths...>', 'CSV statement files (globs allowed)')
  .option('--db <path>', 'SQLite database path', './ledgerwalk.db')
  .option('--out <path>', 'hand-editable review file', './subscriptions.json')
  .option('--headed', 'no-op for scan; accepted so every command takes the same flags', false)
  .option('--dry-run', 'print results without writing the database or the review file', false)
  .action((options: { csv: string[]; db: string; out: string; headed: boolean; dryRun: boolean }) => {
    const paths = expandPaths(options.csv);
    const missing = paths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      console.error(`No such file(s): ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (paths.length === 0) {
      console.error('No statement files matched.');
      process.exitCode = 1;
      return;
    }

    console.log(`Reading ${paths.length} statement file(s)...`);
    const { charges, warnings } = parseStatements(paths);
    for (const warning of warnings) console.warn(`! ${warning.file}: ${warning.message}`);
    console.log(`Parsed ${charges.length} outgoing charge(s).`);

    const detected = detectRecurring(charges);
    if (detected.length === 0) {
      console.log('No recurring charges detected.');
      return;
    }

    const table: string[][] = [
      ['MERCHANT', 'NORMALIZED', 'CADENCE', 'AMOUNT', 'N', 'FIRST SEEN', 'LAST SEEN', 'ANNUAL'],
      ...detected.map((sub) => [
        sub.merchant,
        sub.normalizedName,
        sub.cadence,
        money(sub.amount),
        String(sub.chargeCount),
        sub.firstSeen,
        sub.lastSeen,
        money(sub.annualCost),
      ]),
    ];
    console.log(`\n${renderTable(table)}`);

    const total = detected.reduce((sum, sub) => sum + sub.annualCost, 0);
    console.log(`\n${detected.length} recurring charge(s); inferred annual spend ${money(total)}`);

    // AMOUNT above is the current price. Say so when it has not always been.
    const changed = detected.filter((sub) => sub.previousAmount !== null);
    if (changed.length > 0) {
      console.log('\nPrice changes:');
      for (const sub of changed) {
        const previous = sub.previousAmount ?? 0;
        const direction = previous < sub.amount ? 'rose' : 'fell';
        console.log(
          `  ${sub.normalizedName}: ${direction} from ${money(previous)} to ${money(sub.amount)} ` +
            `on ${sub.priceChangedOn ?? 'an unknown date'}`,
        );
      }
    }
    console.log('');

    if (options.dryRun) {
      console.log('--dry-run: nothing written.');
      return;
    }

    const db = openDb(options.db);
    try {
      saveSubscriptions(db, detected);
    } finally {
      db.close();
    }

    writeReviewFile(options.out, mergeWithExisting(detected, options.out));

    console.log(`Wrote ${options.db} and ${options.out}`);
    console.log(`Review ${options.out} and edit it before running phase 2.`);
  });

const DEFAULT_TASKS = './tasks/services.yaml';
const DEFAULT_SUBSCRIPTIONS = './subscriptions.json';

/* ------------------------------------------------- phase 1b: email receipts */

function monthsAgo(count: number): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - count);
  return date;
}

program
  .command('inbox')
  .description('Phase 1 (alternative) — find subscriptions from billing emails')
  .option('--dir <path>', 'read exported .eml files from a folder instead of connecting to IMAP')
  .option('--mailbox <name>', 'IMAP folder to search', 'INBOX')
  .option('--since <date>', 'only look at mail on or after this date (yyyy-mm-dd)')
  .option('--limit <n>', 'maximum bodies to download and read', '200')
  .option('--out <path>', 'hand-editable review file', DEFAULT_SUBSCRIPTIONS)
  .option('--headed', 'no-op here; accepted so every command takes the same flags', false)
  .option('--dry-run', 'list the candidate emails without calling the model or writing anything', false)
  .action(
    async (options: {
      dir?: string;
      mailbox: string;
      since?: string;
      limit: string;
      out: string;
      dryRun: boolean;
    }) => {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

      const since = options.since === undefined ? monthsAgo(12) : new Date(`${options.since}T00:00:00Z`);
      if (Number.isNaN(since.getTime())) throw new Error('--since must be a date like 2025-01-31');

      let messages: readonly EmailMessage[];
      if (options.dir !== undefined) {
        const read = await readFromDirectory(options.dir);
        for (const warning of read.warnings) console.warn(`! ${warning.source}: ${warning.message}`);
        messages = read.messages;
        console.log(`Read ${messages.length} message(s) from ${options.dir}.`);
      } else {
        console.log(`Connecting to IMAP, searching ${options.mailbox} since ${since.toISOString().slice(0, 10)}...`);
        const fetched = await fetchFromImap(imapOptionsFromEnv({ mailbox: options.mailbox, since, limit }));
        for (const warning of fetched.warnings) console.warn(`! ${warning.source}: ${warning.message}`);
        messages = fetched.messages;
        console.log(`Scanned ${fetched.scanned} message(s); downloaded ${messages.length} candidate(s).`);
      }

      // The .eml path has not been through the server-side date filter or the
      // subject filter, so both are applied here; for IMAP this is a safety net.
      // Newest first, so --limit keeps the most recent mail rather than whatever
      // happened to sort first.
      const sinceDay = since.toISOString().slice(0, 10);
      const candidates = messages
        .filter((message) => message.date >= sinceDay)
        .filter((message) => looksLikeReceipt(message.subject, message.from))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);

      if (candidates.length === 0) {
        console.log('No candidate receipt emails found.');
        return;
      }

      if (options.dryRun) {
        console.log(`\n${candidates.length} candidate email(s); nothing sent to the model:\n`);
        for (const message of candidates) {
          console.log(`  ${message.date}  ${message.from.slice(0, 40).padEnd(40)}  ${message.subject}`);
        }
        console.log('\n--dry-run: nothing written.');
        return;
      }

      const model = new ModelClient();
      console.log(`Reading ${candidates.length} candidate email(s)...`);
      const extracted = await extractSubscriptions({
        messages: candidates,
        model,
        onProgress: (done, total, found) => {
          process.stdout.write(`\r  ${done}/${total} read, ${found} subscription line(s) found`);
        },
      });
      process.stdout.write('\n');
      for (const warning of extracted.warnings) console.warn(`! ${warning.source}: ${warning.message}`);

      const found = dedupeSubscriptions(extracted.subscriptions);
      console.log(
        `${extracted.receipts} of ${candidates.length} were real receipts; ` +
          `${found.length} distinct subscription(s).\n`,
      );

      if (found.length === 0) {
        console.log('Nothing to write.');
        return;
      }

      const rows: string[][] = [
        ['SERVICE', 'PLAN', 'AMOUNT', 'CADENCE', 'ANNUAL', 'NEXT RENEWAL', 'SEEN'],
        ...found.map((item) => [
          item.vendor,
          item.planTier ?? '—',
          `${item.currency ?? ''}${item.amount.toFixed(2)}`.trim(),
          item.isTrial ? `${item.cadence} (trial)` : item.cadence,
          annualCostOf(item.amount, item.cadence).toFixed(2),
          item.nextRenewal ?? '—',
          item.seenOn,
        ]),
      ];
      console.log(renderTable(rows));

      const trials = found.filter((item) => item.isTrial);
      if (trials.length > 0) {
        console.log(`\n${trials.length} trial(s) that will start charging:`);
        for (const trial of trials) {
          console.log(
            `  ${trial.vendor} — ${trial.amount.toFixed(2)} ${trial.cadence} from ` +
              `${trial.trialEndsOn ?? trial.nextRenewal ?? 'an unstated date'}`,
          );
        }
      }

      console.log(
        `\nModel usage: ${model.tokens.input} in / ${model.tokens.output} out over ${model.calls} call(s).`,
      );

      writeReviewFile(options.out, mergeEmailFindings(found, options.out));
      console.log(`Wrote ${options.out} (statement-detected rows and your edits are preserved).`);
    },
  );

/* ------------------------------------------------------- phase 2 commands */


function selectTasks(tasks: readonly ServiceTask[], service: string | undefined, all: boolean): ServiceTask[] {
  if (all) return [...tasks];
  if (service === undefined) {
    throw new Error('pass --service <name>, or --all to audit every service in the tasks file');
  }
  const wanted = service.toLowerCase();
  const matched = tasks.filter((task) => task.name.toLowerCase() === wanted);
  if (matched.length === 0) {
    throw new Error(`no service named "${service}" in the tasks file (have: ${tasks.map((t) => t.name).join(', ')})`);
  }
  return matched;
}

program
  .command('login')
  .description('Phase 2 — sign in by hand once and save the browser session')
  .option('--service <name>', 'service name as it appears in the tasks file')
  .option('--all', 'log in to every service in turn', false)
  .option('--tasks <path>', 'services file', DEFAULT_TASKS)
  .option('--headed', 'accepted for consistency; login is always headed', true)
  .option('--dry-run', 'say what would happen without opening a browser', false)
  .action(async (options: { service?: string; all: boolean; tasks: string; dryRun: boolean }) => {
    const tasks = selectTasks(loadServices(options.tasks), options.service, options.all);
    for (const task of tasks) {
      const { saved, path } = await interactiveLogin({
        service: task.name,
        url: task.url,
        authFile: task.authFile,
        dryRun: options.dryRun,
      });
      if (saved) console.log(`Saved ${task.name} session to ${path} (owner-only).`);
    }
  });

program
  .command('audit')
  .description('Phase 2 — drive a browser agent over each billing page')
  .option('--service <name>', 'service name as it appears in the tasks file')
  .option('--all', 'audit every service in the tasks file', false)
  .option('--tasks <path>', 'services file', DEFAULT_TASKS)
  .option('--db <path>', 'SQLite database path', './ledgerwalk.db')
  .option('--max-steps <n>', 'step cap per task', String(DEFAULT_MAX_STEPS))
  .option('--headed', 'watch the browser work', false)
  .option('--dry-run', 'observe the first page, print the action the model proposes, execute nothing', false)
  .action(
    async (options: {
      service?: string;
      all: boolean;
      tasks: string;
      db: string;
      maxSteps: string;
      headed: boolean;
      dryRun: boolean;
    }) => {
      const tasks = selectTasks(loadServices(options.tasks), options.service, options.all);
      const maxSteps = Number.parseInt(options.maxSteps, 10);
      if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps must be a positive integer');

      const missingAuth = tasks.filter((task) => !hasAuthFile(task.authFile));
      for (const task of missingAuth) {
        console.warn(
          `! no saved session for ${task.name} (${task.authFile}) — ` +
            `run: npm run login -- --service ${task.name}`,
        );
      }

      const model = new ModelClient();
      const db = openDb(options.db);
      try {
        for (const task of tasks) {
          console.log(`\n=== ${task.name} — ${task.url}`);
          const { result, traceDir } = await runTask({
            task,
            model,
            headed: options.headed,
            dryRun: options.dryRun,
            maxSteps,
          });

          if (!options.dryRun) saveAudit(db, result, traceDir);

          console.log(`  status: ${result.status} (${result.reason})`);
          if (result.fields !== null) {
            for (const [key, value] of Object.entries(result.fields)) console.log(`    ${key}: ${value}`);
          }
          if (result.status === 'auth_expired') {
            const refs = credentialRefs(task.name);
            console.log(
              `    set ${refs.emailRef} / ${refs.passwordRef} in .env for automatic re-auth, ` +
                `or run: npm run login -- --service ${task.name}`,
            );
          }
          console.log(`  trace: ${traceDir}`);
        }
      } finally {
        db.close();
      }
      console.log(
        `\nTotal model usage: ${model.tokens.input} in / ${model.tokens.output} out over ${model.calls} call(s).`,
      );
    },
  );

/* ------------------------------------------------------- phase 3 commands */

program
  .command('alternatives')
  .description('Phase 3 — ask Claude for an open-source alternative to each subscription')
  .option('--subscriptions <path>', 'hand-edited review file', DEFAULT_SUBSCRIPTIONS)
  .option('--db <path>', 'SQLite database path', './ledgerwalk.db')
  .option('--service <name>', 'only this service')
  .option('--no-github', 'skip the GitHub stars / last-commit lookup')
  .option('--headed', 'no-op here; accepted so every command takes the same flags', false)
  .option('--dry-run', 'print what would be asked, call nothing, write nothing', false)
  .action(
    async (options: {
      subscriptions: string;
      db: string;
      service?: string;
      github: boolean;
      dryRun: boolean;
    }) => {
      const confirmed = loadConfirmed(options.subscriptions);
      if (confirmed.length === 0) {
        console.log(`No confirmed subscriptions in ${options.subscriptions}.`);
        return;
      }

      const wanted = options.service?.toLowerCase();
      const db = openDb(options.db);
      try {
        const rows = confirmed.filter(
          (record) => wanted === undefined || serviceNameFor(record).toLowerCase() === wanted,
        );
        if (rows.length === 0) throw new Error(`no confirmed subscription named "${options.service ?? ''}"`);

        // A model is only constructed when one is actually needed, so --dry-run
        // works without an API key.
        const model = options.dryRun ? null : new ModelClient();

        for (const record of rows) {
          const service = serviceNameFor(record);
          const audit = latestAudit(db, service);
          const planTier = audit?.fields?.['plan'] ?? null;
          const input = { service, planTier, annualCost: record.annualCost };

          if (model === null) {
            console.log(`\n--- would ask about ${service} ---`);
            console.log(renderRequest(input));
            continue;
          }

          process.stdout.write(`${service}... `);
          const parsed = await suggestAlternative({
            input,
            model,
            verifyRepo: options.github,
          });

          if (!parsed.ok) {
            console.log(`failed: ${parsed.error}`);
            continue;
          }

          const suggestion = parsed.suggestion;
          if (suggestion.kind === 'none') {
            console.log(`no real alternative (${suggestion.category.replace(/_/g, ' ')})`);
            saveAlternative(db, {
              service,
              normalizedName: record.normalizedName,
              annualCost: record.annualCost,
              alternative: null,
              reason: suggestion.reason,
              noAlternativeCategory: suggestion.category,
              repoUrl: null,
              license: null,
              selfHostRequired: null,
              migrationEffort: null,
              annualSavings: null,
              featuresLost: [],
              confidence: suggestion.confidence,
              repoStars: null,
              repoLastCommit: null,
              repoStale: null,
            });
            continue;
          }

          const value = suggestion.value;
          const stale = value.repoHealth?.stale === true ? ' (unmaintained)' : '';
          console.log(`${value.alternative}${stale}, saves ${value.annualSavings.toFixed(2)}`);
          saveAlternative(db, {
            service,
            normalizedName: record.normalizedName,
            annualCost: record.annualCost,
            alternative: value.alternative,
            reason: value.reason,
            noAlternativeCategory: null,
            repoUrl: value.repoUrl,
            license: value.license,
            selfHostRequired: value.selfHostRequired,
            migrationEffort: value.migrationEffort,
            annualSavings: value.annualSavings,
            featuresLost: value.featuresLost,
            confidence: value.confidence,
            repoStars: value.repoHealth?.stars ?? null,
            repoLastCommit: value.repoHealth?.lastCommit ?? null,
            repoStale: value.repoHealth?.stale ?? null,
          });
        }

        if (model !== null) {
          console.log(
            `\nModel usage: ${model.tokens.input} in / ${model.tokens.output} out over ${model.calls} call(s).`,
          );
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command('report')
  .description('Render the audit as a markdown table')
  .option('--subscriptions <path>', 'hand-edited review file', DEFAULT_SUBSCRIPTIONS)
  .option('--db <path>', 'SQLite database path', './ledgerwalk.db')
  .option('--out <path>', 'also write the markdown to a file')
  .option('--headed', 'no-op here; accepted so every command takes the same flags', false)
  .option('--dry-run', 'print the report without writing --out', false)
  .action((options: { subscriptions: string; db: string; out?: string; dryRun: boolean }) => {
    const db = openDb(options.db);
    let markdown: string;
    try {
      markdown = renderReport(buildRows(db, options.subscriptions));
    } finally {
      db.close();
    }

    console.log(markdown);

    if (options.out !== undefined && !options.dryRun) {
      writeFileSync(options.out, `${markdown}\n`, 'utf8');
      console.error(`\nWrote ${options.out}`);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
