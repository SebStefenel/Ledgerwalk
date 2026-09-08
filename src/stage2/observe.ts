import type { Frame, Locator, Page } from 'playwright';

import { hashObservation } from '../trace/logger.js';

/* ------------------------------------------------------------------ types */

export interface ObservedElement {
  /** id shown to the model; unique across all frames of one observation */
  readonly id: number;
  readonly role: string;
  /** accessible name, already trimmed and truncated */
  readonly name: string;
  readonly tag: string;
  readonly type: string | null;
  /** whether a field currently holds text — never the text itself */
  readonly filled: boolean;
  readonly disabled: boolean;
  readonly inViewport: boolean;
  /** clicking this would submit a form */
  readonly isSubmit: boolean;
  readonly inForm: boolean;
  readonly isPassword: boolean;
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  /** exactly the text handed to the model */
  readonly text: string;
  readonly hash: string;
  readonly elements: readonly ObservedElement[];
  readonly resolve: (id: number) => Locator | null;
  readonly hasPasswordField: boolean;
}

/** Raw shape returned by the in-page script, before ids are made global. */
interface ScrapedElement {
  readonly lwId: number;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly type: string | null;
  readonly filled: boolean;
  readonly disabled: boolean;
  readonly inViewport: boolean;
  readonly isSubmit: boolean;
  readonly inForm: boolean;
  readonly isPassword: boolean;
}

/* ------------------------------------------------------------ page script */

/**
 * Runs inside the page. Marks every interactable element with `data-lw-id` so
 * the driver can build a locator for it later, and reports a description of it.
 *
 * The model only ever sees the integer. Selectors are resolved on our side,
 * which is what keeps the model from steering the browser at arbitrary targets.
 */
const SCRAPE = (): ScrapedElement[] => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]',
  ].join(',');

  const roots: (Document | ShadowRoot)[] = [document];
  const collected: Element[] = [];
  // Walk open shadow roots too — component libraries hide half a billing page in them.
  // Marks from the previous observation are cleared per root: querySelectorAll on
  // the document does not reach inside a shadow root, so clearing only there would
  // leave stale ids and make those elements invisible on every later step.
  for (let index = 0; index < roots.length && index < 200; index += 1) {
    const root = roots[index];
    if (root === undefined) continue;
    for (const marked of Array.from(root.querySelectorAll('[data-lw-id]'))) {
      marked.removeAttribute('data-lw-id');
    }
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    }
    for (const element of Array.from(root.querySelectorAll(SELECTOR))) collected.push(element);
  }

  const clean = (text: string | null | undefined): string =>
    (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

  const accessibleName = (element: Element): string => {
    const label = element.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') return clean(label);

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .filter((part) => part.trim() !== '');
      if (parts.length > 0) return clean(parts.join(' '));
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) {
      const labels = element.labels;
      if (labels !== null && labels.length > 0) {
        const text = clean(Array.from(labels).map((node) => node.textContent ?? '').join(' '));
        if (text !== '') return text;
      }
      const placeholder = element.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return clean(placeholder);
      const name = element.getAttribute('name');
      if (name !== null && name.trim() !== '') return clean(name);
    }

    const title = element.getAttribute('title');
    if (title !== null && title.trim() !== '') return clean(title);

    const alt = element.querySelector('img[alt]')?.getAttribute('alt');
    if (alt !== null && alt !== undefined && alt.trim() !== '') return clean(alt);

    return clean(element.textContent);
  };

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit !== null && explicit.trim() !== '') return explicit.trim();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (element instanceof HTMLInputElement) {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'password') return 'password';
      return 'textbox';
    }
    return 'generic';
  };

  const results: ScrapedElement[] = [];
  let lwId = 0;

  for (const element of collected) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.getAttribute('data-lw-id') !== null) continue; // already seen this node

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') continue;

    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type');
    const isPassword = element instanceof HTMLInputElement && (type ?? '').toLowerCase() === 'password';
    const name = accessibleName(element);
    // An unnamed element is unusable to the model; keep inputs anyway (they may be the login form).
    if (name === '' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;

    const form = element.closest('form');
    const lowerType = (type ?? '').toLowerCase();
    const isSubmit =
      lowerType === 'submit' ||
      (tag === 'button' && (lowerType === '' || lowerType === 'submit') && form !== null);

    const value =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '';

    element.setAttribute('data-lw-id', String(lwId));
    results.push({
      lwId,
      role: roleOf(element),
      // A password field's name is safe (it is a label); its value is never read.
      name,
      tag,
      type: type === null ? null : type.toLowerCase(),
      filled: value !== '',
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      inViewport:
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth,
      isSubmit,
      inForm: form !== null,
      isPassword,
    });
    lwId += 1;
  }

  return results;
};

