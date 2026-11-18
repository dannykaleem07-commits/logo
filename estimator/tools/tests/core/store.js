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
    const sums = idb.dump(DB, 'summaries');
    check('the upgrade itself wrote one summary per job', sums.length === 3 && sums.map((s) => s.id).sort().join(',') === 'job-a,job-b,job-damaged', sums.map((s) => s.id));
    check('…reading the jobs through a cursor, never all at once (no getAll on jobs)', statsOf(idb, 'openCursor:jobs') >= 1 && statsOf(idb, 'getAll:jobs') === 0, idb.stats);
    check('jobs are untouched by the upgrade', JSON.stringify(idb.dump(DB, 'jobs')) === JSON.stringify(jobs.slice().sort((x, y) => (x.id < y.id ? -1 : 1))));
    check('settings and user part numbers are untouched', (await C.Store.get('settings')).vatPct === 17.5 && (await C.Store.get('customOem'))[0].key === 'user-1');
    const byId = Object.fromEntries((await C.Store.listSummaries()).map((s) => [s.id, s]));
    check('summary of a normal job', byId['job-a'].net === 3365.08 && byId['job-a'].reg === 'AB14 CDE');
    check('summary of a repair job (photoCount counts every photo)', byId['job-b'].decision === 'Repair' && byId['job-b'].photoCount === 2 && byId['job-b'].reg === 'XY99 ZZZ');
    const d = byId['job-damaged'] || {};
    check('a damaged job gets a safe summary (no throw, defaults)', d.reg === '' && d.vehicle === '' && d.net === 0 && d.pav === 0 && d.photoCount === 1 && d.decision === '' && d.issued === false, d);
    check('no rebuild needed afterwards (no cursor over the jobs again)', statsOf(idb, 'openCursor:jobs') === 1, idb.stats);
    const a = await C.Store.getJob('job-a');
    check('an old job without rev saves normally (missing rev counts as 0) and gets rev 1', !('rev' in jobs[0]) && (await settle(C.Store.saveJob(a))).ok && a.rev === 1);
  }
  {
    // the upgrade must not fail because one summary cannot be written
    const idb = new FakeIDBFactory();
    const seedApp = app(new FakeIDBFactory());
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: v1jobs(seedApp.sample) }, kv: { records: [] } });
    idb.failRequest = (store, op, v) => store === 'summaries' && op === 'put' && v && v.id === 'job-b';
    const { C } = app(idb);
    const r = await settle(within(C.Store.listJobIds(), 2000, 'open'));
    idb.failRequest = null;
    check('a summary write failing during the upgrade does not stop the database opening', r.ok && idb.version(DB) === 2 && idb.dump(DB, 'summaries').length === 2, r.e);
    const sums = await C.Store.listSummaries();
    check('listSummaries rebuilds the missing summary', sums.length === 3 && sums.some((s) => s.id === 'job-b'));
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
    check('…through a cursor (no getAll on jobs)', statsOf(idb, 'openCursor:jobs') === 1 && statsOf(idb, 'getAll:jobs') === 0, idb.stats);
    const keysBefore = statsOf(idb, 'getAllKeys:jobs');
    await C.Store.listSummaries();
    check('the check runs once per session (second call reads the summaries only)', statsOf(idb, 'getAllKeys:jobs') === keysBefore && statsOf(idb, 'openCursor:jobs') === 1, idb.stats);
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
    check('a throwing getter keeps the id', C.jobSummary(junk[9]).id === 'g');
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
    // an older version of the app still has the data open in another tab and does not close it
    const idb = new FakeIDBFactory();
    idb.seed(DB, 1, { jobs: { keyPath: 'id', records: [{ id: 'old-1', vehicle: { reg: 'OLD' } }] }, kv: { records: [] } });
    const oldReq = idb.open(DB, 1);
    const oldConn = await new Promise((res) => { oldReq.onsuccess = () => res(oldReq.result); });
    const { C } = app(idb);
    const t0 = Date.now();
    const r = await settle(within(C.Store.listJobIds(), 7000, 'blocked open'));
    check('upgrade blocked by an older open tab → rejects with BlockedError (after a few seconds, not never)', !r.ok && r.e.name === 'BlockedError' && Date.now() - t0 < 6500, r.e && r.e.name);
    oldConn.close();
    await tick(50);
    const r2 = await settle(within(C.Store.listJobIds(), 2000, 'after the old tab closed'));
    check('…once that tab closes, the next call upgrades and works', r2.ok && r2.v.length === 1 && idb.version(DB) === 2, r2.e && r2.e.name);
  }

  await tick(20);
  check('no unhandled promise rejections in any of the above', unhandled.length === 0, unhandled.map((e) => (e && e.name) + ': ' + (e && e.message)));
  process.off('unhandledRejection', onUnhandled);
}

module.exports = { run };
if (require.main === module) run().then(done, (e) => { console.log('FAIL store checks threw: ' + (e && e.stack)); process.exitCode = 1; done(); });
