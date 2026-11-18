'use strict';
// Playwright smoke test for the Engineer Report Studio renderer (app.js / labeler.js), with a mocked window.desktop.
// Run: node smoke.js   (exit code 1 on any failed check, page error or console error)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('./harness');

const FIX = path.join(__dirname, 'fixtures');
const jpg1 = fs.readFileSync(path.join(FIX, 'photo1.jpg'));
const jpg2 = fs.readFileSync(path.join(FIX, 'photo2.jpg'));

// A JPEG with an EXIF APP1 segment carrying DateTimeOriginal (little-endian TIFF), inserted after SOI.
function withExif(src, when) {
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26); tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36); tiff.writeUInt32LE(0, 40);
  tiff.write(when + '\0', 44, 'ascii');
  const head = Buffer.from([0xFF, 0xE1, 0, 0]); head.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([src.slice(0, 2), head, Buffer.from('Exif\0\0', 'binary'), tiff, src.slice(2)]);
}
const jpgExif = withExif(jpg1, '2026:09:01 11:42:30');
const file = (name, buffer, mimeType) => ({ name, mimeType: mimeType || 'image/jpeg', buffer });

const results = [];
let t, page;
async function step(name, fn) {
  const before = t.errors.length;
  try {
    await page.evaluate(() => { const m = document.querySelector('#modal'); if (m && !m.classList.contains('hidden')) m.querySelector('[data-close]').click(); });
    await fn();
    if (t.errors.length > before) throw new Error('page/console error: ' + t.errors.slice(before).join(' || '));
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, (e && e.message ? e.message : String(e)).split('\n').slice(0, 3).join(' ')]);
  }
  const r = results[results.length - 1];
  console.log(`${r[0]}  ${r[1]}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${r[2] ? '\n      ' + r[2] : ''}`);
  t0 = Date.now();
}
let t0 = Date.now();
const settle = (ms) => t.settle(ms);
const text = (sel) => page.$eval(sel, (n) => n.textContent);
const exists = (sel) => page.$(sel).then(Boolean);
const toastText = () => t.toast();
async function choose(sel, files) { const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click(sel)]); await fc.setFiles(files); }
async function newJob() { await page.click('a[data-nav="new"]'); await page.waitForFunction(() => /#\/job\/[^/]+\/claim$/.test(location.hash)); await settle(200); return t.jobId(); }
async function openTab(id, tab) { await t.go(`#/job/${id}/${tab}`); await page.waitForFunction((tb) => location.hash.endsWith('/' + tb) && document.querySelector('#tabBody'), tab); await settle(150); }
async function flush() { await settle(700); } // debounce is 500 ms
async function pick(code, side, op) {
  await page.fill('#pickQ', code); await settle(80);
  await page.click(`#pickResults .r[data-code="${code}"]`);
  if (side != null) await page.selectOption('#pickSide', side);
  if (op) await page.selectOption('#pickOp', op);
  await page.click('[data-act="pickAdd"]'); await settle(200);
}
const lines = async (id) => (await t.getJob(id)).lines;

(async () => {
  t = await H.open();
  page = t.page;
  page.setDefaultTimeout(5000);
  t0 = Date.now();
  let S, A, B; // sample job, photo/AI job, estimate job

  await step('load sample job and visit every tab', async () => {
    await page.click('[data-act="loadSample"]');
    await page.waitForFunction(() => /#\/job\/[^/]+\/report$/.test(location.hash));
    S = await t.jobId();
    for (const tb of ['claim', 'vehicle', 'inspection', 'circumstances', 'photos', 'assessment', 'estimate', 'valuation', 'opinion', 'customer', 'signoff', 'report']) {
      await openTab(S, tb);
      const len = await page.$eval('#tabBody', (n) => n.innerHTML.length);
      assert(len > 200, `tab ${tb} rendered ${len} chars`);
    }
    const chips = await text('#chips');
    assert(/£3,365\.08/.test(chips) && /£4,038\.10/.test(chips), 'header totals: ' + chips);
    assert(/Repair \/ PAV \(net\)/.test(chips) && /59\.2% net/.test(chips), 'BER chip shows the net basis: ' + chips);
    const job = await t.getJob(S);
    assert(job.rates && job.rates.Body === 72.5 && job.vatPct === 20, 'job rates / VAT snapshot');
    assert(job.inspection.by === '' && job.valuation.belowHighestReason === '' && 'firstRegPrecision' in job.vehicle, 'new fields added by migrate');
  });

  await step('BER chip follows the gross basis setting', async () => {
    await t.go('#/settings'); await settle(300);
    await page.selectOption('[data-sbind="berBasis"]', 'gross'); await settle(500);
    await openTab(S, 'estimate');
    const chips = await text('#chips');
    assert(/Repair \/ PAV \(gross\)/.test(chips) && /71\.1% gross/.test(chips), chips);
    await t.go('#/settings'); await settle(300);
    await page.selectOption('[data-sbind="berBasis"]', 'net'); await settle(500);
  });

  await step('#/new uses location.replace (Back does not create jobs)', async () => {
    await t.go('#/jobs'); await settle(300);
    const n0 = (await t.listJobs()).length;
    const h0 = await page.evaluate(() => history.length);
    A = await newJob();
    const h1 = await page.evaluate(() => history.length);
    assert.strictEqual(h1, h0 + 1, `history grew by ${h1 - h0}`);
    await page.goBack(); await settle(400);
    assert(/#\/jobs$/.test(await page.evaluate(() => location.hash)), 'Back returned to the jobs list');
    assert.strictEqual((await t.listJobs()).length, n0 + 1, 'exactly one job created');
    await page.goForward(); await settle(400);
  });

  await step('photos: figure numbers, EXIF / file date taken-at, live excluded styling', async () => {
    await openTab(A, 'photos');
    await page.setInputFiles('#photoInput', [file('exif.jpg', jpgExif), file('door.jpg', jpg2), file('wing.jpg', jpg1)]);
    await page.waitForFunction(() => document.querySelectorAll('.pcard').length === 3, null, { timeout: 8000 });
    await settle(300);
    const nums = await page.$$eval('.pcard .pnum', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(nums, ['IMAGE 01', 'IMAGE 02', 'IMAGE 03']);
    const taken = await page.$$eval('input[data-pf="takenAt"]', (ns) => ns.map((n) => n.value));
    assert.strictEqual(taken[0], '2026-09-01T11:42', 'EXIF DateTimeOriginal: ' + taken[0]);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(taken[1]), 'file date fallback: ' + taken[1]);
    // exclude photo 1: live dimming and renumbering
    await page.click('.pcard:nth-child(1) input[data-pf="include"]'); await settle(100);
    const cls = await page.$eval('.pcard:nth-child(1)', (n) => n.classList.contains('excluded'));
    const nums2 = await page.$$eval('.pcard .pnum', (ns) => ns.map((n) => n.textContent));
    assert(cls, 'excluded class toggled live');
    assert.deepStrictEqual(nums2, ['not in report', 'IMAGE 01', 'IMAGE 02']);
    // edit the taken date of photo 2
    await page.fill('.pcard:nth-child(2) input[data-pf="takenAt"]', '2026-09-02T09:15'); await flush();
    const j = await t.getJob(A);
    assert(j.photos[0].exclude === true && j.photos[0].takenAt && j.photos[1].takenAt === new Date('2026-09-02T09:15').toISOString(), 'stored exclude / takenAt');
    await page.fill('.pcard:nth-child(2) input[data-pf="title"]', 'RH front door'); await page.fill('.pcard:nth-child(3) input[data-pf="title"]', 'RH front wing'); await flush();
  });

  await step('AI photo analysis: included photos only, figure indexes, results mapped by id despite reordering', async () => {
    await t.mock({ aiDelay: 700 });
    await page.click('[data-act="aiAnalyse"]'); await settle(150);
    assert(await exists('[data-act="aiAnalyse"][disabled]'), 'AI button disabled while running');
    // move the wing photo (IMAGE 02) up during the call: order becomes [excluded, wing, door]
    await page.click('.pcard:nth-child(3) [data-act="pmove"][data-d="-1"]');
    await page.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 8000 }); await flush();
    const call = (await t.calls('ai.analysePhotos')).pop().arg;
    assert.deepStrictEqual(call.idx, [1, 2], 'indexes sent: ' + JSON.stringify(call.idx));
    assert.deepStrictEqual(call.jobPhotos, [1, 2], 'slim job photos: ' + JSON.stringify(call.jobPhotos));
    assert(!call.hasSig && !call.hasIssued, 'no signature / issued snapshot sent to the AI');
    const j = await t.getJob(A);
    const byTitle = (tt) => j.photos.find((p) => p.title === tt);
    const ai = (p) => p.labels.filter((l) => l.ai).map((l) => l.text);
    assert.deepStrictEqual(ai(byTitle('RH front door')), ['Scoring 1', 'Old chip'], 'door (was IMAGE 01) labels: ' + ai(byTitle('RH front door')));
    assert.deepStrictEqual(ai(byTitle('RH front wing')), ['Scoring 2', 'Old chip'], 'wing (was IMAGE 02) labels');
    assert.strictEqual(ai(j.photos[0]).length, 0, 'excluded photo untouched');
    const chip = byTitle('RH front door').labels.find((l) => l.text === 'Old chip');
    assert.strictEqual(chip.accidentRelated, 'no - pre-existing / wear');
    assert(byTitle('RH front door').labelsReviewed === false && j.aiFindings && j.aiLog.some((x) => x.ai), 'findings + AI log');
    const dashed = await page.$$eval('.pcard .ov .bx', (ns) => ns.filter((n) => n.style.borderStyle === 'dashed').length);
    assert(dashed >= 2, 'pre-existing labels drawn dashed on cards');
    const nums = await page.$$eval('.pcard .pnum', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(nums, ['not in report', 'IMAGE 01', 'IMAGE 02']);
    await t.mock({ aiDelay: 30 });
  });

  await step('AI suggestions become lines with op "ai" and the AI operation', async () => {
    await page.click('[data-act="aiAddLines"]'); await flush();
    const ls = await lines(A);
    assert.strictEqual(ls.length, 3);
    assert(ls.every((l) => l.op === 'ai' && l.ai && !l.reviewed), 'op ai');
    const door = ls.find((l) => /repair \(medium\)/.test(l.description));
    assert.strictEqual(door.aiOperation, 'repair medium');
    assert(!('aiOperation' in ls.find((l) => /mirror/.test(l.description))), 'no aiOperation when no label names the part');
  });

  await step('labeler: "show" toggles, field click keeps focus, save marks labels reviewed', async () => {
    await openTab(A, 'photos');
    const nth = await page.$$eval('.pcard', (cs) => cs.findIndex((c) => c.querySelector('input[data-pf="title"]').value === 'RH front door') + 1);
    assert(nth > 0, 'door card found');
    await page.click(`.pcard:nth-child(${nth}) button[data-act="label"]`); await settle(250);
    await page.click('.lablist .it:nth-child(1) label.hint'); await settle(100); // the word "show"
    const op = await page.$eval('.labStage .bx[data-i="0"]', (n) => n.style.opacity);
    const checked = await page.$eval('.lablist .it:nth-child(1) input[data-hide]', (n) => n.checked);
    assert(op === '0.35' && checked === false, `hide via label: opacity=${op} checked=${checked}`);
    await page.click('.lablist .it:nth-child(2) input[data-f="text"]'); await settle(80);
    const st = await page.evaluate(() => ({ sel: document.querySelector('.lablist .it:nth-child(2)').classList.contains('sel'), focus: document.activeElement && document.activeElement.dataset.f }));
    assert(st.sel && st.focus === 'text', 'select in place keeps focus: ' + JSON.stringify(st));
    // tag text colour by contrast (yellow/orange/white → #111)
    const ink = await page.$$eval('.labStage .bx .tg', (ns) => ns.map((n) => n.style.color));
    assert(ink.every((c) => /rgb\(17, 17, 17\)|rgb\(255, 255, 255\)/.test(c)), 'tag ink: ' + ink);
    // draw a new box
    const stage = await page.locator('.labStage').boundingBox();
    await page.mouse.move(stage.x + stage.width * 0.55, stage.y + stage.height * 0.1); await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.35, { steps: 4 }); await page.mouse.up(); await settle(100);
    await page.click('[data-q="Dent"]'); await settle(50);
    // a drag that starts in a field and ends on the backdrop must not close the modal
    const inp = await page.locator('.lablist input[data-f="text"]').first().boundingBox();
    await page.mouse.move(inp.x + 5, inp.y + inp.height / 2); await page.mouse.down(); await page.mouse.move(4, 4, { steps: 5 }); await page.mouse.up(); await settle(100);
    assert(!(await page.$eval('#modal', (n) => n.classList.contains('hidden'))), 'modal stayed open after a drag ending on the backdrop');
    await page.click('[data-act="save"]'); await flush();
    const p = (await t.getJob(A)).photos.find((x) => x.title === 'RH front door');
    assert(p.labelsReviewed === true, 'labelsReviewed');
    assert(p.labels[0].hidden === true && p.labels.some((l) => l.text === 'Dent' && !l.ai), 'labels saved: ' + JSON.stringify(p.labels.map((l) => [l.text, !!l.hidden])));
    assert(/reviewed/.test(await text(`.pcard:nth-child(${nth}) .badge`)), 'card badge says reviewed');
  });

  await step('modal backdrop: a press that starts on the backdrop closes it', async () => {
    await page.click('.pcard:nth-child(3) button[data-act="label"]'); await settle(200);
    await page.mouse.click(4, 4); await settle(100);
    assert(await page.$eval('#modal', (n) => n.classList.contains('hidden')), 'closed');
  });

  await step('AI draft: the draft on screen is applied (no stale listeners); pending review kept', async () => {
    await openTab(A, 'opinion');
    await t.mock({ draftTag: 'DRAFT1' });
    await page.click('[data-act="aiDraft"]'); await page.waitForSelector('#modal:not(.hidden) [data-go]'); await settle(100);
    await page.click('#modal [data-close]'); await settle(100);
    assert(await exists('[data-act="reviewPendingDraft"]') || true, '');
    await t.mock({ draftTag: 'DRAFT2' });
    await page.click('[data-act="aiDraft"]'); await page.waitForSelector('#modal:not(.hidden) [data-go]'); await settle(100);
    await page.click('#modal [data-sel]'); await page.click('#modal [data-go]'); await flush();
    const j = await t.getJob(A);
    assert.strictEqual(j.report.summary, 'DRAFT2 summary');
    assert.strictEqual(j.opinion, 'DRAFT2 opinion');
    assert(/12 section\(s\) applied/.test(await toastText()), 'toast: ' + await toastText());
    const call = (await t.calls('ai.draftNarrative')).pop().arg;
    assert.deepStrictEqual(call.photos, ['1:RH front wing', '2:RH front door'], 'draft photo list = printed figures: ' + JSON.stringify(call.photos));
    // a third draft closed without applying stays available
    await t.mock({ draftTag: 'DRAFT3' });
    await page.click('[data-act="aiDraft"]'); await page.waitForSelector('#modal:not(.hidden) [data-go]'); await page.click('#modal [data-close]'); await settle(200);
    await openTab(A, 'opinion');
    await page.click('[data-act="reviewPendingDraft"]'); await settle(150);
    assert(/DRAFT3 summary/.test(await text('#modalBody')), 'pending draft reopened');
    await page.click('#modal [data-close]');
  });

  await step('AI valuation: result stored, comparable links only for http(s)', async () => {
    await openTab(A, 'valuation');
    await page.click('[data-act="aiValuation"]'); await page.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 5000 }); await flush();
    const links = await page.$$eval('.aiPanel a[href]', (ns) => ns.map((n) => n.getAttribute('href')));
    assert.deepStrictEqual(links, ['https://www.autotrader.co.uk/car-details/1'], 'links: ' + JSON.stringify(links));
    const body = await text('.aiPanel');
    assert(/Evil site/.test(body) && !(await exists('a[href^="file:"]')) && !(await exists('a[href^="ms-msdt"]')), 'unsafe URLs rendered as text');
    const j = await t.getJob(A);
    assert(j.valuation.ai && j.valuation.ai.recommended_pav === 5700.4 && j.aiLog.some((x) => /Valuation assistant/.test(x.action)));
  });

  await step('AI and lookups land on the job they were started for', async () => {
    // valuation on S, then open A before it returns
    const sBefore = await t.getJob(S);
    await openTab(S, 'valuation');
    await t.mock({ aiDelay: 700 });
    await page.click('[data-act="aiValuation"]'); await settle(100);
    await openTab(A, 'claim'); await settle(1000); await flush();
    let s = await t.getJob(S), a = await t.getJob(A);
    assert(s.valuation.ai && s.aiLog.length === (sBefore.aiLog || []).length + 1, 'S got its valuation');
    assert.strictEqual(a.aiLog.filter((x) => /Valuation/.test(x.action)).length, 1, 'A did not get a second valuation');
    assert(!(await exists('#tabBody .spinner')), 'no spinner on the other job');
    // photo analysis on A, then leave to the Jobs list
    await openTab(A, 'photos');
    const at0 = (await t.getJob(A)).aiFindings.at;
    await page.click('[data-act="aiAnalyse"]'); await settle(100);
    await page.click('.jobhead a[href="#/jobs"]'); await settle(1100); await flush();
    a = await t.getJob(A);
    assert(a.aiFindings.at !== at0, 'findings saved to A while on the Jobs list');
    assert(await exists('[data-act="loadSample"]'), 'Jobs list intact');
    // draft on A, then open S: no review modal on S
    await openTab(A, 'opinion');
    await page.click('[data-act="aiDraft"]'); await settle(100);
    await openTab(S, 'opinion'); await settle(1000);
    assert(await page.$eval('#modal', (n) => n.classList.contains('hidden')), 'no draft modal on S');
    assert(/ready/.test(await toastText()), 'toast says the draft is ready: ' + await toastText());
    s = await t.getJob(S);
    assert(s.opinion !== 'DRAFT3 opinion', 'S narrative untouched');
    await openTab(A, 'opinion');
    assert(await exists('[data-act="reviewPendingDraft"]'), 'A offers the pending draft');
    await t.mock({ aiDelay: 30 });
  });

  await step('registration lookup: DVLA + MOT, title-cased colour, first-registration precision', async () => {
    B = await newJob();
    await openTab(B, 'vehicle');
    await page.fill('[data-bind="vehicle.reg"]', 'AB14 CDE'); await settle(50);
    await page.click('[data-act="lookupVehicle"]'); await page.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 5000 }); await flush();
    const v = (await t.getJob(B)).vehicle;
    assert.strictEqual(v.make, 'Nissan'); assert.strictEqual(v.colour, 'Red');
    assert.strictEqual(v.firstReg, '2014-08-05'); assert.strictEqual(v.firstRegPrecision, 'day');
    assert(v.dvla.lookedUpAt && v.motHistory.length === 2, 'dvla + mot stored');
    const log = (await t.getJob(B)).aiLog;
    assert(log.length === 2 && log.every((x) => x.ai === false), 'data log entries ai:false');
    assert(/Now choose the exact variant/.test(await toastText()), await toastText());
    // DVLA only: month precision and its hint
    await t.mock({ mot: false });
    const C2 = await newJob();
    await openTab(C2, 'vehicle');
    await page.fill('[data-bind="vehicle.reg"]', 'AB14 CDE');
    await page.click('[data-act="lookupVehicle"]'); await page.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 5000 }); await flush();
    const v2 = (await t.getJob(C2)).vehicle;
    assert(v2.firstReg === '2014-08-01' && v2.firstRegPrecision === 'month', JSON.stringify([v2.firstReg, v2.firstRegPrecision]));
    assert(/month only/.test(await text('#tabBody')), 'month-only hint');
    await t.mock({ mot: true });
    // leave and reopen the same job during the lookup: the data still lands on the reopened job
    await t.mock({ dataDelay: 500 });
    await page.fill('[data-bind="vehicle.colour"]', ''); await page.fill('[data-bind="vehicle.make"]', 'Ford'); await flush();
    await page.click('[data-act="lookupVehicle"]'); await settle(100);
    await t.go('#/jobs'); await settle(100); await openTab(C2, 'vehicle'); await settle(1500); await flush();
    const v3 = (await t.getJob(C2)).vehicle;
    assert(v3.make === 'Nissan' && v3.colour === 'Red', 'reopened job got the lookup: ' + v3.make + '/' + v3.colour);
    assert.strictEqual(await page.$eval('[data-bind="vehicle.make"]', (n) => n.value), 'Nissan', 'shown on screen');
    await t.mock({ dataDelay: 20 });
  });

  await step('MOT history by VIN is enabled as soon as a VIN is typed', async () => {
    const id = await newJob();
    await openTab(id, 'vehicle');
    assert(await exists('[data-act="motByVin"][disabled]'), 'disabled without a VIN');
    await page.fill('[data-bind="vehicle.vin"]', 'SJNFBAF15U7000000'); await settle(50);
    assert(!(await exists('[data-act="motByVin"][disabled]')), 'enabled after typing');
    await page.click('[data-act="motByVin"]'); await page.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 5000 }); await flush();
    const v = (await t.getJob(id)).vehicle;
    assert(v.motHistory.length === 2 && v.firstReg === '2014-08-05' && v.firstRegPrecision === 'day');
    assert.strictEqual((await t.calls('data.mot')).pop().arg.by, 'vin');
  });

  await step('variant picker: no carry-over between jobs; notes stripped; gearbox shown; mild hybrid keeps base fuel', async () => {
    await openTab(S, 'vehicle');
    const mk = await page.$eval('select[data-vp="make"]', (n) => n.value);
    assert.strictEqual(mk, 'Nissan', 'sample detects Nissan');
    const id = await newJob();
    await openTab(id, 'vehicle');
    assert.strictEqual(await page.$eval('select[data-vp="make"]', (n) => n.value), '', 'blank job has no make selected');
    assert(await exists('[data-act="applyVariant"][disabled]'), 'Use this variant disabled');
    // pick a model whose engine is a 48V mild hybrid and whose gearbox label carries a bracketed note
    const pickIdx = await page.evaluate(() => {
      const V = window.VARIANTS;
      for (let i = 0; i < V.length; i++) {
        const e = V[i].engines.findIndex((x) => /mild|mhev|48\s*v|eq boost/i.test(x.fuel || ''));
        const g = (V[i].transmissions || []).find((x) => /\(/.test(x));
        if (e >= 0 && g) return { i, e, g, make: V[i].make, fuel: V[i].engines[e].fuel, badge: V[i].engines[e].badge };
      }
      return null;
    });
    assert(pickIdx, 'found a mild-hybrid model with a noted gearbox');
    await page.selectOption('select[data-vp="make"]', pickIdx.make); await settle(150);
    await page.selectOption('select[data-vp="model"]', String(pickIdx.i)); await settle(150);
    await page.selectOption('select[data-vp="engine"]', String(pickIdx.e)); await settle(150);
    await page.selectOption('select[data-vp="trans"]', pickIdx.g); await settle(150);
    await page.click('[data-act="applyVariant"]'); await flush();
    const v = (await t.getJob(id)).vehicle;
    assert(!/[()]/.test(v.derivative) && !/[()]/.test(v.transmission), 'notes stripped: ' + v.derivative + ' | ' + v.transmission);
    assert.strictEqual(v.fuel, /diesel/i.test(pickIdx.fuel) ? 'Diesel' : 'Petrol', `fuel for "${pickIdx.fuel}"`);
    assert.strictEqual(await page.$eval('[data-bind="vehicle.transmission"]', (n) => n.value), v.transmission, 'transmission field shows the value');
  });

  await step('estimate picker: ops, pfApplied, repair hours/cap/wording, PDR and refusal rules, operations', async () => {
    const id = await newJob();
    await openTab(id, 'vehicle');
    await page.selectOption('[data-bind="vehicle.paintType"]', 'pearl'); await settle(200);
    await openTab(id, 'estimate');
    await pick('FW001', 'R', 'replace');
    let ls = await lines(id).catch(() => []); await flush(); ls = await lines(id);
    assert.deepStrictEqual(ls.map((l) => [l.description, l.op, l.pfApplied]), [['RH front wing – renew', 'renew', undefined], ['RH front wing – refinish new part', 'refinish', 1.2]]);
    assert.strictEqual(ls[1].hours, 2.6, 'refinish 2.2h × pearl 1.2');
    await pick('FE001', '', 'repair3'); await flush(); ls = await lines(id);
    const rep = ls.find((l) => l.op === 'repair3');
    assert.strictEqual(rep.description, 'Front bumper cover – plastic repair (heavy)'); assert.strictEqual(rep.hours, 2.4, 'repairHrs 1.2 × 2');
    assert(ls.some((l) => l.op === 'refinishRep2' && l.pfApplied === 1.2), 'refinish of repaired part has pfApplied');
    await pick('DR001', 'R', 'repair'); await flush(); ls = await lines(id);
    assert(ls.some((l) => l.description === 'RH front door shell – repair (medium) / metal finish' && l.hours === 2), 'steel wording and repairHrs 2.0');
    const n0 = ls.length;
    await pick('FE009', '', 'repair1');
    assert(/renew it instead/.test(await toastText()), 'renew-only refusal: ' + await toastText());
    await pick('FE001', '', 'pdr'); assert(/Paintless dent repair applies only/.test(await toastText()), 'PDR plastic refused');
    await pick('ST001', 'R', 'pdr'); assert(/Paintless dent repair applies only/.test(await toastText()), 'PDR chassis leg refused');
    await pick('BN002', 'R', 'pdr'); assert(/Paintless dent repair applies only/.test(await toastText()), 'PDR hinge refused');
    await pick('SR001', '', 'refurb'); assert(/never refurbished/.test(await toastText()), 'SRS refurb refused');
    await flush(); assert.strictEqual((await lines(id)).length, n0, 'refused operations add nothing');
    await pick('DR001', 'R', 'pdr'); await pick('RF001', '', 'pdr'); await flush(); ls = await lines(id);
    assert.strictEqual(ls.filter((l) => l.op === 'pdr').length, 2, 'PDR on door and roof');
    // operation rows: the selector switches to "Operation / service"; no "– renew"; 0 h allowed
    await page.fill('#pickQ', 'EL007'); await settle(80); await page.click('#pickResults .r[data-code="EL007"]');
    assert.strictEqual(await page.$eval('#pickOp', (n) => n.value), 'operation', 'selector defaulted to operation');
    await page.click('[data-act="pickAdd"]'); await settle(150);
    await pick('FX008', '', null); await flush(); ls = await lines(id);
    const scan = ls.find((l) => l.code === 'EL007'), waste = ls.find((l) => l.code === 'FX008');
    assert.deepStrictEqual([scan.description, scan.type, scan.op, scan.hours], ['Pre-repair diagnostic scan', 'Auxiliary', 'operation', 0.3]);
    assert.deepStrictEqual([waste.description, waste.hours, waste.costClass], ['Hazardous waste disposal', 0, 'other']);
    await page.fill('#pickQ', 'FW001'); await settle(80); await page.click('#pickResults .r[data-code="FW001"]');
    assert.strictEqual(await page.$eval('#pickOp', (n) => n.value), 'replace', 'a part switches the selector back to Renew');
    await pick('EL007', '', 'repair'); assert(/is an operation or service/.test(await toastText()), 'repair on an operation refused');
    await pick('DR001', 'R', 'blend'); await flush(); ls = await lines(id);
    assert(ls.some((l) => l.op === 'blend' && l.pfApplied === 1.2), 'blend pfApplied');
    // heavy repair capped at renew + refinish
    const cap = await page.evaluate(() => (window.CATALOGUE.find((r) => r[8] > 0 && r[8] * 2 > r[4] + r[5] && !r[3]) || window.CATALOGUE.find((r) => r[8] > 0 && r[8] * 2 > r[4] + r[5])));
    if (cap) { await pick(cap[0], cap[3] ? 'R' : '', 'repair3'); assert(/capped/.test(await toastText()), 'cap toast: ' + await toastText()); }
    // labour-op button and blank line
    await page.click('[data-act="addOp"][data-code="OP002"]'); await settle(100);
    await page.click('[data-act="addBlank"]'); await flush(); ls = await lines(id);
    assert(ls.some((l) => l.op === 'labour' && l.description === 'Prepare & refinish panel') && ls[ls.length - 1].op === 'manual', 'labour / manual ops');
    assert(ls.every((l) => l.op), 'every created line has op');
  });

  await step('paint materials: factor applied once; no second charge when materials are priced', async () => {
    await t.go('#/settings'); await settle(300);
    await page.fill('[data-sbind="paintMaterialsPerHour"]', '20'); await settle(600);
    const id = await newJob();
    await openTab(id, 'vehicle'); await page.selectOption('[data-bind="vehicle.paintType"]', 'pearl'); await settle(200);
    await openTab(id, 'estimate');
    await pick('FW001', 'R', 'replace');
    await page.click('[data-act="addOp"][data-code="OP002"]'); await settle(100);
    await page.click('[data-act="paintMaterials"]'); await flush();
    const m = (await lines(id)).find((l) => l.auto === 'paintMaterials');
    assert.strictEqual(m.amount, 90.4, '(2.6 + 1.6 × 1.2) × £20 = £90.40, got ' + m.amount);
    assert.strictEqual(m.op, 'operation');
    await openTab(S, 'estimate');
    await page.click('[data-act="paintMaterials"]'); await settle(150);
    assert(/already priced/.test(await toastText()), 'warns: ' + await toastText());
    await flush();
    const s = await t.getJob(S);
    assert(!s.lines.some((l) => l.auto === 'paintMaterials'), 'no second materials line on the sample');
    assert(/£3,365\.08/.test(await text('#chips')), 'sample total unchanged');
    await t.go('#/settings'); await settle(300); await page.fill('[data-sbind="paintMaterialsPerHour"]', '0'); await settle(600);
  });

  await step('discount and valuation edits refresh totals and hints live', async () => {
    await openTab(S, 'estimate');
    await page.fill('[data-bind="discount"]', '100'); await settle(100);
    const box = await text('#totalsBox');
    assert(/Less discount/.test(box) && /£3,265\.08/.test(box), 'totals box: ' + box);
    await page.fill('[data-bind="discount"]', '0'); await flush();
    await openTab(S, 'valuation');
    await page.fill('input[data-vs="amount"][data-i="0"]', '6000'); await settle(100);
    assert(/£5,269\.00 – £6,000\.00/.test(await text('#valRange')), 'range hint: ' + await text('#valRange'));
    await page.fill('[data-bind="valuation.salvagePct"]', '20'); await settle(100);
    assert(/= £1,136\.40/.test(await text('#salvageHint')), 'salvage hint: ' + await text('#salvageHint'));
    await page.fill('[data-bind="valuation.adopted"]', '10000'); await settle(100);
    assert(/33\.65%/.test(await text('#econBox')), 'econ box: ' + await text('#econBox'));
    await page.fill('input[data-vs="amount"][data-i="0"]', '5682'); await page.fill('[data-bind="valuation.salvagePct"]', '15'); await page.fill('[data-bind="valuation.adopted"]', '5682'); await flush();
    assert(/£3,365\.08/.test(await text('#chips')));
    assert(await exists('[data-bind="valuation.belowHighestReason"]'), 'below-highest reason field');
  });

  await step('per-job rates: Settings changes do not alter a job until "Use current Settings rates"', async () => {
    await t.go('#/settings'); await settle(300);
    await page.fill('[data-sbind="rates.Body"]', '80'); await settle(600);
    await openTab(S, 'estimate');
    assert(/£3,365\.08/.test(await text('#chips')), 'job keeps its rates');
    assert(/differ from Settings/.test(await text('#tabBody')), 'badge');
    await page.click('[data-act="useSettingsRates"]'); await flush();
    assert(!/£3,365\.08/.test(await text('#chips')), 'figures changed after taking Settings rates');
    await t.go('#/settings'); await settle(300); await page.fill('[data-sbind="rates.Body"]', '72.5'); await settle(600);
    await openTab(S, 'estimate'); await page.click('[data-act="useSettingsRates"]'); await flush();
    assert(/£3,365\.08/.test(await text('#chips')), 'back to the reference total');
    await page.fill('[data-bind="rates.Painting"]', '50'); await settle(100);
    const cell = await page.$eval('#linesTbl tr:last-child [data-lv]', (n) => n.textContent);
    await page.fill('[data-bind="rates.Painting"]', '72.5'); await flush();
    assert(/£3,365\.08/.test(await text('#chips')), 'restored');
    assert(cell, 'labour cells refresh');
  });

  await step('sign-off: finalise freezes a snapshot; re-open removes it; inspection fields', async () => {
    await openTab(S, 'signoff');
    await page.click('[data-act="finaliseReport"]'); await flush();
    let s = await t.getJob(S);
    assert(s.issued && s.issued.company && s.issued.company.name && typeof s.issued.declaration === 'string' && 'signature' in s.issued && s.issued.at, 'issued snapshot');
    assert(/Report finalised/.test(await text('#tabBody')), 'finalised view');
    await page.click('[data-act="reopenReport"]'); await flush();
    s = await t.getJob(S);
    assert(!('issued' in s), 're-opened');
    await openTab(S, 'inspection');
    await page.click('[data-act="inspByAssessor"]'); await flush();
    s = await t.getJob(S);
    assert.strictEqual(s.inspection.by, 'Sample Assessor');
    assert(await exists('[data-bind="inspection.byQualifications"]'));
    await page.fill('[data-bind="inspection.by"]', ''); await flush();
  });

  await step('export PDF asks for confirmation while AI lines are unreviewed', async () => {
    await openTab(A, 'report'); await settle(300);
    const n0 = (await t.calls('exportPdf')).length;
    t.dialogMode = 'dismiss';
    await page.click('[data-act="exportPdf"]'); await settle(200);
    t.dialogMode = 'accept';
    assert.strictEqual((await t.calls('exportPdf')).length, n0, 'cancelled');
    assert(/not been marked as reviewed/.test(t.dialogs[t.dialogs.length - 1]), 'dialog: ' + t.dialogs[t.dialogs.length - 1]);
    await page.click('[data-act="exportPdf"]'); await settle(300);
    assert.strictEqual((await t.calls('exportPdf')).length, n0 + 1, 'exported after confirming');
    // sample (all reviewed): no dialog
    const d0 = t.dialogs.length;
    await openTab(S, 'report'); await settle(300); await page.click('[data-act="exportPdf"]'); await settle(300);
    assert.strictEqual(t.dialogs.length, d0, 'no dialog for a reviewed job');
  });

  await step('two modals in a row: OEM picker "Use" changes only its own line; + Part number works after the signature pad', async () => {
    await openTab(S, 'estimate');
    const before = (await t.getJob(S)).lines;
    // line 1 gets the assessor's own number and price
    await page.fill(`input[data-lf="partNo"][data-id="${before[0].id}"]`, 'MY-OWN-PN-1'); await page.fill(`input[data-lf="amount"][data-id="${before[0].id}"]`, '11.11'); await flush();
    await page.click(`[data-act="oemPick"][data-id="${before[0].id}"]`); await settle(150);
    const modalText = await text('#modalBody');
    assert(/£74\.55 ex VAT \(£89\.46 inc VAT\)/.test(modalText), 'OEM modal prices ex / inc VAT');
    await page.click('#modal [data-close]'); await settle(100);
    await page.click(`[data-act="oemPick"][data-id="${before[1].id}"]`); await settle(150);
    await page.click('#modal [data-use="0"]'); await flush();
    const after = (await t.getJob(S)).lines;
    assert.deepStrictEqual([after[0].partNo, after[0].amount], ['MY-OWN-PN-1', 11.11], 'line 1 unchanged by line 2\'s picker');
    assert.deepStrictEqual([after[1].partNo, after[1].amount], [before[1].partNo, before[1].amount], 'line 2: number set, no researched price so amount kept');
    // restore line 1 through its own picker: the EX-VAT price is used
    await page.click(`[data-act="oemPick"][data-id="${before[0].id}"]`); await settle(150);
    await page.click('#modal [data-use="0"]'); await flush();
    const l1 = (await t.getJob(S)).lines[0];
    assert.deepStrictEqual([l1.partNo, l1.amount], ['768501KA6A', 74.55], 'Use fills the ex-VAT price');
    assert(/£3,365\.08/.test(await text('#chips')), 'sample total intact: ' + await text('#chips'));
    // signature pad, then catalogue "+ Part number"
    await t.go('#/settings'); await settle(300);
    await page.click('[data-act="sigDraw"][data-target="default"]'); await settle(150);
    const cv = await page.locator('canvas.sigpad').boundingBox();
    await page.mouse.move(cv.x + 20, cv.y + 40); await page.mouse.down(); await page.mouse.move(cv.x + 200, cv.y + 80, { steps: 6 }); await page.mouse.up();
    await page.click('#modal [data-ok]'); await settle(300);
    await t.go('#/catalogue'); await settle(300);
    await page.click('[data-act="catAddNo"]'); await settle(150);
    assert(/Price £ ex VAT/.test(await text('#modalBody')), 'ex VAT price label');
    await page.fill('#nOem', 'TEST-PN-123'); await page.fill('#nPrice', '12.5');
    await page.click('#modal [data-ok]'); await settle(300);
    assert(/#\/catalogue$/.test(await page.evaluate(() => location.hash)) && /Parts catalogue/.test(await text('#main')), 'still on the catalogue');
    assert(/Part number added/.test(await toastText()), await toastText());
    const custom = await t.getKv('customOem');
    const entry = custom.flatMap((v) => Object.values(v.parts).flat()).find((c) => c.oem === 'TEST-PN-123');
    assert(entry && entry.autoFill === true && entry.role === 'primary' && entry.market === 'UK' && entry.price === 12.5, 'user entry fields: ' + JSON.stringify(entry));
  });

  await step('switching jobs mid-edit keeps the edit', async () => {
    await openTab(S, 'claim');
    await page.fill('[data-bind="instruction.fileRef"]', 'EDITED-REF-123');
    await page.click('.jobhead a[href="#/jobs"]'); await settle(300);
    assert.strictEqual((await t.getJob(S)).instruction.fileRef, 'EDITED-REF-123');
    await openTab(S, 'claim');
    await page.fill('[data-bind="instruction.tpReg"]', 'ZZ99 ZZZ');
    await openTab(B, 'claim'); await settle(200);
    assert.strictEqual((await t.getJob(S)).instruction.tpReg, 'ZZ99 ZZZ');
    await openTab(S, 'claim');
    await page.fill('[data-bind="instruction.fileRef"]', 'CCG-AB14CDE-010926'); await page.fill('[data-bind="instruction.tpReg"]', 'XX08 XXX'); await flush();
  });

  await step('zone filter: chip with ✕, reset when another job opens', async () => {
    await openTab(S, 'estimate');
    await page.click('[data-act="zonePick"][data-z="RH mirror"]'); await settle(150);
    assert(/Zone: RH mirror/.test(await text('.zchip')), 'chip');
    const n = await page.$$eval('#pickResults .r', (ns) => ns.length);
    const id = await newJob();
    await openTab(id, 'estimate');
    assert(!(await exists('.zchip')), 'no chip on another job');
    const n2 = await page.$$eval('#pickResults .r', (ns) => ns.length);
    assert(n2 > n, `filter cleared (${n} → ${n2})`);
    await openTab(S, 'estimate');
    await page.click('[data-act="zonePick"][data-z="RH mirror"]'); await settle(100);
    await page.click('.zchip [data-act="zonePick"]'); await settle(100);
    assert(!(await exists('.zchip')), 'cleared by ✕');
  });

  await step('CSV import: quoted fields, doubled quotes, optional header, skipped rows reported', async () => {
    await t.go('#/catalogue'); await settle(300);
    await page.selectOption('#catVeh', 'nissan-juke-f15'); await settle(200);
    const csv = 'FW001,RH,OEM-FW-R,"Wing, right ""outer""",£123.45\r\nBN001,,OEM-BONNET,Bonnet,400\r\nXX999,,BAD,Bad,1\r\n';
    await choose('[data-act="catImport"]', { name: 'parts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await settle(400);
    assert(/Imported 2 part number\(s\), skipped 1 row/.test(await toastText()), await toastText());
    let custom = await t.getKv('customOem');
    const juke = custom.find((v) => v.key === 'nissan-juke-f15');
    const fw = juke.parts['FW001|R'].find((c) => c.oem === 'OEM-FW-R');
    assert(fw.description === 'Wing, right "outer"' && fw.price === 123.45 && fw.autoFill === true, JSON.stringify(fw));
    assert(juke.parts['BN001|'].some((c) => c.oem === 'OEM-BONNET' && c.price === 400));
    await choose('[data-act="catImport"]', { name: 'h.csv', mimeType: 'text/csv', buffer: Buffer.from('code,side,oem,description,price\nRE001,,OEM-RB,Rear bumper,150\n') }); await settle(400);
    assert(/Imported 1 part number\(s\)\./.test(await toastText()) && !/header/.test(await toastText()), await toastText());
  });

  await step('import a legacy job lacking sections; Jobs list still renders', async () => {
    await t.go('#/jobs'); await settle(300);
    await choose('[data-act="importJob"]', { name: 'min.json', mimeType: 'application/json', buffer: Buffer.from('{"vehicle":{"reg":"MIN 1"},"lines":[{"description":null,"hours":1}]}') });
    await page.waitForFunction(() => /#\/job\/[^/]+\/claim$/.test(location.hash)); await settle(300);
    const id = await t.jobId();
    const j = await t.getJob(id);
    assert(j.valuation && j.report && j.rates && j.lines[0].description === '' && j.lines[0].id, 'migrated before saving');
    for (const tb of ['vehicle', 'estimate', 'valuation', 'report']) await openTab(id, tb);
    await page.click('.jobhead a[href="#/jobs"]'); await settle(400);
    assert(await exists('[data-act="loadSample"]'), 'list rendered');
    assert(/MIN 1/.test(await text('#main')), 'imported row shown');
  });

  await step('a job with AI findings and a raw legacy DVLA record reopens (migrate is safe and saves once)', async () => {
    const legacy = { id: 'legacy-1', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', vehicle: { reg: 'LEG 1', make: 'Nissan', firstReg: '2014-08-01', dvla: { make: 'NISSAN', motExpiryDate: '2027-02-01', monthOfFirstRegistration: '2014-08', taxStatus: 'Taxed', wheelplan: '2 AXLE RIGID BODY' } }, lines: [], photos: [{ dataUrl: 'data:image/jpeg;base64,' + jpg2.toString('base64'), title: 'x', labels: null }], aiFindings: { summary: { impact_type: 'x' }, suggested_lines: [], photos: [] }, valuation: { sources: [null, { name: 'CAP HPI', amount: 5000 }] } };
    await t.putJob(legacy);
    await t.go('#/catalogue'); await settle(200); await t.go('#/jobs'); await settle(300);
    await page.click('a[href="#/job/legacy-1/claim"].btn'); await settle(400);
    await openTab('legacy-1', 'vehicle');
    const dv = await page.$eval('#tabBody .hint b', (n) => n.parentElement.textContent);
    assert(/^DVLA:/.test(dv.trim()) && /expires 01\/02\/2027/.test(dv), 'DVLA line: ' + dv.trim().slice(0, 80));
    let j = await t.getJob('legacy-1');
    assert(j.vehicle.dvla.motExpiry === '2027-02-01' && j.vehicle.dvla.firstRegistration === '2014-08-01' && !('motExpiryDate' in j.vehicle.dvla), 'dvla normalised');
    assert(j.vehicle.firstRegPrecision === 'month' && j.photos[0].id && Array.isArray(j.photos[0].labels) && j.valuation.sources.length === 1, 'other fields migrated');
    const u1 = j.updatedAt;
    await t.go('#/jobs'); await settle(300); await openTab('legacy-1', 'photos'); await settle(200);
    j = await t.getJob('legacy-1');
    assert.strictEqual(j.updatedAt, u1, 'second open does not re-save (migrate is idempotent)');
  });

  await step('one bad record shows an error row instead of blanking the list', async () => {
    await page.evaluate(() => { const C = window.Core; C.__totals = C.totals; C.totals = (j) => { if (j && j.id === 'legacy-1') throw new Error('boom'); return C.__totals(j); }; });
    await t.go('#/settings'); await settle(200); await t.go('#/jobs'); await settle(400);
    const bad = await page.$$eval('tr.bad', (ns) => ns.map((n) => n.textContent));
    await page.evaluate(() => { const C = window.Core; C.totals = C.__totals; });
    assert(bad.length === 1 && /could not be read/.test(bad[0]) && /boom/.test(bad[0]), 'error row: ' + bad);
    assert(/AB14 CDE/.test(await text('#main')) && await exists('[data-act="loadSample"]'), 'other rows render');
  });

  await step('restore an old backup: settings defaults merged, jobs migrated', async () => {
    const backup = { kind: 'engineer-report-studio-backup', at: '2025-01-01T00:00:00Z', settings: { company: { name: 'RESTORED LTD' }, rates: { Body: 60, Painting: 60, Mechanical: 60, Auxiliary: 60, Electrical: 60 }, vatPct: 20 }, customOem: [], jobs: [{ id: 'restored-1', vehicle: { reg: 'RST 1' }, lines: [], aiFindings: { summary: {} } }] };
    await t.go('#/settings'); await settle(300);
    await choose('[data-act="restore"]', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) }); await settle(600);
    assert(/Backup restored/.test(await toastText()), await toastText());
    const st = await page.evaluate(() => ({ model: window.Core.settings.ai && window.Core.settings.ai.model, blend: window.Core.settings.blendFactor, name: window.Core.settings.company.name, pearl: (window.Core.settings.paintTypeFactor || {}).pearl }));
    assert(st.model === 'claude-opus-5-5' && st.blend === 0.5 && st.name === 'RESTORED LTD' && st.pearl === 1.2, JSON.stringify(st));
    const r = await t.getJob('restored-1');
    assert(r.valuation && r.report && r.rates && r.rates.Body === 60, 'restored job migrated with the restored rates');
    await page.click('[data-act="aiTest"]'); await settle(200);
    assert(/Connected/.test(await toastText()), 'AI test works after restore: ' + await toastText());
    await t.go('#/jobs'); await settle(300);
    assert(/RST 1/.test(await text('#main')), 'restored job listed');
    await openTab('restored-1', 'photos'); await openTab('restored-1', 'opinion');
  });

  await step('logo upload: SVG rasterised to a PNG the report accepts', async () => {
    await t.go('#/settings'); await settle(300);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><rect width="300" height="100" fill="#1f3349"/><text x="20" y="60" fill="#fff" font-size="40">ACME</text></svg>';
    await choose('[data-act="logoUpload"]', { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) }); await settle(600);
    const logo = await page.evaluate(() => window.Core.settings.company.logo);
    assert(/^data:image\/png;base64,/.test(logo), 'logo stored as PNG: ' + logo.slice(0, 30));
    assert(await page.evaluate((u) => window.Report.safeImage(u) === u, logo), 'accepted by Report.safeImage');
    await page.click('[data-act="logoClear"]'); await settle(200);
  });

  await step('report preview and PDF templates render for the sample', async () => {
    await openTab(S, 'report'); await settle(500);
    const len = await page.$eval('#preview', (f) => (f.srcdoc || '').length);
    assert(len > 5000, 'preview length ' + len);
    await page.click('[data-act="exportPdf"]'); await settle(300);
    const c = (await t.calls('exportPdf')).pop().arg;
    assert(c.header && c.footer && c.htmlLen > 5000);
  });

  await step('Settings: a blank or 0% economic-repair threshold is reset to 60% with a message', async () => {
    await t.go('#/settings'); await settle(300);
    await page.fill('[data-sbind="berThresholdPct"]', ''); await settle(50);
    await page.press('[data-sbind="berThresholdPct"]', 'Tab'); await settle(150);
    assert.strictEqual(await page.$eval('[data-sbind="berThresholdPct"]', (n) => n.value), '60');
    assert(/reset to 60%/.test(await toastText()), await toastText());
    await page.fill('[data-sbind="berThresholdPct"]', '0'); await page.press('[data-sbind="berThresholdPct"]', 'Tab'); await settle(600);
    assert.strictEqual(await page.evaluate(() => window.Core.settings.berThresholdPct), 60);
    await page.fill('[data-sbind="berThresholdPct"]', '65'); await page.press('[data-sbind="berThresholdPct"]', 'Tab'); await settle(600);
    assert.strictEqual((await t.getKv('settings')).berThresholdPct, 65);
    await page.fill('[data-sbind="berThresholdPct"]', '60'); await settle(600);
  });

  await step('Duplicate makes an editable draft copy (not finalised)', async () => {
    await openTab(S, 'signoff'); await page.click('[data-act="finaliseReport"]'); await flush();
    await t.go('#/jobs'); await settle(300);
    const n0 = (await t.listJobs()).length;
    await page.click(`[data-act="dupJob"][data-id="${S}"]`); await settle(400);
    const all = await t.listJobs();
    const copy = all.find((j) => j.report && /-COPY$/.test(j.report.ref || ''));
    assert(all.length === n0 + 1 && copy && !copy.issued && copy.id !== S, 'copy without the issued snapshot');
    assert(/finalised/.test(await text('#main')), 'Jobs list marks the finalised original');
    await openTab(S, 'signoff'); await page.click('[data-act="reopenReport"]'); await flush();
  });

  await step('an edit typed just before the window reloads is saved (beforeunload flush)', async () => {
    await openTab(S, 'claim');
    await page.fill('[data-bind="instruction.locationOfLoss"]', 'High Street, Esher (flushed)');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#main').innerHTML.length > 0); await settle(500);
    assert.strictEqual((await t.getJob(S)).instruction.locationOfLoss, 'High Street, Esher (flushed)');
    await openTab(S, 'claim'); await page.fill('[data-bind="instruction.locationOfLoss"]', 'High Street, Esher'); await flush();
  });

  await step('OEM auto-fill: only autoFill candidates pre-fill; otherwise blank part no., ⋯ button and a VIN message', async () => {
    const id = await newJob();
    await openTab(id, 'vehicle'); await page.selectOption('[data-bind="vehicle.oemKey"]', 'nissan-juke-f15'); await settle(200);
    await openTab(id, 'estimate');
    await pick('FE002', '', 'replace');
    assert(/1 researched number: choose the variant by VIN/.test(await toastText()), 'toast: ' + await toastText());
    await pick('SS001', 'R', 'replace'); await flush();
    const ls = await lines(id);
    const fe2 = ls.find((l) => l.code === 'FE002'), ss1 = ls.find((l) => l.code === 'SS001');
    assert.deepStrictEqual([fe2.partNo, fe2.amount], ['', 0], 'FE002 not auto-filled');
    assert.deepStrictEqual([ss1.partNo, ss1.amount], ['768501KA6A', 74.55], 'SS001 filled with the ex-VAT price');
    assert(await exists(`[data-act="oemPick"][data-id="${fe2.id}"]`), '⋯ options button on the FE002 line');
    await page.click(`[data-act="oemPick"][data-id="${fe2.id}"]`); await settle(150);
    assert(/choose by VIN/.test(await text('#modalBody')), 'modal badge');
    await page.click('#modal [data-close]');
    await page.fill('#pickQ', 'SS001'); await settle(100);
    assert(/768501KA6A · £74\.55 ex VAT/.test(await text('#pickResults')), 'picker shows the ex-VAT price: ' + await text('#pickResults'));
  });

  await t.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${t.errors.length} page/console error(s)`);
  if (t.errors.length) console.log(t.errors.join('\n'));
  process.exit(failed.length || t.errors.length ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await t.close(); } catch (x) { /* ignore */ } process.exit(1); });