/**
 * Run a page function that was authored here in TypeScript.
 *
 * tsx compiles with esbuild's `keepNames`, which rewrites every named function
 * as `__name(fn, "fn")`. That helper exists in this module's scope, not in the
 * browser, so handing the function straight to `evaluate` throws
 * "__name is not defined" inside the page and the observation comes back empty.
 *
 * Serialising the source and supplying a no-op `__name` next to it keeps the
 * browser code type-checked on this side while still running on that side.
 * Under `tsc` output there is no such wrapper and the shim goes unused.
 */
async function evaluateInPage<T>(frame: Frame, pageFunction: () => T): Promise<T> {
  const source = `(() => { const __name = (fn) => fn; return (${pageFunction.toString()})(); })()`;
  return (await frame.evaluate(source)) as T;
}

/* ------------------------------------------------------------- rendering */

/** Roughly four characters per token; good enough to keep a budget. */
const CHARS_PER_TOKEN = 4;
const TOKEN_BUDGET = 4_000;
const ELEMENT_SHARE = 0.6;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'find', 'report', 'current',
  'your', 'their', 'page', 'then', 'what', 'which', 'each', 'into', 'about',
]);

export function goalKeywords(goal: string): readonly string[] {
  return [
    ...new Set(
      goal
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
    ),
  ];
}

function priority(element: ObservedElement, keywords: readonly string[]): number {
  const name = element.name.toLowerCase();
  let score = 0;
  if (keywords.some((keyword) => name.includes(keyword))) score += 4;
  if (element.inViewport) score += 2;
  if (element.role === 'link' || element.role === 'button') score += 1;
  if (element.disabled) score -= 2;
  return score;
}

function describeElement(element: ObservedElement): string {
  const flags: string[] = [];
  if (element.inViewport) flags.push('in view');
  if (element.disabled) flags.push('disabled');
  if (element.isSubmit) flags.push('submit');
  if (element.filled) flags.push('filled');
  const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  const name = element.name === '' ? '(no name)' : element.name;
  return `${String(element.id).padStart(3)} | ${element.role} | "${name}"${suffix}`;
}

function renderObservation(options: {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly ObservedElement[];
  readonly outline: string;
  readonly goal: string;
}): string {
  const keywords = goalKeywords(options.goal);
  const ranked = [...options.elements].sort((a, b) => priority(b, keywords) - priority(a, keywords) || a.id - b.id);

  const elementBudget = TOKEN_BUDGET * ELEMENT_SHARE * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  for (const element of ranked) {
    const line = describeElement(element);
    if (used + line.length > elementBudget) break;
    lines.push(line);
    used += line.length + 1;
  }

  const hidden = options.elements.length - lines.length;
  const elementNote =
    hidden > 0
      ? `\n  ... ${hidden} more element(s) not shown; scroll to bring them into view.`
      : '';

  const outlineBudget = (TOKEN_BUDGET * CHARS_PER_TOKEN) - used;
  const outline =
    options.outline.length > outlineBudget
      ? `${options.outline.slice(0, Math.max(0, outlineBudget))}\n  ... outline truncated`
      : options.outline;

  return [
    `URL: ${options.url}`,
    `TITLE: ${options.title}`,
    '',
    'INTERACTABLE ELEMENTS (id | role | name):',
    lines.join('\n'),
    elementNote,
    '',
    'PAGE OUTLINE (accessibility tree):',
    outline,
  ].join('\n');
}

/* ------------------------------------------------------------- observing */

/** Snapshot the page: mark elements, read the ARIA tree, and render both. */
export async function observe(page: Page, goal: string): Promise<Observation> {
  const elements: ObservedElement[] = [];
  const handles = new Map<number, { readonly frame: Frame; readonly lwId: number }>();
  let nextId = 0;

  for (const frame of page.frames()) {
    let scraped: ScrapedElement[];
    try {
      scraped = await evaluateInPage(frame, SCRAPE);
    } catch {
      continue; // frame detached or still loading — skip it
    }
    for (const item of scraped) {
      const id = nextId;
      nextId += 1;
      handles.set(id, { frame, lwId: item.lwId });
      elements.push({
        id,
        role: item.role,
        name: item.name,
        tag: item.tag,
        type: item.type,
        filled: item.filled,
        disabled: item.disabled,
        inViewport: item.inViewport,
        isSubmit: item.isSubmit,
        inForm: item.inForm,
        isPassword: item.isPassword,
      });
    }
  }

  let outline = '';
  try {
    outline = await page.locator('body').ariaSnapshot({ timeout: 5_000 });
  } catch {
    outline = '(accessibility tree unavailable)';
  }

  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '(untitled)';
  }

  const text = renderObservation({ url, title, elements, outline, goal });

  return {
    url,
    title,
    text,
    // Hash the structure, not the render, so the same page hashes alike across goals.
    hash: hashObservation(`${url}\n${elements.map(describeElement).join('\n')}`),
    elements,
    hasPasswordField: elements.some((element) => element.isPassword),
    resolve: (id: number): Locator | null => {
      const handle = handles.get(id);
      if (handle === undefined) return null;
      try {
        return handle.frame.locator(`[data-lw-id="${handle.lwId}"]`);
      } catch {
        return null;
      }
    },
  };
}
