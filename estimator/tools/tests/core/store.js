// Core.Store checks against an in-memory IndexedDB (fakeidb.js): version 2 with job summaries (contract B / promises #10),
// the upgrade from version 1, rev conflicts (R#12), and storage failures that must reject with the error's name instead of
// hanging (R#1), with no unhandled rejections. Run: node store.js (also run from checks.js).
'use strict';
const { load, check, section, done } = require('./harness');
const { FakeIDBFactory } = require('./fakeidb');

const DB = 'engineer-report-studio';
const unhandled = [];
const onUnhandled = (r) => unhandled.push(r);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const settle = (p) => Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const within = (p, ms, what) => Promise.race([p, tick(ms).then(() => { const e = new Error(`${what}: no answer within ${ms} ms`); e.name = 'Timeout'; throw e; })]);
const app = (idb) => { const ctx = load({ indexedDB: idb }); return { C: ctx.Core, sample: () => ctx.Sample.sampleJob() }; };
const storeNames = (idb) => { const rec = idb._dbs.get(DB); return rec ? [...rec.stores.keys()].sort().join(',') : ''; };
const SUMMARY_KEYS = ['id', 'updatedAt', 'createdAt', 'reg', 'vehicle', 'ref', 'instructingParty', 'dateOfLoss', 'decision', 'category', 'net', 'pav', 'issued', 'photoCount'];
const statsOf = (idb, k) => idb.stats[k] || 0;

