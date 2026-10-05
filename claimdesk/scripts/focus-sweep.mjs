#!/usr/bin/env node
/**
 * Focus sweep (docs/V03-MANAGER-MODE-HIRE-PRICING.md §D.3) — the permanent browser guard for the owner's
 * "every time I type it clicks off per character" bug.
 *
 * Signs in, turns Manager mode on (so every wizard step is reachable), then visits every screen and every claim tab,
 * opens every dialog it can find, and types into every visible, enabled, editable field ONE KEY AT A TIME, checking
 * after EACH key that the field still has the focus. Date and date-time fields get their own check.
 *
 * It never submits anything: no Enter, no submit buttons, and every API mutation from the page is blocked at the
 * network layer (except the Manager mode heartbeat) and listed in the report.
 *
 * Usage:
 *   CHROMIUM_PATH=/path/to/chrome node scripts/focus-sweep.mjs --base http://localhost:4515 \
 *     [--user courtesycars] [--password CourtesyCars123!] [--out ./focus] [--claims N] [--only /fleet,/claims]
 *
 * Output: <out>/focus-report.json { checked, failures: [{ route, dialog?, label, typed, got, activeElement }], … } and a
 * screenshot per failure. Exit code 1 when any failure.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const require = createRequire(join(repo, 'packages/documents/package.json'));
const { chromium } = require('playwright-core');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function args(argv) {
  const o = { base: 'http://localhost:4000', user: 'courtesycars', password: 'CourtesyCars123!', out: resolve(process.cwd(), 'focus'), claims: Infinity, only: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') o.base = next().replace(/\/$/, '');
    else if (a === '--user') o.user = next();
    else if (a === '--password') o.password = next();
    else if (a === '--out') o.out = resolve(next());
    else if (a === '--claims') o.claims = Number(next());
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--headed') o.headed = true;
    else if (a === '--') continue;
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/focus-sweep.mjs --base http://localhost:PORT [--user U] [--password P] [--out DIR] [--claims N] [--only /route,/route]');
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

const opts = args(process.argv.slice(2));
const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) {
  console.error('Set CHROMIUM_PATH to a Chromium binary (e.g. /opt/pw-browsers/chromium-1194/chrome-linux/chrome).');
  process.exit(2);
}
mkdirSync(opts.out, { recursive: true });

// ---------------------------------------------------------------------------
// What to sweep
// ---------------------------------------------------------------------------

const CLAIM_TAB_IDS = ['overview', 'chronology', 'ledger', 'clocks', 'gates', 'hire', 'offers', 'evidence', 'documents', 'engineering', 'vehicle', 'actions', 'flags'];
const STATIC_ROUTES = ['/', '/claims', '/claims/new', '/fleet', '/fleet/penalties', '/directory', '/kb', '/analytics', '/watch', '/settings', '/settings/templates', '/settings/gta-rates', '/capture'];

/** Buttons that open a dialog or a form (§D.3). */
const OPENER = /^(Start hire|End hire|Edit dates|Add storage|End storage|Add recovery|Add unit|Edit|Allocation check|Add penalty|Log a notice|New document|Fill a|Upload|Add offer|Record|Log|Add comparable|Import|Edit vehicle|Add reading|Clear|Verify|Report|Add rate|Add)/;
/** Never clicked. */
const NEVER = /Delete|Remove|Sign out|Log out|Dispose|Approve|Send|Issue|Generate|Turn off|Manager mode|Save|Submit|Open the claim|Confirm|Supersede|Sign|Download|Print|Reset|Restore|Change password/i;
/** Buttons that only reveal fields in place (clicked on pages and inside dialogs). */
const REVEAL = /^(Paste from Total Car Check|Paste the details|Filters|Show all fields|Add reading|Show previous periods|More about|Check the values)/;

const PROBE_TEXT = 'Ab1 9.5x';
const PROBE_NUMERIC = '12345';
const PROBE_DECIMAL = '49.99';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = { base: opts.base, startedAt: new Date().toISOString(), checked: 0, checkedDates: 0, pages: 0, dialogs: 0, failures: [], blockedMutations: [], pageErrors: [], skipped: [], coverage: {} };
let shot = 0;

