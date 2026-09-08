import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { executeAction } from '../src/stage2/actions.js';
import { CANCELLATION_URL, FORBIDDEN_CONTROL, blockedMessage, checkAction } from '../src/stage2/guards.js';
import { goalKeywords, observe } from '../src/stage2/observe.js';
import type { ObservedElement } from '../src/stage2/observe.js';
import { credentialRefs, envPrefix, looksLikeLogin } from '../src/stage2/auth.js';
import { startFixtureSite } from './fixtures/site.js';
import type { Fixture } from './fixtures/site.js';

const GOAL = 'Find the billing settings and report the plan, amount, cadence and next renewal date.';

let site: Fixture;
let browser: Browser;
let page: Page;

before(async () => {
  site = await startFixtureSite();
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
  await site.close();
});

function element(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    id: 1,
    role: 'button',
    name: 'Billing',
    tag: 'button',
    type: null,
    filled: false,
    disabled: false,
    inViewport: true,
    isSubmit: false,
    inForm: false,
    isPassword: false,
    ...overrides,
  };
}

/* --------------------------------------------------------------- guards */

test('guards block destructive controls by accessible name', () => {
  for (const name of [
    'Cancel subscription',
    'Cancel plan',
    'Cancel membership',
    'Delete account',
    'Close account',
    'Downgrade to Free',
    'Confirm cancel',
  ]) {
    const verdict = checkAction(
      { kind: 'click', elementId: 1, reason: 'look at the plan' },
      { currentUrl: 'https://acme.test/billing', origin: 'https://acme.test', element: element({ name }) },
    );
    assert.equal(verdict.allowed, false, `"${name}" must be blocked`);
    if (verdict.allowed) return;
    assert.equal(verdict.rule, 'FORBIDDEN_CONTROL');
    assert.equal(verdict.halt, true, 'reaching a destructive control stops the run');
    assert.match(blockedMessage(verdict), /^BLOCKED: FORBIDDEN_CONTROL/);
  }
});

test('guards allow ordinary read-only navigation', () => {
  for (const name of ['Billing', 'Settings', 'View invoices', 'Plans', 'Manage cancellation policy PDF']) {
    const verdict = checkAction(
      { kind: 'click', elementId: 1, reason: 'read the plan' },
      { currentUrl: 'https://acme.test/settings', origin: 'https://acme.test', element: element({ name }) },
    );
    assert.equal(verdict.allowed, true, `"${name}" should be allowed`);
  }
});

test('guards block any form submit inside a cancellation flow', () => {
  // Deliberately a name the first rule does not match: the URL rule is the backstop.
  const verdict = checkAction(
    { kind: 'click', elementId: 3, reason: 'see what happens' },
    {
      currentUrl: 'https://acme.test/cancel-plan',
      origin: 'https://acme.test',
      element: element({ name: 'Yes, end my billing', isSubmit: true, inForm: true }),
    },
  );
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.rule, 'SUBMIT_ON_CANCELLATION_PAGE');
  assert.equal(verdict.halt, true, 'the run screenshots and stops at the confirmation');

  // The same click on an ordinary page is fine.
  const allowed = checkAction(
    { kind: 'click', elementId: 3, reason: 'apply a filter' },
    {
      currentUrl: 'https://acme.test/billing',
      origin: 'https://acme.test',
      element: element({ name: 'Apply', isSubmit: true, inForm: true }),
    },
  );
  assert.equal(allowed.allowed, true);
});

test('guards keep navigation on the task origin', () => {
  const ctx = { currentUrl: 'https://acme.test/billing', origin: 'https://acme.test', element: null };

  const offsite = checkAction({ kind: 'navigate', url: 'https://evil.test/steal', reason: 'look' }, ctx);
  assert.equal(offsite.allowed, false);
  if (!offsite.allowed) assert.equal(offsite.rule, 'OFF_ORIGIN_NAVIGATION');

  const otherScheme = checkAction({ kind: 'navigate', url: 'http://acme.test/billing', reason: 'look' }, ctx);
  assert.equal(otherScheme.allowed, false, 'http is a different origin from https');

  assert.equal(checkAction({ kind: 'navigate', url: '/settings', reason: 'look' }, ctx).allowed, true);
  assert.equal(
    checkAction({ kind: 'navigate', url: 'https://acme.test/plans', reason: 'look' }, ctx).allowed,
    true,
  );
});

