import { createServer } from 'node:http';
import type { Server } from 'node:http';

const PAGES: Readonly<Record<string, string>> = {
  '/settings': `<!doctype html><title>Acme - Settings</title>
    <nav><a href="/settings">Settings</a> <a href="/billing">Billing</a></nav>
    <h1>Settings</h1><p>Choose a section.</p>`,

  '/billing': `<!doctype html><title>Acme - Billing</title>
    <nav>
      <a href="/settings">Settings</a>
      <a href="/billing">Billing</a>
      <a href="https://example.com/help">Help centre</a>
    </nav>
    <main>
      <h1>Billing</h1>
      <p>Plan: <strong>Team</strong></p>
      <p>Billed: <strong>$96.00</strong> yearly</p>
      <p>Next renewal: <strong>2026-03-01</strong></p>
      <label for="pw">Confirm password</label>
      <input id="pw" type="password" name="password" />
      <button id="downgrade">Downgrade to Free</button>
      <a href="/cancel-plan">Cancel subscription</a>
      <billing-widget></billing-widget>
      <div style="height:2000px"></div>
      <button id="far-below">Billing history archive</button>
    </main>
    <script>
      customElements.define('billing-widget', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<button id="invoice">Download invoice</button>';
        }
      });
    </script>`,

  '/account/session': `<!doctype html><title>Acme - Sign in</title>
    <h1>Sign in to Acme</h1>
    <form method="post">
      <label for="email">Email</label><input id="email" type="email" name="email" />
      <label for="pw2">Password</label><input id="pw2" type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>`,

  '/cancel-plan': `<!doctype html><title>Cancel your plan</title>
    <h1>Cancel your plan</h1>
    <form method="post" action="/cancel-plan">
      <p>This ends your subscription immediately.</p>
      <button type="submit">Yes, end my billing</button>
    </form>
    <a href="/billing">Keep my plan</a>`,
};

export interface Fixture {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

/** A tiny local site so browser tests exercise real origins, frames and shadow DOM. */
export async function startFixtureSite(): Promise<Fixture> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const body = PAGES[path];
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Not found</title><h1>404</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
