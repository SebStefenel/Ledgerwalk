import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Redactor, TraceLogger } from '../src/trace/logger.js';
import { VALUE_REF_PATTERN, parseToolUse } from '../src/stage2/actions.js';

const PASSWORD = 'c0rrect-horse-battery-staple!';
const TOTP_SEED = 'JBSWY3DPEHPK3PXPQQ';
const API_KEY = 'sk-ant-api03-not-a-real-key-0123456789';

function traceEnv(): NodeJS.ProcessEnv {
  return {
    NOTION_EMAIL: 'auditor@example.com',
    NOTION_PASSWORD: PASSWORD,
    NOTION_TOTP_SECRET: TOTP_SEED,
    ANTHROPIC_API_KEY: API_KEY,
    PATH: '/usr/bin',
  };
}

/**
 * The requirement from the spec: a complete trace of a run that includes a fill
 * action must not contain the secret anywhere on disk.
 */
test('a full trace containing a fill action never contains the secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledgerwalk-trace-'));
  const redactor = Redactor.fromEnvironment(traceEnv());

  const logger = TraceLogger.create({
    service: 'Notion',
    goal: 'Report the plan, amount, cadence and next renewal date.',
    url: 'https://www.notion.so/',
    maxSteps: 25,
    dryRun: false,
    redactor,
    root,
  });

  logger.step({
    step: 1,
    timestamp: new Date().toISOString(),
    url: 'https://www.notion.so/login',
    observationHash: 'abc123def4567890',
    action: { kind: 'fill', elementId: 4, valueRef: 'NOTION_PASSWORD', reason: 'sign in to reach billing' },
    parseError: null,
    result: { ok: true, message: 'filled element 4 from NOTION_PASSWORD', blockedBy: null },
    latencyMs: 812,
    tokens: { input: 3200, output: 96 },
    screenshot: 'step-01.png',
  });

  // The adversarial case: some future code path, or a Playwright error, quotes
  // the value it tried to type. The redactor is the thing that has to catch it.
  logger.step({
    step: 2,
    timestamp: new Date().toISOString(),
    url: 'https://www.notion.so/login',
    observationHash: 'abc123def4567890',
    action: { kind: 'click', elementId: 7, reason: 'submit the login form' },
    parseError: null,
    result: {
      ok: false,
      message: `TimeoutError: locator.fill("${PASSWORD}") timed out; totp seed ${TOTP_SEED}`,
      blockedBy: null,
    },
    latencyMs: 10_004,
    tokens: { input: 3300, output: 88 },
    screenshot: 'step-02.png',
  });

  logger.blocked(3, 'FORBIDDEN_CONTROL', {
    kind: 'click',
    elementId: 9,
    reason: `try cancelling with ${PASSWORD}`,
  });

  logger.finish({
    service: 'Notion',
    goal: 'Report the plan, amount, cadence and next renewal date.',
    status: 'extracted',
    fields: { plan: 'Team', amount: '$96.00', cadence: 'yearly', nextRenewal: '2026-03-01' },
    reason: `signed in as auditor@example.com using ${PASSWORD}`,
    steps: 3,
    tokens: { input: 6500, output: 184 },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  const files = readdirSync(logger.dir);
  assert.ok(files.includes('trace.jsonl'), 'trace.jsonl was written');
  assert.ok(files.includes('result.json'), 'result.json was written');
  assert.ok(files.includes('meta.json'), 'meta.json was written');
  assert.ok(files.includes('blocks.jsonl'), 'blocks.jsonl was written');

  for (const file of files) {
    const contents = readFileSync(join(logger.dir, file), 'utf8');
    assert.ok(!contents.includes(PASSWORD), `${file} must not contain the password`);
    assert.ok(!contents.includes(TOTP_SEED), `${file} must not contain the TOTP seed`);
    assert.ok(!contents.includes(API_KEY), `${file} must not contain the API key`);
  }

  const trace = readFileSync(join(logger.dir, 'trace.jsonl'), 'utf8');
  assert.ok(trace.includes('[REDACTED]'), 'the secret was redacted, not merely absent');
  assert.ok(trace.includes('NOTION_PASSWORD'), 'the key name stays, so traces remain readable');
  assert.ok(trace.includes('step-01.png'), 'screenshots are still referenced');

  const result = readFileSync(join(logger.dir, 'result.json'), 'utf8');
  assert.ok(result.includes('2026-03-01'), 'extracted billing fields survive redaction');
});

test('redaction is case-insensitive and leaves short strings alone', () => {
  const redactor = new Redactor();
  redactor.add('SuperSecret123');
  redactor.add('ab'); // too short to redact safely

  assert.equal(redactor.string('token=supersecret123 end'), 'token=[REDACTED] end');
  assert.equal(redactor.string('nothing to see'), 'nothing to see');
  assert.equal(redactor.string('ab ab ab'), 'ab ab ab', 'two-character values are not redacted');
});

test('redaction reaches into nested objects, arrays and keys', () => {
  const redactor = new Redactor();
  redactor.add('hunter2000');

  const redacted = redactor.value({
    outer: { inner: ['safe', 'value hunter2000 here'] },
    hunter2000: 'used as a key',
    count: 7,
    ok: true,
    missing: null,
  });

  assert.deepEqual(redacted, {
    outer: { inner: ['safe', 'value [REDACTED] here'] },
    '[REDACTED]': 'used as a key',
    count: 7,
    ok: true,
    missing: null,
  });
});

test('the model cannot smuggle a literal secret through valueRef', () => {
  const rejected = parseToolUse('fill', {
    elementId: 4,
    valueRef: PASSWORD,
    reason: 'type the password',
  });

  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(!rejected.error.includes(PASSWORD), 'the rejected literal is never echoed back');
  assert.match(rejected.error, /REJECTED/);

  const accepted = parseToolUse('fill', {
    elementId: 4,
    valueRef: 'NOTION_PASSWORD',
    reason: 'type the password',
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.deepEqual(accepted.action, {
    kind: 'fill',
    elementId: 4,
    valueRef: 'NOTION_PASSWORD',
    reason: 'type the password',
  });
});

test('valueRef pattern accepts env key names and rejects values', () => {
  for (const good of ['NOTION_PASSWORD', 'GITHUB_TOTP_SECRET', 'ACME2_EMAIL']) {
    assert.ok(VALUE_REF_PATTERN.test(good), `${good} should be accepted`);
  }
  for (const bad of ['hunter2', 'my password', 'Notion_Password', 'sk-ant-123', 'AB', '']) {
    assert.ok(!VALUE_REF_PATTERN.test(bad), `${bad} should be rejected`);
  }
});