function note(route, dialog) {
  const key = dialog ? `${route} » ${dialog}` : route;
  report.coverage[key] = (report.coverage[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

// en-GB: date inputs show dd/mm/yyyy and a 24-hour clock (the context locale alone does not change them).
const browser = await chromium.launch({ executablePath, headless: !opts.headed, args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB' } });
const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(8000);
page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
page.on('pageerror', (e) => report.pageErrors.push({ url: page.url(), message: String(e?.message ?? e).slice(0, 500) }));

let blockMutations = false;
await context.route('**/api/**', (route) => {
  const req = route.request();
  const method = req.method();
  const url = new URL(req.url());
  if (blockMutations && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !url.pathname.endsWith('/auth/manager-mode')) {
    report.blockedMutations.push({ method, path: url.pathname, from: page.url() });
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FOCUS_SWEEP', message: 'Blocked by the focus sweep (it never submits).' } }) });
  }
  return route.continue();
});

async function api(method, path, body) {
  const res = await context.request.fetch(`${opts.base}/api${path}`, { method, data: body, headers: body ? { 'content-type': 'application/json' } : undefined });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

// Sign in (the cookie lands in the browser context), Manager mode on, claim ids.
await api('POST', '/auth/login', { username: opts.user, password: opts.password });
const mm = await api('POST', '/auth/manager-mode', { on: true });
if (!mm.on) console.warn('Manager mode did not turn on:', mm);
const claimsRes = await api('GET', '/claims');
const claimIds = (claimsRes.items ?? []).map((c) => c.id).slice(0, opts.claims);
blockMutations = true;

// ---------------------------------------------------------------------------
// Helpers run in the page
// ---------------------------------------------------------------------------

/** Describe an element for the report. */
const DESCRIBE = (el) => {
  if (!el || el === document.body) return 'body';
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
  const label = el.getAttribute?.('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}${label}`;
};

/** Mark sweepable fields under `root` with data-fs ids and return their descriptions. */
async function collectFields(scope, rootSelector) {
  return scope.evaluate(
    ({ rootSelector, describe }) => {
      const describeEl = new Function(`return (${describe})`)();
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      if (!root) return [];
      const inDialog = (el) => Boolean(el.closest('[role="dialog"]'));
      const textTypes = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', '']);
      const out = [];
      let n = Number(document.body.dataset.fsSeq || '0');
      for (const el of root.querySelectorAll('input, textarea')) {
        if (!rootSelector && inDialog(el)) continue;
        const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase();
        const im = (el.getAttribute('inputmode') || '').toLowerCase();
        const isDate = type === 'date' || type === 'datetime-local';
        if (!(type === 'textarea' || textTypes.has(type) || isDate)) continue;
        if (el.disabled || el.readOnly) continue;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        if (el.closest('[aria-hidden="true"]') || el.classList.contains('sr-only')) continue;
        if (!el.dataset.fs) el.dataset.fs = String(++n);
        let kind = 'text';
        if (type === 'datetime-local') kind = 'datetime';
        else if (type === 'date') kind = 'date';
        else if (type === 'number' || im === 'numeric') kind = 'numeric';
        else if (im === 'decimal') kind = 'decimal';
        const labelEl = el.labels?.[0];
        const label = (el.getAttribute('aria-label') || labelEl?.textContent || el.getAttribute('placeholder') || el.name || describeEl(el)).replace(/\s+/g, ' ').trim().slice(0, 80);
        out.push({ fs: el.dataset.fs, kind, type, label, maxLength: el.maxLength > 0 ? el.maxLength : null });
      }
      document.body.dataset.fsSeq = String(n);
      return out;
    },
    { rootSelector, describe: DESCRIBE.toString() }
  );
}

async function activeInfo() {
  return page.evaluate((describe) => new Function(`return (${describe})`)()(document.activeElement), DESCRIBE.toString());
}

async function screenshot(tag) {
  const file = join(opts.out, `failure-${String(++shot).padStart(3, '0')}-${tag.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}

async function hasFocus(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return Boolean(el) && el === document.activeElement;
  }, sel);
}

async function valueOf(sel) {
  return page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);
}

/** Type one key at a time; after each key the field must still have the focus. */
async function sweepField(route, dialog, f) {
  const sel = `[data-fs="${f.fs}"]`;
  const el = page.locator(sel);
  if (!(await el.isVisible().catch(() => false)) || !(await el.isEditable().catch(() => false))) return;
  note(route, dialog);
  if (f.kind === 'date' || f.kind === 'datetime') return sweepDateField(route, dialog, f, sel, el);
  const probe = f.kind === 'numeric' ? PROBE_NUMERIC : f.kind === 'decimal' ? PROBE_DECIMAL : PROBE_TEXT;
  const typed = f.maxLength && f.maxLength < probe.length ? probe.slice(0, f.maxLength) : probe;
  try {
    await el.scrollIntoViewIfNeeded();
    await el.click({ timeout: 3000 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
  } catch (e) {
    report.skipped.push({ route, dialog, label: f.label, why: `could not focus: ${String(e.message).split('\n')[0]}` });
    return;
  }
  report.checked += 1;
  let sofar = '';
  for (const ch of typed) {
    await page.keyboard.type(ch, { delay: 15 });
    sofar += ch;
    if (!(await hasFocus(sel))) {
      const got = await valueOf(sel);
      const activeElement = await activeInfo();
      report.failures.push({ route, dialog, label: f.label, kind: 'focus', typed: sofar, got, activeElement, screenshot: await screenshot(`${route}-${f.label}`) });
      return;
    }
  }
  const got = await valueOf(sel);
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
  if (!norm(got).includes(norm(typed)) && !(f.kind === 'decimal' && norm(got).includes(norm(PROBE_DECIMAL)))) {
    report.failures.push({ route, dialog, label: f.label, kind: 'value', typed, got, activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}-value`) });
    return;
  }
  await fastAndMidEdit(route, dialog, f, sel, typed, norm);
}

/**
 * Two more passes per text field (0.3 #6): the probe typed with no pause between keys, and two letters typed into the
 * middle of the value. A field bound to state that updates asynchronously (e.g. the URL) passes the key-by-key pass
 * but drops letters here, or throws the cursor to the end.
 */
async function fastAndMidEdit(route, dialog, f, sel, typed, norm) {
  try {
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(typed, { delay: 0 });
    await page.waitForTimeout(400);
  } catch {
    return;
  }
  if (!(await hasFocus(sel))) {
    report.failures.push({ route, dialog, label: f.label, kind: 'focus-fast', typed, got: await valueOf(sel), activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}-fast`) });
    return;
  }
  const fast = await valueOf(sel);
  if (!norm(fast).includes(norm(typed)) && !(f.kind === 'decimal' && norm(fast).includes(norm(PROBE_DECIMAL)))) {
    report.failures.push({ route, dialog, label: f.label, kind: 'value-fast', typed, got: fast, activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}-fast`) });
    return;
  }
  report.checkedFast = (report.checkedFast ?? 0) + 1;
  // Typing into the middle: only where the field keeps what was typed as-is and supports a cursor position.
  if (f.kind !== 'text' || !['text', 'search', 'textarea'].includes(f.type) || fast !== typed || (f.maxLength && f.maxLength < typed.length + 2)) return;
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('xy', { delay: 0 });
  await page.waitForTimeout(400);
  const mid = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? { value: el.value, caret: el.selectionStart, focused: el === document.activeElement } : null;
  }, sel);
  const want = `${typed.slice(0, 2)}xy${typed.slice(2)}`;
  if (!mid || !mid.focused || mid.value !== want || mid.caret !== 4) {
    report.failures.push({ route, dialog, label: f.label, kind: 'mid-edit', typed: `${typed} → Home →→ xy`, got: mid ? `${mid.value} (cursor ${mid.caret}${mid.focused ? '' : ', focus lost'})` : null, want, activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}-mid`) });
    return;
  }
  report.checkedMidEdit = (report.checkedMidEdit ?? 0) + 1;
}

/**
 * Date-time: click the first segment, type 05102026, Tab, 1030 → 2026-10-05T10:30. Date: 05102026 → 2026-10-05.
 * Chromium jumps from a 4-digit year to the hour by itself when the field has a `max` (the year then has a known
 * width), so a Tab would skip the hour: when the first attempt leaves the value incomplete it is retried without the
 * Tab. Focus is checked after every key in both attempts.
 */
async function sweepDateField(route, dialog, f, sel, el) {
  const want = f.kind === 'datetime' ? '2026-10-05T10:30' : '2026-10-05';
  const date = ['0', '5', '1', '0', '2', '0', '2', '6'];
  const attempts = f.kind === 'datetime' ? [[...date, 'Tab', '1', '0', '3', '0'], [...date, '1', '0', '3', '0']] : [date];
  report.checkedDates += 1;
  report.checked += 1;
  let got = null;
  let sofar = '';
  for (const keys of attempts) {
    try {
      await el.scrollIntoViewIfNeeded();
      const box = await el.boundingBox();
      if (!box) return;
      await page.mouse.click(box.x + 12, box.y + box.height / 2);
    } catch {
      return;
    }
    sofar = '';
    for (const k of keys) {
      if (k === 'Tab') await page.keyboard.press('Tab');
      else await page.keyboard.type(k, { delay: 15 });
      sofar += k === 'Tab' ? '⇥' : k;
      if (!(await hasFocus(sel))) {
        report.failures.push({ route, dialog, label: f.label, kind: 'focus', typed: sofar, got: await valueOf(sel), activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}`) });
        return;
      }
    }
    got = await valueOf(sel);
    if (got === want) return;
  }
  report.failures.push({ route, dialog, label: f.label, kind: 'date', typed: sofar, got, want, activeElement: await activeInfo(), screenshot: await screenshot(`${route}-${f.label}-date`) });
}