test('guard patterns match the shapes the spec named', () => {
  assert.match('Cancel subscription', FORBIDDEN_CONTROL);
  assert.match('https://acme.test/account/close', CANCELLATION_URL);
  assert.doesNotMatch('Billing history', FORBIDDEN_CONTROL);
});

/* -------------------------------------------------------------- observe */

test('observation numbers real elements, reaching into shadow DOM', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);

  const names = observation.elements.map((item) => item.name);
  assert.ok(names.includes('Billing'), 'nav link found');
  assert.ok(names.includes('Cancel subscription'), 'cancel link found');
  assert.ok(names.includes('Download invoice'), 'shadow DOM button found');
  assert.ok(names.includes('Confirm password'), 'input labelled via <label>');

  const ids = observation.elements.map((item) => item.id);
  assert.deepEqual(ids, [...new Set(ids)], 'ids are unique');
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids are assigned in order');

  const password = observation.elements.find((item) => item.isPassword);
  assert.ok(password !== undefined, 'password field flagged');
  assert.equal(observation.hasPasswordField, true);

  // The rendered text is what the model sees: ids and names, never a selector.
  assert.match(observation.text, /INTERACTABLE ELEMENTS/);
  assert.match(observation.text, /"Cancel subscription"/);
  assert.ok(!observation.text.includes('data-lw-id'), 'internal selectors stay out of the prompt');
  assert.match(observation.text, /PAGE OUTLINE/);

  const below = observation.elements.find((item) => item.name === 'Billing history archive');
  assert.equal(below?.inViewport, false, 'off-screen element is marked as such');
});

test('observing twice keeps shadow DOM elements visible', async () => {
  await page.goto(`${site.origin}/billing`);
  const first = await observe(page, GOAL);
  const second = await observe(page, GOAL);

  for (const observation of [first, second]) {
    assert.ok(
      observation.elements.some((item) => item.name === 'Download invoice'),
      'shadow DOM element survives re-observation',
    );
  }
  assert.equal(first.hash, second.hash, 'an unchanged page hashes the same');
});

test('goal keywords drive which elements are shown first', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const keywords = goalKeywords(GOAL);
  assert.ok(keywords.includes('billing'));
  assert.ok(!keywords.includes('the'), 'stopwords dropped');

  const lines = observation.text.split('\n').filter((line) => /^\s*\d+ \| /.test(line));
  const firstFew = lines.slice(0, 4).join(' ').toLowerCase();
  assert.ok(firstFew.includes('billing'), 'a goal-matching element ranks near the top');
});

/* ------------------------------------------------------------- executor */

test('element ids resolve to real elements and clicking one navigates', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const settings = observation.elements.find((item) => item.name === 'Settings' && item.role === 'link');
  assert.ok(settings !== undefined);

  const result = await executeAction(
    { kind: 'click', elementId: settings.id, reason: 'open settings' },
    {
      page,
      resolve: observation.resolve,
      origin: site.origin,
      dryRun: false,
      registerSecret: () => undefined,
    },
  );

  assert.equal(result.ok, true, result.message);
  assert.equal(page.url(), `${site.origin}/settings`);
});

test('fill types a credential from the environment and never reports its value', async () => {
  const secret = 'fixture-only-p@ssword-8891';
  process.env['FIXTURE_PASSWORD'] = secret;
  const seen: string[] = [];

  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const field = observation.elements.find((item) => item.isPassword);
  assert.ok(field !== undefined);

  const result = await executeAction(
    { kind: 'fill', elementId: field.id, valueRef: 'FIXTURE_PASSWORD', reason: 'sign in' },
    {
      page,
      resolve: observation.resolve,
      origin: site.origin,
      dryRun: false,
      registerSecret: (value: string) => seen.push(value),
    },
  );

  assert.equal(result.ok, true, result.message);
  assert.equal(await page.locator('#pw').inputValue(), secret, 'the value really was typed');
  assert.ok(!result.message.includes(secret), 'the outcome fed back to the model omits the value');
  assert.match(result.message, /FIXTURE_PASSWORD/, 'the key name is reported instead');
  assert.deepEqual(seen, [secret], 'the value is registered with the redactor');

  delete process.env['FIXTURE_PASSWORD'];
});

