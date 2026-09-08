import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { generateSync } from 'otplib';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Redactor } from '../trace/logger.js';

/** Credential keys are derived from the service name: "Notion" -> NOTION_PASSWORD. */
export function envPrefix(service: string): string {
  return service.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export interface ServiceCredentials {
  readonly emailRef: string;
  readonly passwordRef: string;
  readonly totpRef: string;
}

export function credentialRefs(service: string): ServiceCredentials {
  const prefix = envPrefix(service);
  return {
    emailRef: `${prefix}_EMAIL`,
    passwordRef: `${prefix}_PASSWORD`,
    totpRef: `${prefix}_TOTP_SECRET`,
  };
}

/* ------------------------------------------------------------ first login */

const LOGIN_URL = /login|signin|sign-in|sign_in|auth|session|account\/login/i;

/**
 * One-time manual login. Opens a real browser, lets the user sign in by hand,
 * and saves the resulting storageState.
 *
 * storageState is captured on a timer because once the user closes the window
 * the context is gone and cannot be read. The last good snapshot is what gets
 * written.
 */
export async function interactiveLogin(options: {
  readonly service: string;
  readonly url: string;
  readonly authFile: string;
  readonly dryRun: boolean;
}): Promise<{ readonly saved: boolean; readonly path: string }> {
  const path = resolve(options.authFile);

  if (options.dryRun) {
    console.log(`DRY RUN: would open ${options.url} headed and save storageState to ${path}`);
    return { saved: false, path };
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(options.url, { waitUntil: 'domcontentloaded' });

  console.log(`\nA browser window is open at ${options.url}`);
  console.log(`Sign in to ${options.service} by hand.`);
  console.log('When you are done, close the window (or press Enter here) to save the session.\n');

  let snapshot: string | null = null;
  const capture = async (): Promise<void> => {
    try {
      snapshot = JSON.stringify(await context.storageState(), null, 2);
    } catch {
      /* context closed mid-capture; keep the previous snapshot */
    }
  };

  const timer = setInterval(() => void capture(), 2_000);

  const closed = new Promise<void>((done) => {
    context.once('close', () => done());
    browser.once('disconnected', () => done());
  });
  const entered = new Promise<void>((done) => {
    const onData = (): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      done();
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });

  await Promise.race([closed, entered]);
  clearInterval(timer);
  await capture();

  try {
    await browser.close();
  } catch {
    /* already closed by the user */
  }

  if (snapshot === null) {
    console.error('Could not read the browser session — nothing was saved.');
    return { saved: false, path };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${snapshot}\n`, 'utf8');
  // Session cookies are bearer credentials: owner-only.
  chmodSync(path, 0o600);
  return { saved: true, path };
}

export function hasAuthFile(authFile: string): boolean {
  return existsSync(resolve(authFile));
}

/* --------------------------------------------------------------- re-auth */

const IDENTIFIER_SELECTOR =
  'input[type="email"]:visible, input[name*="email" i]:visible, ' +
  'input[name*="user" i]:visible, input[id*="username" i]:visible';

const LOGIN_HEADING = /sign\s?-?in|log\s?-?in|login|authenticate|session (has )?expired/i;

/**
 * Does this look like a login wall rather than the app?
 *
 * A visible password box is not enough on its own: billing pages routinely ask
 * you to confirm your password before showing card details, and treating that as
 * a logged-out session would burn the single re-auth attempt on every run. A
 * login wall also has somewhere to put the identifier, or says so in the title.
 */
export async function looksLikeLogin(page: Page): Promise<boolean> {
  if (LOGIN_URL.test(page.url())) return true;
  try {
    if ((await page.locator('input[type="password"]:visible').count()) === 0) return false;
    if ((await page.locator(IDENTIFIER_SELECTOR).count()) > 0) return true;

    const title = await page.title();
    let heading = '';
    try {
      heading = (await page.locator('h1').first().textContent({ timeout: 1_000 })) ?? '';
    } catch {
      /* no heading, or several: the title alone decides */
    }
    return LOGIN_HEADING.test(`${title} ${heading}`);
  } catch {
    return false;
  }
}

export type ReauthOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const SUBMIT_SELECTOR =
  'button[type="submit"]:visible, input[type="submit"]:visible, ' +
  'button:visible:has-text("Sign in"), button:visible:has-text("Log in"), button:visible:has-text("Continue")';

const OTP_SELECTOR =
  'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, ' +
  'input[name*="code" i]:visible, input[id*="otp" i]:visible, input[id*="totp" i]:visible';

async function clickSubmit(page: Page): Promise<void> {
  const submit = page.locator(SUBMIT_SELECTOR).first();
  if ((await submit.count()) > 0) {
    await submit.click({ timeout: 8_000 });
  } else {
    await page.keyboard.press('Enter');
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    /* single-page apps often never go idle */
  }
}

/**
 * One attempt at signing back in with stored credentials, for when a session
 * expires mid-run. Deliberately not a loop: a second failure means something is
 * wrong that retrying will not fix, and repeated attempts risk locking the
 * account.
 *
 * Credentials are read here and typed straight into the page. They are never
 * returned, logged, or shown to the model — only the key names are.
 */
export async function attemptReauth(options: {
  readonly page: Page;
  readonly service: string;
  readonly redactor: Redactor;
}): Promise<ReauthOutcome> {
  const { page, service, redactor } = options;
  const refs = credentialRefs(service);

  const email = process.env[refs.emailRef];
  const password = process.env[refs.passwordRef];
  if (email === undefined || email === '' || password === undefined || password === '') {
    return { ok: false, reason: `AUTH_EXPIRED: ${refs.emailRef} / ${refs.passwordRef} are not configured` };
  }
  redactor.add(email);
  redactor.add(password);

  try {
    const emailField = page
      .locator(
        'input[type="email"]:visible, input[name*="email" i]:visible, ' +
          'input[name*="user" i]:visible, input[id*="email" i]:visible',
      )
      .first();
    if ((await emailField.count()) > 0) {
      await emailField.fill(email, { timeout: 8_000 });
      // Some providers ask for the address, then the password on a second screen.
      const passwordVisible = await page.locator('input[type="password"]:visible').count();
      if (passwordVisible === 0) await clickSubmit(page);
    }

    const passwordField = page.locator('input[type="password"]:visible').first();
    if ((await passwordField.count()) === 0) {
      return { ok: false, reason: 'AUTH_EXPIRED: no password field found on the login page' };
    }
    await passwordField.fill(password, { timeout: 8_000 });
    await clickSubmit(page);

    // Second factor, if the account uses one and a seed is configured.
    const otpField = page.locator(OTP_SELECTOR).first();
    if ((await otpField.count()) > 0) {
      const seed = process.env[refs.totpRef];
      if (seed === undefined || seed === '') {
        return { ok: false, reason: `AUTH_EXPIRED: a one-time code was requested but ${refs.totpRef} is not set` };
      }
      redactor.add(seed);
      const code = generateSync({ secret: seed.replace(/\s+/g, '').toUpperCase(), strategy: 'totp' });
      redactor.add(code);
      await otpField.fill(code, { timeout: 8_000 });
      await clickSubmit(page);
    }

    if (await looksLikeLogin(page)) {
      return { ok: false, reason: 'AUTH_EXPIRED: still on a login page after re-authenticating' };
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    // Redact defensively: a Playwright error can quote the value it tried to fill.
    return { ok: false, reason: `AUTH_EXPIRED: ${redactor.string(detail)}` };
  }
}

/** Saved contexts double as the browser launcher for a run. */
export async function launchContext(options: {
  readonly authFile: string;
  readonly headed: boolean;
  readonly tracePath: string;
}): Promise<{ readonly context: BrowserContext; readonly close: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: !options.headed });
  const storagePath = resolve(options.authFile);
  const context = await browser.newContext(
    existsSync(storagePath) ? { storageState: storagePath } : {},
  );
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  return {
    context,
    close: async (): Promise<void> => {
      try {
        await context.tracing.stop({ path: options.tracePath });
      } catch {
        /* tracing may already be stopped */
      }
      await browser.close();
    },
  };
}