async function run() {
  process.on('unhandledRejection', onUnhandled);

  section('Store v2 (#10): fresh database, summaries written with the job in ONE transaction');
  {
    const idb = new FakeIDBFactory();
    const { C, sample } = app(idb);
    const j = sample();
    await C.Store.saveJob(j);
    check('a new database opens at version 2 with jobs, kv and summaries', idb.version(DB) === 2 && storeNames(idb) === 'jobs,kv,summaries', storeNames(idb));
    const sums = await C.Store.listSummaries();
    const s = sums[0] || {};
    check('listSummaries: one summary with every contract field', sums.length === 1 && SUMMARY_KEYS.every((k) => k in s), s);
    check('summary values (sample: Juke, net 3365.08, PAV 5682, Cat N, rev 1)', s.id === j.id && s.reg === 'AB14 CDE' && s.vehicle === 'Nissan Juke Acenta CVT' && s.ref === 'CF-AB14CDE-060926' &&
      s.instructingParty === 'Courtesy Cars Group UK Limited' && s.dateOfLoss === '2026-09-01' && s.decision === j.outcome.decision && s.category === 'N' && s.net === 3365.08 && s.pav === 5682 &&
      s.issued === false && s.photoCount === 0 && s.rev === 1 && s.updatedAt === j.updatedAt && s.createdAt === j.createdAt, s);
    check('listJobIds: the ids only', JSON.stringify(await C.Store.listJobIds()) === JSON.stringify([j.id]));
    check('listJobs (kept for compatibility) still returns whole jobs', (await C.Store.listJobs()).length === 1);
    idb._log.length = 0;
    j.photos.push({ id: 'p1', dataUrl: 'data:,', title: 'x' }); j.issued = { at: '2026-09-06T10:00:00Z' }; j.valuation.adopted = 6000;
    await C.Store.saveJob(j);
    check('saveJob = exactly one readwrite transaction over jobs + summaries', idb._log.length === 1 && idb._log[0].mode === 'readwrite' && idb._log[0].scope.join(',') === 'jobs,summaries', idb._log);
    const s2 = idb.dump(DB, 'summaries')[0];
    check('the summary follows the job (photoCount 1, issued, PAV 6000, rev 2)', s2.photoCount === 1 && s2.issued === true && s2.pav === 6000 && s2.rev === 2 && j.rev === 2, s2);
    // the job and its summary commit or fail together
    idb.failRequest = (store, op) => store === 'summaries' && op === 'put';
    j.vehicle.reg = 'CHANGED';
    const r = await settle(within(C.Store.saveJob(j), 2000, 'saveJob'));
    idb.failRequest = null;
    check('a failed summary write fails the save and leaves the stored job unchanged', !r.ok && r.e.name === 'UnknownError' && idb.dump(DB, 'jobs')[0].vehicle.reg === 'AB14 CDE' && j.rev === 2, r.e && r.e.name);
    j.vehicle.reg = 'AB14 CDE';
    idb._log.length = 0;
    await C.Store.deleteJob(j.id);
    check('deleteJob removes the job and its summary in one transaction', idb.dump(DB, 'jobs').length === 0 && idb.dump(DB, 'summaries').length === 0 && idb._log.length === 1 && idb._log[0].scope.join(',') === 'jobs,summaries');
    await C.Store.set('settings', { vatPct: 20 });
    check('kv get/set unchanged', (await C.Store.get('settings')).vatPct === 20);
  }

  section('Store v2 (#10): upgrade from version 1 (existing users)');
  const v1jobs = (sample) => {
    const a = sample(); a.id = 'job-a';
    const b = sample(); b.id = 'job-b'; b.vehicle.reg = 'XY99 ZZZ'; b.outcome = { decision: 'Repair', category: '' }; b.photos = [{ id: 'q', dataUrl: 'data:,' }, { id: 'r', dataUrl: 'data:,', exclude: true }];
    const bad = { id: 'job-damaged', vehicle: 7, lines: 'x', valuation: { adopted: 'abc', sources: 5 }, photos: [null, 3, {}], report: null, outcome: [] };
    return [a, b, bad];
  };
  {
    const idb = new FakeIDBFactory();
    const seedApp = app(new FakeIDBFactory());
    const jobs = v1jobs(seedApp.sample);
    const kv = [['settings', { vatPct: 17.5, company: { name: 'X' } }], ['customOem', [{ key: 'user-1', parts: {} }]]];
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: jobs }, kv: { records: kv } });
    const { C } = app(idb);
    const ids = await C.Store.listJobIds();
    check('version 1 → 2 on first use; the jobs and kv stores are kept', idb.version(DB) === 2 && storeNames(idb) === 'jobs,kv,summaries' && ids.length === 3);
    check('the upgrade only creates the (empty) summaries store: it reads and writes no job (#9)', idb.dump(DB, 'summaries').length === 0 && statsOf(idb, 'get:jobs') === 0 && statsOf(idb, 'openCursor:jobs') === 0 && statsOf(idb, 'getAll:jobs') === 0, idb.stats);
    check('jobs are untouched by the upgrade', JSON.stringify(idb.dump(DB, 'jobs')) === JSON.stringify(jobs.slice().sort((x, y) => (x.id < y.id ? -1 : 1))));
    check('settings and user part numbers are untouched', (await C.Store.get('settings')).vatPct === 17.5 && (await C.Store.get('customOem'))[0].key === 'user-1');
    const byId = Object.fromEntries((await C.Store.listSummaries()).map((s) => [s.id, s]));
    const sums = idb.dump(DB, 'summaries');
    check('the first listSummaries builds and stores one summary per job', sums.length === 3 && sums.map((s) => s.id).sort().join(',') === 'job-a,job-b,job-damaged', sums.map((s) => s.id));
    check('…reading the jobs one at a time by key, never all at once (no getAll, no cursor over the jobs)', statsOf(idb, 'get:jobs') === 3 && statsOf(idb, 'getAll:jobs') === 0 && statsOf(idb, 'openCursor:jobs') === 0, idb.stats);
    check('summary of a normal job', byId['job-a'].net === 3365.08 && byId['job-a'].reg === 'AB14 CDE');
    check('summary of a repair job (photoCount counts every photo)', byId['job-b'].decision === 'Repair' && byId['job-b'].photoCount === 2 && byId['job-b'].reg === 'XY99 ZZZ');
    const d = byId['job-damaged'] || {};
    check('a damaged job gets a safe summary (no throw, defaults)', d.reg === '' && d.vehicle === '' && d.net === 0 && d.pav === 0 && d.photoCount === 1 && d.decision === '' && d.issued === false, d);
    await C.Store.listSummaries();
    check('no rebuild needed afterwards (no job read again)', statsOf(idb, 'get:jobs') === 3 && statsOf(idb, 'openCursor:jobs') === 0, idb.stats);
    const a = await C.Store.getJob('job-a');
    check('an old job without rev saves normally (missing rev counts as 0) and gets rev 1', !('rev' in jobs[0]) && (await settle(C.Store.saveJob(a))).ok && a.rev === 1);
  }
  {
    // a legacy job without its own rates is summarised with the SAVED Settings rates, as the old Jobs list showed it
    const idb = new FakeIDBFactory();
    const old = { id: 'legacy-rates', vehicle: { reg: 'OLD 1' }, lines: [{ type: 'Body', description: 'Panel', hours: 2, amount: 0, costClass: 'parts' }], valuation: {} };
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: [old] }, kv: { records: [['settings', { rates: { Body: 50 }, vatPct: 20 }]] } });
    const { C } = app(idb);
    await C.loadSettings(); // as the app does at start, before the Jobs list
    const s = (await C.Store.listSummaries())[0] || {};
    check('upgrade: a job without its own rates is totalled with the saved Settings rates (2h × £50 = £100) and records them', s.net === 100 && typeof s.settingsRates === 'string' && (idb.dump(DB, 'summaries')[0] || {}).net === 100, s);
  }
  {
    // a summary that cannot be written while the summaries are first built does not lose the job from the list
    const idb = new FakeIDBFactory();
    const seedApp = app(new FakeIDBFactory());
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: v1jobs(seedApp.sample) }, kv: { records: [] } });
    idb.failRequest = (store, op, v) => store === 'summaries' && op === 'put' && v && v.id === 'job-b';
    const { C } = app(idb);
    const r = await settle(within(C.Store.listSummaries(), 2000, 'first list'));
    idb.failRequest = null;
    check('a summary write failing on the first list: every job is listed, the other summaries are stored', r.ok && r.v.length === 3 && idb.version(DB) === 2 && idb.dump(DB, 'summaries').length === 2, r.e || r.v.length);
    const sums = await C.Store.listSummaries();
    check('listSummaries rebuilds the missing summary next time', sums.length === 3 && sums.some((s) => s.id === 'job-b') && idb.dump(DB, 'summaries').length === 3);
  }
  {
    // #9: a v1 database on a nearly full disk: the upgrade still commits (it writes no records), everything stays readable
    const seedApp = app(new FakeIDBFactory());
    const many = Array.from({ length: 20 }, (_, i) => Object.assign(seedApp.sample(), { id: 'job-' + String(i).padStart(2, '0') }));
    const idb = new FakeIDBFactory();
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: many }, kv: { records: [['settings', { vatPct: 20 }]] } });
    idb.quotaBytes = idb._size(idb._dbs.get(DB)) + 2000; // the 20 summaries need far more than 2 KB
    const { C } = app(idb);
    const ids = await settle(within(C.Store.listJobIds(), 2000, 'open, nearly full'));
    check('nearly full disk (#9): the v1 → v2 upgrade commits and the jobs are listed', ids.ok && ids.v.length === 20 && idb.version(DB) === 2, ids.e && ids.e.message);
    const reads = await Promise.all([settle(C.Store.getJob('job-03')), settle(C.loadSettings()), settle(within(C.Store.listSummaries(), 3000, 'list, nearly full'))]);
    check('…a job, the Settings and the whole Jobs list can be read (the summaries that cannot be stored are built on the fly)', reads.every((x) => x.ok) && reads[0].v.id === 'job-03' && reads[2].v.length === 20 && reads[2].v.every((s) => s.net === 3365.08), reads.map((x) => x.ok || x.e.name));
    check('…and no summary was stored (a full disk takes nothing)', (idb.dump(DB, 'summaries') || []).length === 0);
    idb.quotaBytes = null;
    const later = await C.Store.listSummaries();
    check('…once there is space, the next list stores them', later.length === 20 && (idb.dump(DB, 'summaries') || []).length === 20);
  }
  {
    // #9: a disk so full that even the empty-store upgrade cannot commit: the data opens at version 1, readable and saveable
    const seedApp = app(new FakeIDBFactory());
    const many = Array.from({ length: 12 }, (_, i) => Object.assign(seedApp.sample(), { id: 'job-' + String(i).padStart(2, '0') }));
    const idb = new FakeIDBFactory();
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: many }, kv: { records: [['settings', { vatPct: 17.5 }]] } });
    idb.quotaBytes = idb._size(idb._dbs.get(DB)) - 1;
    const { C } = app(idb);
    const ids = await settle(within(C.Store.listJobIds(), 2000, 'open, full'));
    check('full disk (#9): the upgrade cannot commit, so the data is opened at version 1 instead of not at all', ids.ok && ids.v.length === 12 && idb.version(DB) === 1, ids.e && ids.e.message);
    const reads = await Promise.all([settle(C.Store.getJob('job-05')), settle(C.loadSettings()), settle(within(C.Store.listSummaries(), 3000, 'list, full'))]);
    check('…a job, the Settings (VAT 17.5%) and the Jobs list (from the jobs) can be read, so a backup can be made', reads.every((x) => x.ok) && reads[0].v.id === 'job-05' && reads[1].v.vatPct === 17.5 && reads[2].v.length === 12, reads.map((x) => x.ok || x.e.name));
    const job = (reads[0].ok && reads[0].v) || Object.assign(seedApp.sample(), { id: 'job-05' }); job.vehicle.reg = 'SAVED 1';
    const full = await settle(C.Store.saveJob(job));
    check('…a save on the full disk fails with QuotaExceededError (not a hang)', !full.ok && full.e.name === 'QuotaExceededError', full.e && full.e.name);
    idb.quotaBytes = null;
    const saved = await settle(C.Store.saveJob(job));
    check('…with space again, saving works on the version 1 data (jobs store only)', saved.ok && idb.dump(DB, 'jobs').some((x) => x.vehicle.reg === 'SAVED 1') && idb.version(DB) === 1, saved.e && saved.e.name);
    const next = app(idb); // the next start
    const sums = await settle(within(next.C.Store.listSummaries(), 3000, 'next start'));
    check('…and on the next start the upgrade runs and the summaries are built', sums.ok && sums.v.length === 12 && idb.version(DB) === 2 && (idb.dump(DB, 'summaries') || []).length === 12, sums.e && sums.e.name);
  }
  {
    // version 2 with no summaries (e.g. written by a build without them): rebuilt once, through a cursor
    const idb = new FakeIDBFactory();
    const seedApp = app(new FakeIDBFactory());
    const jobs = v1jobs(seedApp.sample);
    idb.seed(DB, 2, { jobs: { keyPath: 'id', records: jobs }, kv: { records: [] }, summaries: { keyPath: 'id', records: [{ id: 'ghost', v: 1 }, { id: 'job-a', v: 0, reg: 'OLD SHAPE' }] } });
    const { C } = app(idb);
    const sums = await C.Store.listSummaries();
    check('missing summaries are rebuilt, a deleted job\'s summary is dropped, an old-shape summary is rebuilt', sums.length === 3 && !sums.some((s) => s.id === 'ghost') && sums.find((s) => s.id === 'job-a').reg === 'AB14 CDE', sums.map((s) => s.id + ':' + s.reg));
    check('…reading only those jobs, by key (no getAll, no cursor over the jobs)', statsOf(idb, 'get:jobs') === 3 && statsOf(idb, 'openCursor:jobs') === 0 && statsOf(idb, 'getAll:jobs') === 0, idb.stats);
    await C.Store.listSummaries();
    check('once repaired, the next call reads keys and summaries only (no job read)', statsOf(idb, 'get:jobs') === 3 && statsOf(idb, 'openCursor:jobs') === 0, idb.stats);
    // a job stored by other means (e.g. a test harness writing the jobs store directly) is listed on the next call
    const extra = seedApp.sample(); extra.id = 'job-raw';
    const rec = idb._dbs.get(DB).stores.get('jobs'); rec.records.push({ key: 'job-raw', value: structuredClone(extra) });
    let again = await C.Store.listSummaries();
    check('a job written straight into the jobs store is listed on the next call (its summary is built and stored)', again.length === 4 && again.some((x) => x.id === 'job-raw' && x.net === 3365.08) && (idb.dump(DB, 'summaries') || []).length === 4, again.map((x) => x.id));
    rec.records.splice(rec.records.findIndex((r) => r.key === 'job-raw'), 1);
    again = await C.Store.listSummaries();
    check('…and a job removed that way disappears with its summary', again.length === 3 && (idb.dump(DB, 'summaries') || []).length === 3);
    // a summary that cannot be stored during the repair: the list is still complete
    rec.records.push({ key: 'job-raw2', value: Object.assign(structuredClone(extra), { id: 'job-raw2' }) });
    idb.failRequest = (store, op) => store === 'summaries' && op === 'put';
    again = await C.Store.listSummaries();
    idb.failRequest = null;
    check('a summary that cannot be stored is still in the list (no job silently missing)', again.length === 4 && again.some((x) => x.id === 'job-raw2') && (idb.dump(DB, 'summaries') || []).length === 3, again.map((x) => x.id));
  }
  {
    // version 2 without a summaries store at all: the list is built on the fly and saving still works
    const idb = new FakeIDBFactory();
    const seedApp = app(new FakeIDBFactory());
    idb.seed(DB, 2, { jobs: { keyPath: 'id', records: v1jobs(seedApp.sample) }, kv: { records: [] } });
    const { C, sample } = app(idb);
    const sums = await C.Store.listSummaries();
    check('no summaries store: listSummaries still lists every job (cursor, nothing stored)', sums.length === 3 && statsOf(idb, 'getAll:jobs') === 0);
    const j = sample();
    const r = await settle(C.Store.saveJob(j));
    check('…and saveJob / deleteJob work on the jobs store alone', r.ok && (await settle(C.Store.deleteJob(j.id))).ok && idb.dump(DB, 'jobs').length === 3);
  }

  section('Summaries follow a Settings labour-rate change when the job\'s net uses Settings rates (#11)');
  {
    const idb = new FakeIDBFactory();
    const { C, sample } = app(idb);
    await C.loadSettings();
    const own = sample(); own.id = 'own-rates';
    const blank = sample(); blank.id = 'blank-rates'; blank.rates.Body = ''; blank.rates.Painting = ''; // cleared on the Estimate tab
    await C.Store.saveJob(own); await C.Store.saveJob(blank);
    const s0 = idb.dump(DB, 'summaries');
    check('only the summary whose net uses Settings rates records them', !('settingsRates' in s0.find((s) => s.id === 'own-rates')) && typeof s0.find((s) => s.id === 'blank-rates').settingsRates === 'string', s0.map((s) => s.id + ':' + s.settingsRates));
    C.settings.rates.Body = 90; C.settings.rates.Painting = 90;
    await C.saveSettings();
    const before = statsOf(idb, 'get:jobs');
    const list = Object.fromEntries((await C.Store.listSummaries()).map((s) => [s.id, s]));
    const live = C.totals(await C.Store.getJob('blank-rates')).net;
    check('after the Settings change the Jobs list shows the new net (£3,611.83), as the report does', list['blank-rates'].net === 3611.83 && live === 3611.83, [list['blank-rates'].net, live]);
    check('…a job with its own rates keeps its net (£3,365.08)', list['own-rates'].net === 3365.08);
    check('…and only the affected job was read to rebuild it', statsOf(idb, 'get:jobs') - before === 2, statsOf(idb, 'get:jobs') - before); // 1 rebuild + 1 getJob above
    const restarted = app(idb);
    await restarted.C.loadSettings();
    const again = Object.fromEntries((await restarted.C.Store.listSummaries()).map((s) => [s.id, s]));
    check('…and after a restart (the rebuilt summary was stored)', again['blank-rates'].net === 3611.83 && again['own-rates'].net === 3365.08 && idb.dump(DB, 'summaries').find((s) => s.id === 'blank-rates').net === 3611.83);
    // a legacy job without rates, summarised after the upgrade; then the Settings change
    const v1 = new FakeIDBFactory();
    v1.seed(DB, 1, { jobs: { keyPath: 'id', records: [{ id: 'legacy', vehicle: { reg: 'OLD 2' }, lines: [{ type: 'Body', description: 'Panel', hours: 2, amount: 0, costClass: 'parts' }], valuation: {} }] }, kv: { records: [['settings', { rates: { Body: 50 } }]] } });
    const L1 = app(v1);
    await L1.C.loadSettings();
    const first = (await L1.C.Store.listSummaries())[0];
    L1.C.settings.rates.Body = 60; await L1.C.saveSettings();
    const second = (await L1.C.Store.listSummaries())[0];
    check('a legacy job without rates: £100 at £50/h, then £120 once Settings say £60/h (no save of the job needed)', first.net === 100 && second.net === 120, [first.net, second.net]);
    check('jobSummary of an issued job (rates frozen) does not record Settings rates', !('settingsRates' in C.jobSummary(Object.assign(sample(), { rates: {}, issued: { at: '2026-09-06T10:00:00Z', rates: { Body: 72.5 }, vatPct: 20 } }))));
  }

  section('jobSummary never throws (#10)');
  {
    const { C } = app(null);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const junk = [undefined, null, 0, 7, 'x', [], [1], {}, { vehicle: 5, report: 'r', lines: {}, photos: 'p', valuation: { adopted: '£5,000', sources: 3 } },
      { id: 'g', get vehicle() { throw new Error('boom'); } }, revoked.proxy, { id: 'n', vehicle: { make: { a: 1 }, model: ['m'], reg: 12 }, lines: [null, { hours: 'x' }], issued: 1 }];
    let threw = null, bad = [];
    for (const x of junk) {
      try {
        const s = C.jobSummary(x);
        if (!SUMMARY_KEYS.every((k) => k in s) || typeof s.net !== 'number' || typeof s.pav !== 'number' || typeof s.reg !== 'string' || typeof s.vehicle !== 'string' || typeof s.issued !== 'boolean') bad.push(s);
      } catch (e) { threw = e; }
    }
    check('junk input (null, numbers, arrays, wrong types, throwing getter, revoked proxy) → safe defaults', !threw && !bad.length, threw ? threw.message : bad);
    check('a throwing getter keeps the id, and the summary says why (unreadable, as the Jobs list expects)', C.jobSummary(junk[9]).id === 'g' && C.jobSummary(junk[9]).unreadable === 'boom' && !('unreadable' in C.jobSummary(junk[8])));
    check('£5,000 PAV in a legacy job is read (tolerant num)', C.jobSummary(junk[8]).pav === 5000);
  }

  section('Save conflicts (R#12): a stale copy never overwrites newer edits');
  {
    const idb = new FakeIDBFactory();
    const { C, sample } = app(idb);
    const j = sample();
    await C.Store.saveJob(j);
    const tab1 = await C.Store.getJob(j.id), tab2 = await C.Store.getJob(j.id);
    tab1.instruction.instructingParty = 'Typed in tab 1';
    await C.Store.saveJob(tab1);
    tab2.instruction.fileRef = 'Typed in tab 2';
    const before = tab2.updatedAt;
    const r = await settle(within(C.Store.saveJob(tab2), 2000, 'saveJob'));
    const stored = idb.dump(DB, 'jobs')[0];
    check('saving the stale copy rejects with ConflictError', !r.ok && r.e.name === 'ConflictError' && /another window or tab/.test(r.e.message), r.e && r.e.name);
    check('…and writes nothing (tab 1\'s edit kept, tab 2\'s not stored, rev 2)', stored.instruction.instructingParty === 'Typed in tab 1' && stored.instruction.fileRef !== 'Typed in tab 2' && stored.rev === 2);
    check('…the stale copy keeps its rev and updatedAt', tab2.rev === 1 && tab2.updatedAt === before);
    check('…the summary is not touched', idb.dump(DB, 'summaries')[0].rev === 2);
    const r2 = await settle(C.Store.saveJob(tab2, { overwrite: true }));
    check('saveJob(job, {overwrite:true}) (restore / import) replaces it and continues the rev (3)', r2.ok && tab2.rev === 3 && idb.dump(DB, 'jobs')[0].rev === 3);
    check('…after which the other copy is the stale one', (await settle(C.Store.saveJob(tab1))).e.name === 'ConflictError');
    // the same object saved twice without waiting: the saves queue, no false conflict
    const x = await C.Store.getJob(j.id);
    const both = await Promise.all([settle(C.Store.saveJob(x)), settle(C.Store.saveJob(x))]);
    check('two overlapping saves of the same object both succeed (rev +2)', both.every((b) => b.ok) && x.rev === 5 && idb.dump(DB, 'jobs')[0].rev === 5, both.map((b) => b.ok || b.e.name));
    // a new job, or a job id not yet stored, gets rev 1 whatever rev it carries (an imported file)
    const imp = sample(); imp.rev = 41;
    await C.Store.saveJob(imp);
    check('a job not yet stored is saved with rev 1', imp.rev === 1);
  }

  section('Storage failures (R#1): rejections keep the error name; nothing hangs');
  {
    const idb = new FakeIDBFactory();
    const { C, sample } = app(idb);
    const j = sample();
    await C.Store.saveJob(j);
    idb.quotaBytes = idb._size(idb._dbs.get(DB)) + 2000;
    const big = Object.assign(C.clone(j), {});
    big.photos = [{ id: 'p', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(60000) }];
    const before = { rev: big.rev, updatedAt: big.updatedAt };
    const r = await settle(within(C.Store.saveJob(big), 2000, 'saveJob under quota'));
    check('quota exceeded at commit (abort only, no error event) → saveJob rejects', !r.ok && r.e.name !== 'Timeout', r.e && r.e.message);
    check('…with name QuotaExceededError and a readable message', r.e && r.e.name === 'QuotaExceededError' && /not enough storage space/i.test(r.e.message), r.e && r.e.message);
    check('…job.rev and updatedAt are left as they were', big.rev === before.rev && big.updatedAt === before.updatedAt);
    check('…nothing was stored (rolled back)', idb.dump(DB, 'jobs')[0].photos.length === 0 && idb.dump(DB, 'summaries')[0].photoCount === 0);
    const r2 = await settle(within(C.Store.set('probe', 'x'.repeat(60000)), 2000, 'Store.set under quota'));
    check('Store.set under quota rejects with QuotaExceededError too', !r2.ok && r2.e.name === 'QuotaExceededError', r2.e && r2.e.name);
    idb.quotaBytes = null;
    check('with space again the same save succeeds', (await settle(C.Store.saveJob(big))).ok && big.rev === 2);
    idb.failRequest = (store, op) => store === 'jobs' && op === 'get'; idb.failName = 'UnknownError';
    const r3 = await settle(within(C.Store.saveJob(big), 2000, 'saveJob with a failing read'));
    idb.failRequest = null; idb.failName = null;
    check('a failed request inside the transaction rejects with its name', !r3.ok && r3.e.name === 'UnknownError', r3.e && r3.e.name);
    const r4 = await settle(within(C.Store.saveJob({ vehicle: {} }), 2000, 'saveJob without id'));
    check('a job without an id is refused (DataError), not left pending', !r4.ok && r4.e.name === 'DataError', r4.e && r4.e.name);
    const r5 = await settle(within(C.Store.getJob(undefined), 2000, 'getJob(undefined)'));
    check('getJob(undefined) rejects (DataError)', !r5.ok && r5.e.name === 'DataError', r5.e && r5.e.name);
    const r6 = await settle(within(C.Store.saveJob(null), 2000, 'saveJob(null)'));
    check('saveJob(null) rejects', !r6.ok);
  }
  {
    // no IndexedDB at all (blocked by the browser): every call rejects, none hangs; a later call retries
    const { C } = app(null);
    const r = await settle(within(C.Store.listSummaries(), 1000, 'no indexedDB'));
    check('no IndexedDB → rejects (no hang)', !r.ok && r.e.name !== 'Timeout', r.e && r.e.name);
  }
  {
    // a newer version of the app already upgraded the data
    const idb = new FakeIDBFactory();
    idb.seed(DB, 3, { jobs: { keyPath: 'id', records: [] }, kv: { records: [] }, summaries: { keyPath: 'id', records: [] } });
    const { C } = app(idb);
    const r = await settle(within(C.Store.listJobIds(), 2000, 'VersionError'));
    check('data written by a newer version → VersionError with a readable message', !r.ok && r.e.name === 'VersionError' && /newer version/.test(r.e.message), r.e && r.e.message);
  }
  {
    // another tab opens a newer version: this connection closes so it is not blocked, and reconnects on the next call
    const idb = new FakeIDBFactory();
    const { C } = app(idb);
    await C.Store.listJobIds();
    const req = idb.open(DB, 3);
    const outcome = await within(new Promise((res) => { req.onsuccess = () => res('opened'); req.onblocked = () => res('blocked'); req.onerror = () => res('error'); }), 2000, 'newer open');
    check('a newer version opening elsewhere is not blocked by this connection', outcome === 'opened', outcome);
    req.result.close();
  }
  {
    // an older version of the app has the data open in another tab: (a) it never closes it; (b) it closes it shortly before
    // the 4-second limit and the upgrade then takes a while (#12). Both run at the same time.
    const olderTab = async (idb) => {
      idb.seed(DB, 1, { jobs: { keyPath: 'id', records: [{ id: 'old-1', vehicle: { reg: 'OLD' } }] }, kv: { records: [] } });
      const oldReq = idb.open(DB, 1);
      return new Promise((res) => { oldReq.onsuccess = () => res(oldReq.result); });
    };
    const neverCloses = async () => {
      const idb = new FakeIDBFactory();
      const oldConn = await olderTab(idb);
      const { C } = app(idb);
      const t0 = Date.now();
      const r = await settle(within(C.Store.listJobIds(), 7000, 'blocked open'));
      const ms = Date.now() - t0;
      oldConn.close();
      await tick(50);
      const r2 = await settle(within(C.Store.listJobIds(), 2000, 'after the old tab closed'));
      return { r, ms, r2, version: idb.version(DB) };
    };
    const closesLate = async () => {
      const idb = new FakeIDBFactory();
      idb.upgradeDelayMs = 700; // a slow upgrade: it is still running when the 4 s limit passes
      const oldConn = await olderTab(idb);
      const { C } = app(idb);
      const t0 = Date.now();
      setTimeout(() => oldConn.close(), 3600);
      const r = await settle(within(C.loadSettings(), 7000, 'old tab closed late'));
      return { r, ms: Date.now() - t0, version: idb.version(DB) };
    };
    const [a, b] = await Promise.all([neverCloses(), closesLate()]);
    check('upgrade blocked by an older open tab → rejects with BlockedError (after a few seconds, not never)', !a.r.ok && a.r.e.name === 'BlockedError' && a.ms < 6500, a.r.e && a.r.e.name);
    check('…once that tab closes, the next call upgrades and works', a.r2.ok && a.r2.v.length === 1 && a.version === 2, a.r2.e && a.r2.e.name);
    check('the older tab closes just before the limit and the upgrade outlasts it: no false BlockedError, the start succeeds (#12)', b.r.ok && b.version === 2 && b.ms > 4000, b.r.ok ? b.ms : b.r.e.name + ' at ' + b.ms + ' ms');
  }

  await tick(20);
  check('no unhandled promise rejections in any of the above', unhandled.length === 0, unhandled.map((e) => (e && e.name) + ': ' + (e && e.message)));
  process.off('unhandledRejection', onUnhandled);
}

module.exports = { run };
if (require.main === module) run().then(done, (e) => { console.log('FAIL store checks threw: ' + (e && e.stack)); process.exitCode = 1; done(); });
