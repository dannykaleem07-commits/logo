'use strict';
// Smoke-test harness: static server for estimator/app + a Playwright page with a mock of window.desktop
// (same shape as estimator/preload.js), recording every call and failing on page errors / console errors.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..', '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const p = path.join(APP, u === '/' ? 'index.html' : u);
      if (!p.startsWith(APP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Mock bridge, injected before the app loads. window.__mock tunes behaviour (delays, failures, payload overrides).
const BRIDGE = () => {
  window.__calls = [];
  window.__mock = window.__mock || {};
  const M = () => window.__mock;
  const copy = (x) => { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return String(x); } };
  const log = (name, arg) => window.__calls.push({ name, arg: copy(arg) });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const photoResult = (p) => ({
    model: 'claude-opus-5-5',
    photos: p.photos.map((ph) => ({
      index: ph.index, title: 'AI title ' + ph.index, caption: 'AI caption ' + ph.index, view: 'RH side',
      damages: [
        { label: 'Scoring ' + ph.index, component_code: 'DR001', component_name: 'Front door shell', side: 'R', damage_type: 'scoring', severity: 'moderate', accident_related: 'yes', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, recommended_operation: 'repair medium', confidence: 0.8, notes: '' },
        { label: 'Old chip', component_code: 'FW001', component_name: 'Front wing', side: 'R', damage_type: 'scratch', severity: 'minor', accident_related: 'no - pre-existing / wear', box: { x: 0.6, y: 0.5, w: 0.1, h: 0.1 }, recommended_operation: 'none', confidence: 0.6, notes: 'stone chip' }
      ]
    })),
    summary: { impact_type: 'Sideswipe / lateral side contact', primary_area: 'RH front door', secondary_areas: 'RH rear door', direction_of_contact: 'Rear to front', damage_pattern: 'Longitudinal scoring along the RH side.', consistency_with_circumstances: 'Consistent with the reported sideswipe.',
      structural_concern: false, structural_notes: 'No structural damage visible.', mechanical_checks: ['RH front hub / bearing'], adas_and_calibration: ['Mirror camera check'], zones: ['RH front door', 'RH sill'] },
    suggested_lines: [
      { type: 'Body', code: 'MR001', side: 'R', description: 'RH door mirror assembly – renew', labour_hours: 0.6, needs_part: true, cost_class: 'parts', reason: 'Photo 1 shows the broken mirror housing.', confidence: 0.9 },
      { type: 'Body', code: 'DR001', side: 'R', description: 'RH front door – repair (medium) / metal finish', labour_hours: 2.0, needs_part: false, cost_class: 'labour only', reason: 'Photos 1 and 2: scoring and a shallow dent.', confidence: 0.8 },
      { type: 'Painting', code: 'DR001', side: 'R', description: 'RH front door – refinish repaired part', labour_hours: 1.6, needs_part: false, cost_class: 'paint', reason: 'Photo 2.', confidence: 0.7 }
    ]
  });
  window.desktop = {
    ai: {
      status: async () => { log('ai.status'); return { hasKey: M().hasKey !== false, encrypted: true }; },
      setKey: async (k) => { log('ai.setKey', !!k); M().hasKey = !!k; return { ok: true }; },
      test: async (p) => { log('ai.test', p); await delay(30); return { ok: true, result: { ok: true, model: (p && p.model) || 'claude-opus-5-5' } }; },
      analysePhotos: async (p) => {
        log('ai.analysePhotos', { n: p.photos.length, idx: p.photos.map((x) => x.index), titles: p.photos.map((x) => x.title), model: p.model, effort: p.effort, jobPhotos: (p.job.photos || []).map((x) => x.index), hasSig: !!(p.job.assessor && p.job.assessor.signature), hasIssued: 'issued' in p.job });
        await delay(M().aiDelay || 30);
        return M().aiFail ? { ok: false, error: 'The AI service rejected the request: test failure' } : { ok: true, result: photoResult(p) };
      },
      draftNarrative: async (p) => {
        const tag = M().draftTag || 'DRAFT1';
        log('ai.draftNarrative', { tag, net: p.totals.net, photos: (p.job.photos || []).map((x) => x.index + ':' + x.title), model: p.model });
        await delay(M().aiDelay || 30);
        return { ok: true, result: { model: 'claude-opus-5-5', summary: tag + ' summary', inspection_condition: tag + ' condition', structural: tag + ' structural', mechanical: tag + ' mechanical', wheels: tag + ' wheels', geometry: tag + ' geometry', diagnostics: tag + ' diagnostics', roadworthiness: tag + ' roadworthiness', estimate_notes: tag + ' estimate notes', valuation_comments: tag + ' valuation', opinion: tag + ' opinion', decision: 'Repair', category: '', review_flags: ['Check the RH sill concealed area'] } };
      },
      valuation: async (p) => {
        log('ai.valuation', { searchWeb: p.searchWeb, mot: (p.motHistory || []).length, reg: p.job.vehicle.reg });
        await delay(M().aiDelay || 30);
        return { ok: true, result: { model: 'claude-opus-5-5', searched: !!p.searchWeb, recommended_pav: 5700.4, range_low: 5300, range_high: 5900, basis: 'Highest retail guide supported by adverts', guide_assessment: 'Glass\'s is highest.', mileage_assessment: 'Mileage consistent with MOT history.',
          adjustments: [{ item: 'Tyres', amount: -50, reason: 'worn' }],
          comparables: [
            { description: 'Nissan Juke Acenta 1.6', year: '2014', mileage: 60000, price: 5995, source: 'AutoTrader', url: 'https://www.autotrader.co.uk/car-details/1', like_for_like: true, notes: 'dealer' },
            { description: 'Nissan Juke Tekna', year: '2014', mileage: 70000, price: 5495, source: 'Evil site', url: 'file://attacker-host/share/x.exe', like_for_like: false, notes: 'injected' },
            { description: 'Nissan Juke Visia', year: '2015', mileage: 50000, price: 5800, source: 'Other', url: 'ms-msdt:/id PCWDiagnostic', like_for_like: false, notes: '' }
          ],
          flags: ['Check service history'], comments: 'AI valuation comments **£5,700**' } };
      }
    },
    data: {
      status: async () => { log('data.status'); return { dvla: M().dvla !== false, mot: M().mot !== false, motTokenUrl: true, encrypted: true }; },
      setKeys: async (patch) => { log('data.setKeys', Object.keys(patch || {})); return { ok: true }; },
      dvla: async (reg, env) => {
        log('data.dvla', { reg, env });
        await delay(M().dataDelay || 20);
        if (M().dvlaFail) return { ok: false, error: 'DVLA refused the API key (403).' };
        return { ok: true, result: Object.assign({ registrationNumber: String(reg).replace(/\s/g, ''), make: 'NISSAN', colour: 'RED', fuelType: 'PETROL', engineCapacity: 1598, co2Emissions: 139, euroStatus: 'EURO 5', realDrivingEmissions: '', yearOfManufacture: 2014, firstRegistration: '2014-08-01', firstRegistrationWithDvla: '', importedOrReRegistered: false,
          taxStatus: 'Taxed', taxDueDate: '2027-01-01', artEndDate: '', motStatus: 'Valid', motExpiry: '2027-02-01', markedForExport: false, markedAsScrapped: false, vehicleStatus: '', typeApproval: 'M1', wheelPlan: '2 AXLE RIGID BODY', revenueWeight: '', dateOfLastV5CIssued: '2020-01-01', automatedVehicle: false }, M().dvlaOver || {}) };
      },
      mot: async (id, by) => {
        log('data.mot', { id, by });
        await delay(M().dataDelay || 20);
        return { ok: true, result: Object.assign({ registration: id, make: 'NISSAN', model: 'JUKE', fuelType: 'Petrol', primaryColour: 'Red', engineSize: '1598', firstUsedDate: '2014-08-05', registrationDate: '2014-08-05', manufactureDate: '2014-07-20', motTestDueDate: '', recall: 'No',
          tests: [{ date: '2025-08-01', result: 'PASSED', odometer: 60000, unit: 'mi', odometerResult: 'READ', expiry: '2026-08-01', testNumber: '1', defects: ['ADVISORY: Nearside front tyre worn close to legal limit'] },
            { date: '2024-08-01', result: 'FAILED', odometer: 52000, unit: 'mi', odometerResult: 'READ', expiry: '', testNumber: '2', defects: ['MAJOR: Headlamp aim too high'] }] }, M().motOver || {}) };
      }
    },
    exportPdf: async (p) => { log('exportPdf', { htmlLen: p.html.length, header: !!p.header, footer: !!p.footer, fileName: p.fileName }); return { ok: true, filePath: 'C:/Reports/' + p.fileName + '.pdf' }; },
    saveFile: async (p) => { log('saveFile', { fileName: p.fileName, len: p.content.length }); window.__lastSaved = p.content; return { ok: true, filePath: 'C:/Reports/' + p.fileName }; }
  };
};

async function open(opts) {
  opts = opts || {};
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const dialogs = [];
  if (opts.bridge !== false) await context.addInitScript(BRIDGE);
  if (opts.mock) await context.addInitScript((m) => { window.__mock = Object.assign(window.__mock || {}, m); }, opts.mock);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  const api = { dialogMode: 'accept' };
  page.on('dialog', async (d) => { dialogs.push(d.message()); await (api.dialogMode === 'dismiss' ? d.dismiss() : d.accept()); });
  const url = `http://127.0.0.1:${port}/index.html`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#main').innerHTML.length > 0);
  // IndexedDB helpers (no eval: the app's CSP forbids it inside the page)
  const idb = (op, store, arg) => page.evaluate(([o, st, a]) => new Promise((res, rej) => {
    const r = indexedDB.open('engineer-report-studio');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(st, o === 'put' ? 'readwrite' : 'readonly');
      const os = tx.objectStore(st);
      const q = o === 'get' ? os.get(a) : o === 'all' ? os.getAll() : os.put(a);
      q.onsuccess = () => { const v = q.result; tx.oncomplete = () => { db.close(); res(o === 'put' ? true : v); }; };
      q.onerror = () => rej(q.error);
    };
  }), [op, store, arg]);
  const getJob = (id) => idb('get', 'jobs', id);
  const putJob = (job) => idb('put', 'jobs', job);
  const listJobs = () => idb('all', 'jobs');
  const getKv = (k) => idb('get', 'kv', k);
  const toast = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.classList.contains('hidden') ? '' : t.textContent; });
  const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => !n || c.name === n), name);
  const jobId = () => page.evaluate(() => (location.hash.match(/#\/job\/([^/]+)/) || [])[1]);
  const settle = (ms) => page.waitForTimeout(ms || 150);
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await settle(250); };
  const mock = (m) => page.evaluate((x) => Object.assign(window.__mock, x), m);
  const close = async () => { await browser.close(); srv.close(); };
  return Object.assign(api, { page, browser, context, errors, dialogs, close, toast, calls, getJob, putJob, listJobs, getKv, jobId, settle, go, mock, url });
}

module.exports = { open, serve, BRIDGE };
