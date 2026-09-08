#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';

import { openDb, saveAudit, saveSubscriptions } from './db/index.js';
import { detectRecurring, parseStatements } from './stage1/parse-statements.js';
import type { DetectedSubscription } from './stage1/parse-statements.js';
import { DEFAULT_MAX_STEPS, loadServices, runTask } from './stage2/agent.js';
import type { ServiceTask } from './stage2/agent.js';
import { credentialRefs, hasAuthFile, interactiveLogin } from './stage2/auth.js';
import { ModelClient } from './model/client.js';

/* ------------------------------------------------------------- json  shape */

/** One row of the hand-editable review file. */
interface SubscriptionRecord {
  merchant: string;
  normalizedName: string;
  cadence: 'monthly' | 'annual';
  amount: number;
  chargeCount: number;
  firstSeen: string;
  lastSeen: string;
  annualCost: number;
  /** set false to exclude a row from later phases */
  confirmed: boolean;
  /** optional link to a tasks/services.yaml entry, filled in by hand */
  service: string | null;
}

interface SubscriptionFile {
  generatedAt: string;
  note: string;
  subscriptions: SubscriptionRecord[];
}

const REVIEW_NOTE =
  'Edit freely. Set confirmed:false to drop a row from later phases; set "service" ' +
  'to the matching name in tasks/services.yaml. Re-running scan preserves both fields.';

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

/** Carry the user's hand edits across a re-scan. */
function mergeWithExisting(detected: readonly DetectedSubscription[], path: string): SubscriptionFile {
  const previous = new Map<string, SubscriptionRecord>();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubscriptionFile>;
      for (const record of parsed.subscriptions ?? []) {
        if (typeof record.normalizedName === 'string') previous.set(record.normalizedName, record);
      }
    } catch {
      console.warn(`! ${path} is not valid JSON — writing a fresh file`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    note: REVIEW_NOTE,
    subscriptions: detected.map((sub) => {
      const prior = previous.get(sub.normalizedName);
      return {
        merchant: sub.merchant,
        normalizedName: sub.normalizedName,
        cadence: sub.cadence,
        amount: sub.amount,
        chargeCount: sub.chargeCount,
        firstSeen: sub.firstSeen,
        lastSeen: sub.lastSeen,
        annualCost: sub.annualCost,
        confirmed: prior?.confirmed ?? true,
        service: prior?.service ?? null,
      };
    }),
  };
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
    console.log(`\n${detected.length} recurring charge(s); inferred annual spend ${money(total)}\n`);

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

    const file = mergeWithExisting(detected, options.out);
    writeFileSync(options.out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

    console.log(`Wrote ${options.db} and ${options.out}`);
    console.log(`Review ${options.out} and edit it before running phase 2.`);
  });

/* ------------------------------------------------------- phase 2 commands */

const DEFAULT_TASKS = './tasks/services.yaml';

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