test('an unconfigured credential fails cleanly instead of typing something wrong', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const field = observation.elements.find((item) => item.isPassword);
  assert.ok(field !== undefined);

  const result = await executeAction(
    { kind: 'fill', elementId: field.id, valueRef: 'NOT_CONFIGURED_ANYWHERE', reason: 'sign in' },
    { page, resolve: observation.resolve, origin: site.origin, dryRun: false, registerSecret: () => undefined },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /UNKNOWN_VALUE_REF/);
});

test('the executor refuses off-origin navigation even if a guard were bypassed', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);

  const result = await executeAction(
    { kind: 'navigate', url: 'https://example.com/help', reason: 'read the help centre' },
    { page, resolve: observation.resolve, origin: site.origin, dryRun: false, registerSecret: () => undefined },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /BLOCKED: off-origin/);
  assert.equal(page.url(), `${site.origin}/billing`, 'the page did not move');
});

test('dry run proposes an action without touching the page', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const settings = observation.elements.find((item) => item.name === 'Settings' && item.role === 'link');
  assert.ok(settings !== undefined);

  const result = await executeAction(
    { kind: 'click', elementId: settings.id, reason: 'open settings' },
    { page, resolve: observation.resolve, origin: site.origin, dryRun: true, registerSecret: () => undefined },
  );

  assert.equal(result.ok, true);
  assert.match(result.message, /^DRY RUN: would click element/);
  assert.equal(page.url(), `${site.origin}/billing`, 'nothing was clicked');
});

/* ---------------------------------------------- guards over a real page */

test('the cancel button on a real page is blocked before it is clicked', async () => {
  await page.goto(`${site.origin}/billing`);
  const observation = await observe(page, GOAL);
  const cancel = observation.elements.find((item) => item.name === 'Cancel subscription');
  assert.ok(cancel !== undefined);

  const verdict = checkAction(
    { kind: 'click', elementId: cancel.id, reason: 'check the cancellation terms' },
    { currentUrl: observation.url, origin: site.origin, element: cancel },
  );
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) assert.equal(verdict.rule, 'FORBIDDEN_CONTROL');
  assert.equal(page.url(), `${site.origin}/billing`, 'the subscription is untouched');
});

test('walking onto the confirmation page stops at the submit button', async () => {
  await page.goto(`${site.origin}/cancel-plan`);
  const observation = await observe(page, GOAL);
  const submit = observation.elements.find((item) => item.isSubmit);
  assert.ok(submit !== undefined, 'the confirmation form was observed');

  const verdict = checkAction(
    { kind: 'click', elementId: submit.id, reason: 'confirm' },
    { currentUrl: observation.url, origin: site.origin, element: submit },
  );
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.rule, 'SUBMIT_ON_CANCELLATION_PAGE');
  assert.equal(verdict.halt, true);
});

/* ------------------------------------------------------------ cred refs */

test('credential key names derive from the service name', () => {
  assert.equal(envPrefix('Notion'), 'NOTION');
  assert.equal(envPrefix('Adobe Creative Cloud'), 'ADOBE_CREATIVE_CLOUD');
  assert.deepEqual(credentialRefs('GitHub'), {
    emailRef: 'GITHUB_EMAIL',
    passwordRef: 'GITHUB_PASSWORD',
    totpRef: 'GITHUB_TOTP_SECRET',
  });
});

test('a password field on a billing page is not a logged-out session', async () => {
  await page.goto(`${site.origin}/billing`);
  assert.equal(
    await looksLikeLogin(page),
    false,
    'billing pages ask you to confirm your password; that is not a login wall',
  );

  await page.goto(`${site.origin}/account/session`);
  assert.equal(await looksLikeLogin(page), true, 'a real sign-in form is detected');
});
