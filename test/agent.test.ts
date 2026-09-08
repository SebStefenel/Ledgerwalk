import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask } from '../src/stage2/agent.js';
import type { ServiceTask } from '../src/stage2/agent.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { startFixtureSite } from './fixtures/site.js';
import type { Fixture } from './fixtures/site.js';

let site: Fixture;

before(async () => {
  site = await startFixtureSite();
});

after(async () => {
  await site.close();
});

function task(origin: string): ServiceTask {
  return {
    name: 'Acme',
    url: `${origin}/billing`,
    goal: 'Report the plan name, the amount billed, the cadence and the next renewal date.',
    authFile: join(tmpdir(), 'ledgerwalk-no-such-auth.json'),
  };
}

function readTrace(dir: string): Readonly<Record<string, unknown>>[] {
  return readFileSync(join(dir, 'trace.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
}

test('a full run navigates, extracts, and writes a complete trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-run-'));
  // Element ids are assigned in document order: 0 Settings, 1 Billing, 2 Help,
  // 3 password, 4 Downgrade, 5 Cancel subscription, ...
  const model = new ScriptedModel([
    { tool: 'scroll', input: { direction: 'down', reason: 'look for billing details' } },
    { tool: 'navigate', input: { url: '/settings', reason: 'open settings' } },
    { tool: 'navigate', input: { url: '/billing', reason: 'back to billing' } },
    {
      tool: 'extract',
      input: {
        fields: { plan: 'Team', amount: '$96.00', cadence: 'yearly', nextRenewal: '2026-03-01' },
        reason: 'the billing page shows every field the goal asked for',
      },
    },
  ]);

  const { result, traceDir } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'extracted');
  assert.equal(result.steps, 4);
  assert.deepEqual(result.fields, {
    plan: 'Team',
    amount: '$96.00',
    cadence: 'yearly',
    nextRenewal: '2026-03-01',
  });
  assert.equal(result.tokens.input, 400, 'token usage accumulates across the run');

  const files = readdirSync(traceDir);
  for (const expected of ['meta.json', 'trace.jsonl', 'result.json', 'playwright-trace.zip']) {
    assert.ok(files.includes(expected), `${expected} written`);
  }
  for (const step of [1, 2, 3, 4]) {
    assert.ok(files.includes(`step-0${step}.png`), `screenshot for step ${step}`);
  }

  const steps = readTrace(traceDir);
  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((step) => step['step']),
    [1, 2, 3, 4],
  );
  const second = steps[1];
  assert.ok(second !== undefined);
  assert.deepEqual(second['action'], { kind: 'navigate', url: '/settings', reason: 'open settings' });
  assert.equal(typeof second['observationHash'], 'string');
  assert.equal(typeof second['latencyMs'], 'number');

  // The eval harness reads this directory without importing our code.
  const meta = JSON.parse(readFileSync(join(traceDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(meta['format'], 'ledgerwalk-trace');
  assert.equal(meta['version'], 1);
  assert.equal(meta['service'], 'Acme');
  assert.ok(typeof meta['stepSchema'] === 'object', 'the format documents itself');
});

test('each prompt carries the goal, the step count and only the last five actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-window-'));
  const scroll = { tool: 'scroll', input: { direction: 'down', reason: 'keep looking' } };
  const model = new ScriptedModel([
    scroll, scroll, scroll, scroll, scroll, scroll,
    { tool: 'giveUp', input: { reason: 'billing details are not on this page' } },
  ]);

  const { result } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'gave_up');
  assert.equal(result.steps, 7);

  const first = model.prompts[0];
  assert.ok(first !== undefined);
  assert.match(first, /GOAL: Report the plan name/);
  assert.match(first, /STEP 1 of 25/);
  assert.match(first, /nothing yet/);
  assert.match(first, /INTERACTABLE ELEMENTS/);

  const seventh = model.prompts[6];
  assert.ok(seventh !== undefined);
  assert.match(seventh, /STEP 7 of 25/);
  const listed = [...seventh.matchAll(/^ {2}#(\d+) /gm)].map((match) => Number(match[1]));
  assert.deepEqual(listed, [2, 3, 4, 5, 6], 'exactly the last five actions, oldest first');
});

