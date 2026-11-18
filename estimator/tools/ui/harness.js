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
  // Replies in the shape of the current ai.js: lines carry operation / guide_hours / hours_basis; photos echo the id sent and may
  // carry unplaced_damages (never drawn); review_flags; comparables carry verified / claimed_url.
  const DEFAULT_LINES = [
    { type: 'Body', code: 'MR001', operation: 'renew', side: 'R', description: 'RH door mirror assembly – renew', guide_hours: 0.6, labour_hours: 0.6, hours_basis: 'guide', needs_part: true, cost_class: 'parts', reason: 'Photo 1 shows the broken mirror housing.', confidence: 0.9 },
    { type: 'Body', code: 'DR001', operation: 'repair', side: 'R', description: 'RH front door – repair (medium) / metal finish', guide_hours: 2.0, labour_hours: 2.0, hours_basis: 'guide', needs_part: false, cost_class: 'labour only', reason: 'Photos 1 and 2: scoring and a shallow dent.', confidence: 0.8 },
    { type: 'Painting', code: 'DR001', operation: 'refinishRep1', side: 'R', description: 'RH front door – refinish repaired part', guide_hours: 2.0, labour_hours: 1.6, hours_basis: 'adjusted', needs_part: false, cost_class: 'paint', reason: 'Photo 2: the damage covers well under half the panel.', confidence: 0.7 }
  ];
  const b64bytes = (s) => { const b = String(s || '').replace(/^data:[^,]*,/, ''); return Math.floor(b.length * 3 / 4) - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0); };
  const photoResult = (p) => {
    const first = p.photos[0].index;
    const lines = (M().linesByBatch && M().linesByBatch[String(first)]) || DEFAULT_LINES;
    const unplaced = M().unplaced !== false;
    return {
      model: 'claude-opus-5-5',
      photos: p.photos.map((ph, k) => Object.assign({
        index: ph.index, title: 'AI title ' + ph.index, caption: 'AI caption ' + ph.index, view: 'RH side',
        damages: [
          { label: 'Scoring ' + ph.index, component_code: 'DR001', component_name: 'Front door shell', side: 'R', damage_type: 'scoring', severity: 'moderate', accident_related: 'yes', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, recommended_operation: 'repair medium', confidence: 0.8, notes: '' },
          { label: 'Old chip', component_code: 'FW001', component_name: 'Front wing', side: 'R', damage_type: 'scratch', severity: 'minor', accident_related: 'no - pre-existing / wear', box: { x: 0.6, y: 0.5, w: 0.1, h: 0.1 }, recommended_operation: 'none', confidence: 0.6, notes: 'stone chip' }
        ]
      }, ph.id != null ? { id: ph.id } : {}, unplaced && k === 0 ? { unplaced_damages: [{ label: 'Hidden crease ' + ph.index, component_code: 'SS002', component_name: 'Sill outer panel', side: 'R', damage_type: 'crease', severity: 'moderate', accident_related: 'likely', recommended_operation: 'repair medium', confidence: 0.5, notes: 'lower edge of the photo' }] } : {})),
      summary: { impact_type: 'Sideswipe / lateral side contact', primary_area: 'RH front door', secondary_areas: 'RH rear door', direction_of_contact: 'Rear to front', damage_pattern: 'Longitudinal scoring along the RH side.', consistency_with_circumstances: 'Consistent with the reported sideswipe.',
        structural_concern: false, structural_notes: 'No structural damage visible.', mechanical_checks: ['RH front hub / bearing'], adas_and_calibration: ['Mirror camera check'], zones: ['RH front door', 'RH sill'] },
      suggested_lines: JSON.parse(JSON.stringify(lines)),
      review_flags: ['Confirm the ADAS fit from the VIN: a mirror camera may be fitted.'].concat(unplaced ? [`Photo ${first}: one damage label (Hidden crease ${first}) could not be placed on the photo because the AI's box was outside the image or unreadable. Draw it if needed.`] : [])
    };
  };
  // the per-photo checks ai.js makes before uploading (prepareImages)
  const aiImageError = (photos) => {
    for (const x of photos) {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(x.mediaType)) return `Photo ${x.index} is not a JPEG, PNG, GIF or WebP image.`;
      if (b64bytes(x.base64) > 7000000) return `Photo ${x.index} is too large to send to the AI (${(b64bytes(x.base64) / 1e6).toFixed(1)} MB; the limit is 7.0 MB per photo).`;
      if ((x.width || 0) > 8000 || (x.height || 0) > 8000) return `Photo ${x.index} is ${x.width} × ${x.height} pixels; the AI accepts at most 8000 pixels on each side.`;
    }
    return '';
  };
  const claimKey = (s) => { const k = String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-'); return ['own-insurer', 'third-party', 'court'].includes(k) ? k : ''; };
  const protection = (which) => M()[which] || 'os';
  window.desktop = {
    ai: {
      status: async () => { log('ai.status'); return Object.assign({ ok: true, hasKey: M().hasKey !== false, encrypted: protection('aiProtection') === 'os', protection: protection('aiProtection') }, M().aiStatusError ? { error: M().aiStatusError } : {}); },
      setKey: async (k) => {
        log('ai.setKey', !!k);
        if (M().setKeyError) return { ok: false, error: M().setKeyError };
        M().hasKey = !!k;
        return k ? { ok: true, encrypted: protection('aiProtection') === 'os', protection: protection('aiProtection') } : { ok: true };
      },
      test: async (p) => { log('ai.test', p); await delay(30); return { ok: true, result: { ok: true, model: (p && p.model) || 'claude-opus-5-5' } }; },
      analysePhotos: async (p) => {
        log('ai.analysePhotos', {
          n: p.photos.length, idx: p.photos.map((x) => x.index), ids: p.photos.map((x) => x.id), titles: p.photos.map((x) => x.title),
          titleByAi: p.photos.map((x) => x.titleByAi), captionByAi: p.photos.map((x) => x.captionByAi), wh: p.photos.map((x) => [x.width, x.height]),
          types: p.photos.map((x) => x.mediaType), bytes: p.photos.map((x) => b64bytes(x.base64)), sig: p.photos.map((x) => String(x.base64).length + ':' + String(x.base64).slice(0, 40) + ':' + String(x.base64).slice(-40)),
          model: p.model, effort: p.effort, jobPhotos: (p.job.photos || []).map((x) => x.index), adas: p.job.vehicle && p.job.vehicle.adas, aiText: p.job.aiText,
          hasSig: !!(p.job.assessor && p.job.assessor.signature), hasIssued: 'issued' in p.job
        });
        await delay(M().aiDelay || 30);
        if (M().aiFail) return { ok: false, error: 'The AI service rejected the request: test failure' };
        // one batch fails (rate limit / overload), named by the figure number of its first photo
        if (M().failBatchAt != null && p.photos[0] && p.photos[0].index === M().failBatchAt) return { ok: false, error: 'The AI service is overloaded (529). Try again in a few minutes.' };
        const bad = aiImageError(p.photos);
        return bad ? { ok: false, error: bad } : { ok: true, result: photoResult(p) };
      },
      draftNarrative: async (p) => {
        const tag = M().draftTag || 'DRAFT1';
        log('ai.draftNarrative', { tag, net: p.totals.net, photos: (p.job.photos || []).map((x) => x.index + ':' + x.title), model: p.model, aiText: p.job.aiText, adas: p.job.vehicle && p.job.vehicle.adas,
          prov: (p.job.photos || []).map((x) => ({ index: x.index, titleByAi: x.titleByAi, captionByAi: x.captionByAi, labels: (x.labels || []).map((l) => [l.text, l.ai]) })) });
        await delay(M().aiDelay || 30);
        return { ok: true, result: { model: 'claude-opus-5-5', summary: tag + ' summary', inspection_condition: tag + ' condition', structural: tag + ' structural', mechanical: tag + ' mechanical', wheels: tag + ' wheels', geometry: tag + ' geometry', diagnostics: tag + ' diagnostics', roadworthiness: tag + ' roadworthiness', estimate_notes: tag + ' estimate notes', valuation_comments: tag + ' valuation', opinion: tag + ' opinion', decision: 'Repair', category: '', review_flags: ['Check the RH sill concealed area'] } };
      },
      valuation: async (p) => {
        log('ai.valuation', { searchWeb: p.searchWeb, mot: (p.motHistory || []).length, reg: p.job.vehicle.reg, claimType: p.claimType, valuationDate: p.valuationDate, aiText: p.job.aiText });
        await delay(M().aiDelay || 30);
        // as ai.js: a comparable keeps its url only when verified; otherwise url '' and the model's URL as claimed_url (text only)
        return { ok: true, result: { model: 'claude-opus-5-5', searched: !!p.searchWeb, searches: p.searchWeb ? 2 : 0, search_domains_restricted: !!p.searchWeb && M().domainsRestricted !== false,
          claim_type: claimKey(p.claimType), valuation_date: p.valuationDate || '',
          recommended_pav: 5700.4, range_low: 5300, range_high: 5900, basis: 'Highest retail guide supported by adverts', guide_assessment: 'Glass\'s is highest.', mileage_assessment: 'Mileage consistent with MOT history.',
          adjustments: [{ item: 'Tyres', amount: -50, reason: 'worn' }],
          comparables: [
            { description: 'Nissan Juke Acenta 1.6', year: '2014', mileage: 60000, price: 5995, source: 'AutoTrader', url: 'https://www.autotrader.co.uk/car-details/1', like_for_like: true, notes: 'dealer', verified: true },
            { description: 'Nissan Juke Tekna', year: '2014', mileage: 70000, price: 5495, source: 'Evil site', url: '', claimed_url: 'file://attacker-host/share/x.exe', like_for_like: false, notes: 'injected', verified: false },
            { description: 'Nissan Juke Visia', year: '2015', mileage: 50000, price: 5800, source: 'Other', url: '', claimed_url: 'ms-msdt:/id PCWDiagnostic', like_for_like: false, notes: '', verified: false },
            { description: 'Nissan Juke N-Connecta', year: '2015', mileage: 48000, price: 6100, source: 'Motors', url: '', claimed_url: 'https://www.motors.co.uk/car-123456/', like_for_like: true, notes: 'not in the search results', verified: false }
          ],
          flags: ['Check service history'], comments: 'AI valuation comments **£5,700**' } };
      }
    },
    data: {
      status: async () => {
        log('data.status');
        const st = { ok: true, dvla: !M().dataUnreadable && M().dvla !== false, mot: !M().dataUnreadable && M().mot !== false, motTokenUrl: true, encrypted: protection('dataProtection') === 'os', protection: protection('dataProtection') };
        return M().dataUnreadable ? Object.assign(st, { unreadable: true, error: 'The saved DVLA / MOT History credentials could not be read (they were saved on another PC or user account). Enter them again after choosing "Remove all saved credentials", or try again if the file was only busy.' }) : st;
      },
      setKeys: async (patch) => {
        log('data.setKeys', Object.keys(patch || {}));
        if (M().dataUnreadable) return { ok: false, code: 'unreadable', error: 'The saved credentials cannot be read, so they cannot be changed. Choose "Remove all saved credentials" first.' };
        if (M().setKeysError) return { ok: false, error: M().setKeysError };
        return { ok: true, encrypted: protection('dataProtection') === 'os', protection: protection('dataProtection') };
      },
      clearKeys: async () => { log('data.clearKeys'); M().dataUnreadable = false; M().dvla = false; M().mot = false; return { ok: true }; },
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
    // exportDelay: how long the save dialog stays open (a double click lands while the first one is still running)
    exportPdf: async (p) => { log('exportPdf', { htmlLen: p.html.length, header: !!p.header, footer: !!p.footer, fileName: p.fileName, marginsMm: p.marginsMm }); await delay(M().exportDelay || 0); return { ok: true, filePath: 'C:/Reports/' + p.fileName + '.pdf' }; },
    saveFile: async (p) => {
      log('saveFile', { fileName: p.fileName, len: p.content.length, kind: p.kind });
      await delay(M().exportDelay || 0);
      if (M().saveError) return { ok: false, error: M().saveError };
      window.__lastSaved = p.content; return { ok: true, filePath: 'C:/Reports/' + p.fileName };
    },
    // Streaming backup as main.js does it (one open backup per window, chunks of at most 64 Mi characters, a write or end error
    // stops the backup), held in memory: window.__lastBackup is the finished file, window.__backupChunks its chunk sizes.
    backup: (() => {
      let open = null, seq = 0;
      return {
        begin: async (p) => {
          log('backup.begin', { fileName: p && p.fileName });
          if (M().backupCancel) return { ok: false, canceled: true };
          if (M().backupBeginError) return { ok: false, error: M().backupBeginError };
          if (open) return { ok: false, error: 'A backup is already being written.' };
          open = { id: 'bk' + (++seq), fileName: String((p && p.fileName) || 'backup.ersbackup'), chunks: [], writes: 0 };
          return { ok: true, id: open.id };
        },
        write: async (id, chunk) => {
          if (!open || open.id !== id) return { ok: false, error: 'There is no backup being written.' };
          if (typeof chunk !== 'string') return { ok: false, error: 'There is nothing to write.' };
          if (chunk.length > 64 * 1024 * 1024) { open = null; return { ok: false, error: 'A piece of the backup is too large.' }; }
          open.writes++;
          log('backup.write', { id, len: chunk.length, n: open.writes });
          if (M().backupWriteError && open.writes >= (M().backupFailAtWrite || 1)) { open = null; return { ok: false, error: M().backupWriteError }; }
          open.chunks.push(chunk);
          await delay(M().backupDelay || 0);
          return { ok: true };
        },
        end: async (id) => {
          if (!open || open.id !== id) return { ok: false, error: 'There is no backup being written.' };
          const b = open; open = null;
          window.__lastBackup = b.chunks.join(''); window.__lastBackupName = b.fileName; window.__backupChunks = b.chunks.map((c) => c.length);
          log('backup.end', { id, len: window.__lastBackup.length, writes: b.chunks.length });
          return { ok: true, filePath: 'C:/Backups/' + b.fileName };
        },
        abort: async (id) => { log('backup.abort', { id }); if (open && open.id === id) open = null; return { ok: true }; }
      };
    })(),
    app: { info: async () => { log('app.info'); return { ok: true, dataFolder: 'C:\\Users\\Assessor\\AppData\\Roaming\\Engineer Report Studio' }; } }
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
  if (opts.init) await context.addInitScript(opts.init); // e.g. storage that cannot be opened
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
      const tx = db.transaction(st, o === 'put' || o === 'putkv' ? 'readwrite' : 'readonly');
      const os = tx.objectStore(st);
      const q = o === 'get' ? os.get(a) : o === 'all' ? os.getAll() : o === 'putkv' ? os.put(a[1], a[0]) : os.put(a);
      q.onsuccess = () => { const v = q.result; tx.oncomplete = () => { db.close(); res(o === 'put' || o === 'putkv' ? true : v); }; };
      q.onerror = () => rej(q.error);
    };
  }), [op, store, arg]);
  const getJob = (id) => idb('get', 'jobs', id);
  const putJob = (job) => idb('put', 'jobs', job);
  const listJobs = () => idb('all', 'jobs');
  const getKv = (k) => idb('get', 'kv', k);
  const putKv = (k, v) => idb('putkv', 'kv', [k, v]);
  const toast = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.classList.contains('hidden') ? '' : t.textContent; });
  const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => !n || c.name === n), name);
  const jobId = () => page.evaluate(() => (location.hash.match(/#\/job\/([^/]+)/) || [])[1]);
  const settle = (ms) => page.waitForTimeout(ms || 150);
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await settle(250); };
  const mock = (m) => page.evaluate((x) => Object.assign(window.__mock, x), m);
  const close = async () => { await browser.close(); srv.close(); };
  return Object.assign(api, { page, browser, context, errors, dialogs, close, toast, calls, getJob, putJob, listJobs, getKv, putKv, jobId, settle, go, mock, url });
}

module.exports = { open, serve, BRIDGE };