async function openDetails(rootSelector) {
  await page.evaluate((rs) => {
    const root = rs ? document.querySelector(rs) : document;
    for (const d of root?.querySelectorAll('details:not([open])') ?? []) {
      if (!rs && d.closest('[role="dialog"]')) continue;
      d.open = true;
    }
  }, rootSelector);
}

async function clickReveals(rootSelector) {
  const scope = rootSelector ? page.locator(rootSelector) : page.locator('body');
  const buttons = scope.getByRole('button', { name: REVEAL });
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (!rootSelector && (await b.evaluate((el) => Boolean(el.closest('[role="dialog"]'))).catch(() => true))) continue;
    if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
    const pressed = await b.getAttribute('aria-expanded').catch(() => null);
    if (pressed === 'true') continue;
    await b.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
  }
}

async function sweepScope(route, dialog, rootSelector) {
  await openDetails(rootSelector);
  await clickReveals(rootSelector);
  await openDetails(rootSelector);
  const fields = await collectFields(page, rootSelector);
  for (const f of fields) await sweepField(route, dialog, f);
}

async function dialogOpen() {
  return (await page.locator('[role="dialog"]').count()) > 0;
}

async function closeDialogs() {
  for (let i = 0; i < 4 && (await dialogOpen()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 3 && (await dialogOpen()); i++) {
    const d = page.locator('[role="dialog"]').last();
    const cancel = d.getByRole('button', { name: /^(Cancel|Close|✕)$/ }).first();
    await cancel.click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

/** In a dialog, pick the first real option of each empty select once (reveals the fields that depend on it). */
async function fillEmptySelects(rootSelector) {
  const selects = page.locator(`${rootSelector} select`);
  const n = await selects.count();
  for (let i = 0; i < n; i++) {
    const s = selects.nth(i);
    if (!(await s.isVisible().catch(() => false)) || !(await s.isEnabled().catch(() => false))) continue;
    const pick = await s.evaluate((el) => {
      if (el.value) return null;
      // docx:… opens the Fill dialog instead (swept on its own by sweepWordChooser).
      const o = [...el.options].find((x) => x.value && !x.disabled && !x.value.startsWith('docx:') && !/Add policy|Not listed|Other…|__/.test(x.textContent + x.value));
      return o ? o.value : null;
    });
    if (pick) {
      await s.selectOption(pick).catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

/** A chooser option that hands over to another dialog (the Documents tab's CCGUK Word templates → Fill dialog). */
async function wordOptionIn(rootSelector) {
  return page.evaluate((rs) => {
    for (const sel of document.querySelectorAll(`${rs} select`)) {
      const o = [...sel.options].find((x) => x.value.startsWith('docx:'));
      if (o) {
        sel.setAttribute('data-fs-chooser', '1');
        return o.value;
      }
    }
    return null;
  }, rootSelector);
}

async function sweepDialog(route, name) {
  await page.locator('[role="dialog"]').last().waitFor({ state: 'visible', timeout: 2500 });
  await page.evaluate(() => {
    const ds = document.querySelectorAll('[role="dialog"]');
    ds.forEach((d) => d.removeAttribute('data-fs-root'));
    ds[ds.length - 1]?.setAttribute('data-fs-root', '1');
  });
  const rs = '[data-fs-root="1"]';
  report.dialogs += 1;
  const word = await wordOptionIn(rs);
  await fillEmptySelects(rs);
  await sweepScope(route, name, rs);
  return { word };
}

/** Re-open the chooser and take the Word-template path: the Fill dialog replaces it; sweep that one too. */
async function sweepWordChooser(route, opener, name, value) {
  await opener.click({ timeout: 2500 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const sel = page.locator('[role="dialog"] select[data-fs-chooser="1"], [role="dialog"] select').filter({ has: page.locator(`option[value="${value}"]`) }).first();
  if (!(await sel.count())) return;
  await sel.selectOption(value).catch(() => undefined);
  await page.waitForTimeout(600);
  if (await dialogOpen()) {
    const dname = (await page.locator('[role="dialog"]').last().getAttribute('aria-label').catch(() => null)) || `${name} → Word template`;
    await sweepDialog(route, dname);
  }
  await closeDialogs();
}

/** Click every opener on the page (outside dialogs), sweep the dialog it opens, close it. */
async function sweepOpeners(route) {
  const seen = new Set();
  for (let pass = 0; pass < 60; pass++) {
    const candidates = await page.evaluate(
      ({ opener, never }) => {
        const O = new RegExp(opener);
        const N = new RegExp(never, 'i');
        const out = [];
        const counts = {};
        for (const b of document.querySelectorAll('button, [role="button"], a.btn')) {
          if (b.closest('[role="dialog"]')) continue;
          const name = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
          if (!name || !O.test(name) || N.test(name)) continue;
          if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
          if (b.tagName === 'A' && b.getAttribute('href') && !b.getAttribute('href').startsWith('#')) continue;
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          counts[name] = (counts[name] ?? 0) + 1;
          b.setAttribute('data-fs-btn', `${name}#${counts[name] - 1}`);
          out.push({ name, nth: counts[name] - 1 });
        }
        return out;
      },
      { opener: OPENER.source, never: NEVER.source }
    );
    const next = candidates.find((c) => !seen.has(`${c.name}#${c.nth}`));
    if (!next) return;
    seen.add(`${next.name}#${next.nth}`);
    // Only the first three of the same name (e.g. "Edit" on every row) — the dialogs are the same.
    if (next.nth > 2) continue;
    const startUrl = page.url();
    const btn = page.locator(`[data-fs-btn="${`${next.name}#${next.nth}`.replace(/"/g, '\\"')}"]`).first();
    try {
      await btn.click({ timeout: 2500 });
    } catch {
      continue;
    }
    await page.waitForTimeout(300);
    if (await dialogOpen()) {
      const dname = (await page.locator('[role="dialog"]').last().getAttribute('aria-label').catch(() => null)) || next.name;
      let word = null;
      try {
        ({ word } = await sweepDialog(route, dname));
      } catch (e) {
        report.skipped.push({ route, dialog: dname, why: String(e.message).split('\n')[0] });
      }
      await closeDialogs();
      if (word) await sweepWordChooser(route, btn, dname, word).catch((e) => report.skipped.push({ route, dialog: `${dname} → Word template`, why: String(e.message).split('\n')[0] }));
    } else {
      // an in-place form (e.g. Add reading) or a menu: sweep the page again for new fields
      await sweepScope(route, null, null);
    }
    if (page.url() !== startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await settle();
    }
  }
}

async function sweepStatusSelect(route) {
  const sel = page.getByLabel('Change status');
  if (!(await sel.count())) return;
  const first = await sel.first().evaluate((el) => [...el.options].find((o) => o.value)?.value ?? null);
  if (!first) return;
  await sel.first().selectOption(first);
  await page.waitForTimeout(300);
  if (await dialogOpen()) {
    await sweepDialog(route, 'Status change');
    await closeDialogs();
  }
}

async function settle() {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function visit(route, extra) {
  if (opts.only && !opts.only.some((p) => route === p || route.startsWith(p))) return;
  process.stdout.write(`· ${route}\n`);
  try {
    await page.goto(`${opts.base}${route}`, { waitUntil: 'domcontentloaded' });
    await settle();
    report.pages += 1;
    // A page that never rendered would pass with nothing checked: that is a failure, not a pass.
    const rendered = await page.waitForSelector('main, .page, .login-page', { timeout: 8000 }).then(() => true).catch(() => false);
    if (!rendered) {
      report.failures.push({ route, label: '(page)', kind: 'render', typed: '', got: (await page.locator('body').innerText().catch(() => '')).slice(0, 200), activeElement: await activeInfo(), screenshot: await screenshot(`${route}-render`) });
      return;
    }
    await sweepScope(route, null, null);
    if (extra) await extra(route);
    await sweepOpeners(route);
    if (/^\/claims\/[^/]+\/overview$/.test(route)) await sweepStatusSelect(route);
  } catch (e) {
    report.skipped.push({ route, why: String(e.message).split('\n')[0] });
    await closeDialogs().catch(() => undefined);
  }
}

/** New claim wizard: click each of the 5 steps and sweep it. */
async function wizardSteps(route) {
  const steps = page.locator('.wizard-steps button, .wizard-steps [role="button"]');
  const n = await steps.count();
  for (let i = 0; i < n; i++) {
    await steps.nth(i).click({ timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(250);
    await sweepScope(`${route}#step${i + 1}`, null, null);
    await sweepOpeners(`${route}#step${i + 1}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const t0 = Date.now();
for (const r of STATIC_ROUTES) await visit(r, r === '/claims/new' ? wizardSteps : undefined);
for (const id of claimIds) for (const tab of CLAIM_TAB_IDS) await visit(`/claims/${id}/${tab}`);

// Manager mode back off (it is per session; the session ends with the browser anyway).
blockMutations = false;
await api('POST', '/auth/manager-mode', { on: false }).catch(() => undefined);
await browser.close();

report.finishedAt = new Date().toISOString();
report.seconds = Math.round((Date.now() - t0) / 1000);
report.claims = claimIds.length;
const file = join(opts.out, 'focus-report.json');
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nFocus sweep: ${report.checked} fields checked (${report.checkedDates} date/date-time; ${report.checkedFast ?? 0} also typed fast, ${report.checkedMidEdit ?? 0} edited mid-value) on ${report.pages} pages and ${report.dialogs} dialogs; ${report.failures.length} failure(s); ${report.blockedMutations.length} mutation(s) blocked.`);
for (const f of report.failures) console.log(`  ✗ ${f.route}${f.dialog ? ` » ${f.dialog}` : ''} — ${f.label}: typed "${f.typed}", got "${f.got}" (${f.kind}; focus on ${f.activeElement})`);
console.log(`Report: ${file}`);
process.exit(report.failures.length ? 1 : 0);