test('a run stops at a cancellation control and records the block', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-block-'));
  const model = new ScriptedModel([
    { tool: 'click', input: { elementId: 5, reason: 'see the cancellation terms' } },
  ]);

  const { result, traceDir } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'stopped_at_cancel');
  assert.match(result.reason, /BLOCKED: FORBIDDEN_CONTROL/);
  assert.equal(result.steps, 1);

  assert.ok(existsSync(join(traceDir, 'blocks.jsonl')), 'the block is logged separately');
  const block = JSON.parse(readFileSync(join(traceDir, 'blocks.jsonl'), 'utf8').trim()) as Record<string, unknown>;
  assert.equal(block['rule'], 'FORBIDDEN_CONTROL');
  assert.equal(block['step'], 1);

  const steps = readTrace(traceDir);
  const only = steps[0];
  assert.ok(only !== undefined);
  const outcome = only['result'] as Record<string, unknown>;
  assert.equal(outcome['blockedBy'], 'FORBIDDEN_CONTROL');
  assert.equal(only['screenshot'], 'step-01.png', 'the spec requires a screenshot at the stopping point');
  assert.ok(existsSync(join(traceDir, 'step-01.png')));
});

test('an off-origin navigation is refused but the run carries on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-offsite-'));
  const model = new ScriptedModel([
    { tool: 'navigate', input: { url: 'https://example.com/help', reason: 'read the help centre' } },
    { tool: 'giveUp', input: { reason: 'cannot leave the site' } },
  ]);

  const { result, traceDir } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'gave_up', 'a block is not fatal; the agent gets to adapt');
  const steps = readTrace(traceDir);
  const first = steps[0];
  assert.ok(first !== undefined);
  const outcome = first['result'] as Record<string, unknown>;
  assert.equal(outcome['blockedBy'], 'OFF_ORIGIN_NAVIGATION');
  assert.match(String(outcome['message']), /^BLOCKED: OFF_ORIGIN_NAVIGATION/);

  // The model is told why, so it can choose differently next step.
  const second = model.prompts[1];
  assert.ok(second !== undefined);
  assert.match(second, /BLOCKED: OFF_ORIGIN_NAVIGATION/);
});

test('a malformed tool call is reported back rather than crashing the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-bad-'));
  const model = new ScriptedModel([
    { tool: 'click', input: { reason: 'missing the element id' } },
    { tool: 'fill', input: { elementId: 3, valueRef: 'literal-password', reason: 'sign in' } },
    { tool: 'giveUp', input: { reason: 'done experimenting' } },
  ]);

  const { result, traceDir } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'gave_up');
  const steps = readTrace(traceDir);
  assert.match(String(steps[0]?.['parseError']), /elementId/);
  assert.match(String(steps[1]?.['parseError']), /REJECTED/);

  const traceText = readFileSync(join(traceDir, 'trace.jsonl'), 'utf8');
  assert.ok(!traceText.includes('literal-password'), 'the rejected literal never reaches the trace');
});

test('dry run proposes one action, executes nothing, and writes no audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-dry-'));
  const model = new ScriptedModel([
    { tool: 'navigate', input: { url: '/settings', reason: 'open settings' } },
  ]);

  const { result, traceDir } = await runTask({
    task: task(site.origin),
    model,
    headed: false,
    dryRun: true,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'dry_run');
  assert.equal(result.steps, 1);
  const steps = readTrace(traceDir);
  assert.match(String((steps[0]?.['result'] as Record<string, unknown>)['message']), /^DRY RUN: would navigate/);

  const meta = JSON.parse(readFileSync(join(traceDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(meta['dryRun'], true);
});

test('an expired session with no stored credentials fails as AUTH_EXPIRED, once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-auth-'));
  const model = new ScriptedModel([{ tool: 'giveUp', input: { reason: 'never reached' } }]);

  const { result, traceDir } = await runTask({
    task: { ...task(site.origin), url: `${site.origin}/account/session` },
    model,
    headed: false,
    dryRun: false,
    maxSteps: 25,
    traceRoot: root,
  });

  assert.equal(result.status, 'auth_expired');
  assert.match(result.reason, /AUTH_EXPIRED/);
  assert.match(result.reason, /ACME_EMAIL|ACME_PASSWORD/, 'the message names the keys to configure');
  assert.deepEqual(model.prompts, [], 'the model is never asked to drive a login page');

  const steps = readTrace(traceDir);
  assert.equal(steps.length, 1, 're-auth is attempted exactly once, never in a loop');
  assert.equal(steps[0]?.['action'], null);
});
