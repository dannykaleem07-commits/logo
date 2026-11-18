/* Core utilities, storage, data model and calculations. */
(function () {
  'use strict';

  // ---------- small helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // Tolerant number reader for stored and imported data: "£5,995" → 5995, "60,000" → 60000, "1,234.50" → 1234.5,
  // a lone decimal comma "1,5" → 1.5, "1.234,56" → 1234.56, "−£56.34" → −56.34. Text after the number is ignored as
  // parseFloat does ("1.5h" → 1.5, "1e3" → 1000); anything without a finite number → 0.
  const NUM_IGNORE = /[\s\u00a0\u2007\u2009\u202f£]/g;
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v == null || typeof v === 'boolean') return 0;
    let s;
    try { s = String(v); } catch (e) { return 0; }
    s = s.replace(NUM_IGNORE, '').replace(/^\u2212/, '-');
    const m = /^([-+]?)(\d[\d.,]*|[.,]\d[\d.,]*)/.exec(s);
    if (!m) return 0;
    let t = m[2];
    if (t.includes(',')) {
      if (/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(t)) t = t.replace(/,/g, ''); // thousands separators
      else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56
      else if (!t.includes('.') && t.indexOf(',') === t.lastIndexOf(',')) t = t.replace(',', '.'); // a lone decimal comma
      else t = t.replace(/,/g, '');
    }
    const n = parseFloat(m[1] + t + s.slice(m[0].length));
    return isFinite(n) ? n : 0;
  };
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  // Negative amounts print with a true minus sign before the pound sign: −£1,234.56 (never £-1,234.56).
  const gbp = (n) => { const v = num(n), a = round2(Math.abs(v)); return (v < 0 && a > 0 ? '\u2212£' : '£') + a.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const gbp0 = (n) => { const v = num(n), a = Math.round(Math.abs(v)); return (v < 0 && a > 0 ? '\u2212£' : '£') + a.toLocaleString('en-GB'); };
  const hrs = (n) => num(n).toFixed(2);
  // The calendar date (YYYY-MM-DD) of a moment in UK time (Europe/London), or in the computer's own time zone when the
  // runtime has no time-zone data; never the UTC date (between 00:00 and 01:00 BST that is still the day before).
  // A plain YYYY-MM-DD is returned as it is; anything that is not a date gives ''.
  let ukParts = null;
  function localISODate(when) {
    if (typeof when === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(when.trim())) return when.trim();
    const d = when == null ? new Date() : when instanceof Date ? when : new Date(typeof when === 'number' ? when : String(when));
    if (isNaN(d)) return '';
    try {
      if (ukParts !== false) {
        if (!ukParts) ukParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
        const p = {};
        for (const x of ukParts.formatToParts(d)) p[x.type] = x.value;
        if (/^\d{4}$/.test(p.year) && /^\d{2}$/.test(p.month) && /^\d{2}$/.test(p.day)) return `${p.year}-${p.month}-${p.day}`;
      }
    } catch (e) { ukParts = false; /* no Europe/London data: the local calendar date below */ }
    const two = (n) => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).padStart(4, '0')}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }
  const todayISO = () => localISODate(new Date());
  // "2026-09-01" (or a timestamp starting with it) → its parts when it is a real calendar date; "2023-02-29" → null.
  function calendarDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(typeof s === 'string' ? s.trim() : '');
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = new Date(Date.UTC(2000, mo - 1, d));
    t.setUTCFullYear(y);
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, mo, d, text: m } : null;
  }
  // dd/mm/yyyy, or the text unchanged when it is not a valid date (never a silently shifted date)
  const ukDate = (iso) => {
    if (iso == null || iso === '') return '';
    const c = calendarDate(iso);
    return c ? `${c.text[3]}/${c.text[2]}/${c.text[1]}` : String(iso);
  };
  // "01 September 2026", or the text unchanged when it is not a valid date ("2023-02-29" is not rolled over to 1 March)
  const longDate = (iso) => {
    if (iso == null || iso === '') return '';
    const c = calendarDate(iso);
    if (!c) return String(iso);
    const d = new Date(Date.UTC(2000, c.mo - 1, c.d, 12));
    d.setUTCFullYear(c.y);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, path, val) => {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = val;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // Accent- and case-folded text for comparisons ("Škoda" → "skoda").
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  // "2013-2020" → [2013, 2020]; "2019-", "2019–present" or a lone "2019" → [2019, 9999]; no year → null.
  const yearRange = (s) => {
    const t = String(s == null ? '' : s);
    const m = /(\d{4})\s*(?:[-–—]|to\b)\s*(\d{4})?/i.exec(t);
    if (m) return [+m[1], m[2] ? +m[2] : 9999];
    const one = /(\d{4})/.exec(t);
    return one ? [+one[1], 9999] : null;
  };
  // tolerant readers, so legacy or partial jobs never throw
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const arr = (x) => (Array.isArray(x) ? x : []);
  const txt = (x) => (x == null ? '' : String(x));

  // ---------- IndexedDB storage ----------
  // Version 2 adds 'summaries' (one small record per job for the Jobs list, written in the same transaction as the job).
  const DB_NAME = 'engineer-report-studio';
  const DB_VERSION = 2;
  const SUMMARY_VERSION = 1; // jobSummary() shape; older summaries are rebuilt
  let dbPromise = null;
  // An Error that keeps the storage error's name ('QuotaExceededError', 'ConflictError', …) with a readable message.
  const STORE_MESSAGES = {
    QuotaExceededError: 'There is not enough storage space (the disk is full or nearly full).',
    AbortError: 'The storage transaction was cancelled.',
    InvalidStateError: 'The storage connection was closed.',
    UnknownError: 'The storage reported an unknown error (it may be full or damaged).',
    DataCloneError: 'Part of the assessment could not be stored.',
    VersionError: 'The stored data was written by a newer version of this app.'
  };
  function storeError(err, fallbackName) {
    const name = String((err && err.name) || fallbackName || 'Error');
    if (err instanceof Error && !(typeof DOMException !== 'undefined' && err instanceof DOMException) && err.name === name && err.storeError) return err;
    const raw = err && err.message ? String(err.message) : '';
    const e = new Error(STORE_MESSAGES[name] ? STORE_MESSAGES[name] + (raw ? ` (${raw})` : '') : raw || `Storage error (${name}).`);
    e.name = name;
    e.storeError = true;
    if (err) e.cause = err;
    return e;
  }
  function db() {
    if (dbPromise) return dbPromise;
    const p = new Promise((resolve, reject) => {
      let settled = false, blockedTimer = null;
      const done = (fn, v) => { if (settled) return false; settled = true; clearTimeout(blockedTimer); fn(v); return true; };
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { done(reject, storeError(err, 'UnknownError')); return; }
      req.onupgradeneeded = (e) => upgrade(req.result, req.transaction, (e && e.oldVersion) || 0);
      req.onsuccess = () => {
        const d = req.result;
        if (!done(resolve, d)) { try { d.close(); } catch (e) { /* stale connection after a reported block */ } return; }
        // a newer version opened elsewhere (another tab): let it upgrade, and reconnect on the next call
        d.onversionchange = () => { try { d.close(); } catch (e) { /* already closed */ } if (dbPromise === p) dbPromise = null; };
        d.onclose = () => { if (dbPromise === p) dbPromise = null; };
      };
      req.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); done(reject, storeError(req.error, 'UnknownError')); };
      // the upgrade waits while an older version of the app has the data open in another window or tab
      req.onblocked = () => {
        blockedTimer = setTimeout(() => {
          const e = new Error('The saved assessments are open in another window or tab of an older version of this app. Close it, then reload.');
          e.name = 'BlockedError';
          done(reject, e);
        }, 4000);
      };
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; }); // a failed open is retried on the next call
    return p;
  }
  // Creates the stores; from version 1, also one summary per stored job through a cursor (one job in memory at a time),
  // after reading the saved Settings as loadSettings() does (a legacy job without its own rates is totalled with them).
  // Nothing here may abort the upgrade: a summary that cannot be built is rebuilt later by listSummaries().
  function upgrade(d, t, oldVersion) {
    if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    if (d.objectStoreNames.contains('summaries')) return;
    try {
      d.createObjectStore('summaries', { keyPath: 'id' });
      if (!(oldVersion >= 1 && t)) return;
      const g = quiet(t.objectStore('kv').get('settings'), () => fillSummaries(t, null));
      g.onsuccess = () => {
        try { if (g.result && typeof g.result === 'object') settings = deepMerge(clone(DEFAULT_SETTINGS), g.result); } catch (err) { /* defaults */ }
        fillSummaries(t, null);
      };
    } catch (err) { /* no summaries yet: listSummaries() builds them */ }
  }
  // A request whose failure must not abort its transaction (the summaries are rebuilt later); then calls onError, if given.
  const quiet = (r, onError) => { r.onerror = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } if (onError) onError(); }; return r; };
  // Puts a summary for every job (or only for the keys in `only`, a Set), reading the jobs through a cursor, one at a time.
  // onSummary(summary) sees each summary built (whether or not it could be stored); onEnd() runs when the cursor stops.
  function fillSummaries(t, only, onSummary, onEnd) {
    const sums = t.objectStore('summaries');
    const end = () => { if (onEnd) { const f = onEnd; onEnd = null; f(); } };
    const cur = t.objectStore('jobs').openCursor();
    cur.onerror = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } end(); };
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return end();
      try {
        if (!only || only.has(c.primaryKey)) {
          const s = Object.assign(jobSummary(c.value), { id: c.primaryKey });
          if (onSummary) onSummary(s);
          quiet(sums.put(s));
        }
      } catch (err) { /* this one is left to the next check */ }
      try { c.continue(); } catch (err) { end(); /* the rest is rebuilt by the next check */ }
    };
  }
  const hasStore = (d, name) => { try { return d.objectStoreNames.contains(name); } catch (e) { return false; } };
  // One transaction over `stores`. fn(t, fail) issues the requests; the promise resolves with fn's result once the
  // transaction has COMMITTED, and rejects when it errors or aborts (Chromium reports a commit-time quota failure only as
  // an abort), keeping the error's name. fail(err) records why an operation is being abandoned (then call t.abort()).
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      let t;
      try { t = d.transaction(stores, mode); } catch (err) { reject(storeError(err, 'InvalidStateError')); return; }
      let result, failed = null, finished = false;
      const fail = (err) => { if (!failed) failed = storeError(err, 'AbortError'); };
      const stop = (err) => { fail(err); try { t.abort(); } catch (e) { /* already finished */ } };
      t.oncomplete = () => { if (finished) return; finished = true; if (failed) reject(failed); else resolve(result); };
      t.onerror = (e) => { if (!(e && e.defaultPrevented)) fail((e && e.target && e.target.error) || t.error); };
      t.onabort = () => { if (finished) return; finished = true; reject(failed || storeError(t.error, 'AbortError')); };
      try {
        Promise.resolve(fn(t, fail)).then((r) => { result = r; }, stop);
      } catch (err) { stop(err); }
    });
  }
  // Request → promise. Always awaited or returned inside tx(), so a failed request never becomes an unhandled rejection.
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const revOf = (j) => { const r = Math.floor(num(j && j.rev)); return r > 0 ? r : 0; };
  function conflictError(stored, mine) {
    const e = new Error('This assessment was changed in another window or tab. Reload it to continue.');
    e.name = 'ConflictError';
    e.storeError = true;
    e.storedRev = stored;
    e.rev = mine;
    return e;
  }
  // The Jobs list straight from the jobs (one at a time through a cursor), when there is no summaries store to use.
  function liveSummaries() {
    return tx('jobs', 'readonly', (t) => new Promise((resolve, reject) => {
      const out = [];
      const cur = t.objectStore('jobs').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return resolve(out); out.push(Object.assign(jobSummary(c.value), { id: c.primaryKey })); c.continue(); };
      cur.onerror = () => reject(cur.error);
    }));
  }
  // The stored summaries, checked against the jobs: a summary for every job, of the current shape (keys and the small
  // summaries only, no job is read). → { list, need: Set of job ids needing a summary, orphans: summary ids without a job }
  function compareSummaries(ids, sums) {
    const live = new Set(ids), have = new Map(), list = [], need = new Set(), orphans = [];
    for (const x of sums) if (x && x.id != null) have.set(x.id, x);
    for (const id of have.keys()) if (!live.has(id)) orphans.push(id);
    for (const id of ids) { const x = have.get(id); if (x && x.v === SUMMARY_VERSION) list.push(x); else need.add(id); }
    return { list, need, orphans };
  }
  const readBoth = (t, done, fail) => {
    const keys = t.objectStore('jobs').getAllKeys(), sums = t.objectStore('summaries').getAll();
    let pending = 2;
    keys.onerror = sums.onerror = (e) => fail(e && e.target && e.target.error);
    keys.onsuccess = sums.onsuccess = () => { if (!--pending) done(compareSummaries(keys.result || [], sums.result || [])); };
  };
  // Repairs the summaries (missing after an interrupted upgrade, written by another version, or jobs stored by other
  // means): drops summaries of deleted jobs and builds the missing ones through a cursor, one job at a time. Resolves with
  // the complete list, including any summary that could not be stored.
  function syncSummaries() {
    return tx(['jobs', 'summaries'], 'readwrite', (t) => new Promise((resolve, reject) => {
      readBoth(t, ({ list, need, orphans }) => {
        for (const id of orphans) quiet(t.objectStore('summaries').delete(id));
        if (!need.size) return resolve(list);
        fillSummaries(t, need, (x) => list.push(x), () => resolve(list));
      }, reject);
    }));
  }
  const Store = {
    // Every job with all of its photos: for compatibility only (the Jobs list uses listSummaries, the backup listJobIds).
    async listJobs() { return tx('jobs', 'readonly', (t) => reqP(t.objectStore('jobs').getAll())); },
    async listJobIds() { return tx('jobs', 'readonly', (t) => reqP(t.objectStore('jobs').getAllKeys())); },
    // The Jobs list: one small summary per job (jobSummary), never the jobs themselves. A read-only check that every job
    // has a current summary (keys and summaries only); only if not, a repair through a cursor (syncSummaries).
    async listSummaries() {
      const d = await db();
      if (!hasStore(d, 'summaries')) return liveSummaries();
      const now = await tx(['jobs', 'summaries'], 'readonly', (t) => new Promise((resolve, reject) => readBoth(t, resolve, reject)));
      if (!now.need.size && !now.orphans.length) return now.list;
      try { const list = await syncSummaries(); if (Array.isArray(list)) return list; } catch (err) { /* e.g. storage full: built on the fly below */ }
      return liveSummaries();
    },
    async getJob(id) { return tx('jobs', 'readonly', (t) => reqP(t.objectStore('jobs').get(id))); },
    // Saves the job and its summary in ONE transaction. A job saved elsewhere since it was loaded (a higher stored `rev`)
    // is not overwritten: the promise rejects with a ConflictError and nothing is written. opts.overwrite (restore,
    // import) skips that check. On success job.rev and job.updatedAt are the stored values; on failure they are unchanged.
    async saveJob(job, opts) {
      if (!job || typeof job !== 'object') throw new TypeError('saveJob: no assessment to save');
      const overwrite = !!(opts && opts.overwrite);
      const d = await db();
      const withSummary = hasStore(d, 'summaries');
      let before = null, mine = null;
      try {
        return await tx(withSummary ? ['jobs', 'summaries'] : ['jobs'], 'readwrite', (t, fail) => new Promise((resolve) => {
          const js = t.objectStore('jobs');
          const g = js.get(job.id);
          g.onsuccess = () => {
            const have = revOf(g.result);
            if (g.result && !overwrite && have > revOf(job)) { fail(conflictError(have, revOf(job))); t.abort(); return; }
            before = { rev: job.rev, updatedAt: job.updatedAt };
            mine = have + 1;
            job.rev = mine;
            job.updatedAt = new Date().toISOString();
            try {
              js.put(job);
              if (withSummary) t.objectStore('summaries').put(jobSummary(job));
            } catch (err) { fail(err); t.abort(); return; }
            resolve(job.id);
          };
        }));
      } catch (err) {
        if (before && job.rev === mine) { job.rev = before.rev; job.updatedAt = before.updatedAt; }
        throw err;
      }
    },
    async deleteJob(id) {
      const d = await db();
      const stores = hasStore(d, 'summaries') ? ['jobs', 'summaries'] : ['jobs'];
      return tx(stores, 'readwrite', (t) => { t.objectStore('jobs').delete(id); if (stores.length > 1) t.objectStore('summaries').delete(id); });
    },
    async get(key) { return tx('kv', 'readonly', (t) => reqP(t.objectStore('kv').get(key))); },
    async set(key, val) { return tx('kv', 'readwrite', (t) => reqP(t.objectStore('kv').put(val, key))); }
  };

  // ---------- settings ----------
  const DEFAULT_SETTINGS = {
    company: {
      name: 'CAR FLEX LTD',
      tradingName: 'CarFlex Secure Storage',
      address: 'Gleneagles Farm, Gleneagles Close, Stanwell, Staines-upon-Thames, Surrey TW19 7PD',
      companyNo: '12640635',
      phone: '+44 7766 443194',
      email: 'carflexlimited@gmail.com',
      logo: '',
      reportTitle: 'ENGINEERING & ACCIDENT DAMAGE ASSESSMENT',
      coverTitle: 'ENGINEERING & ACCIDENT DAMAGE ASSESSMENT REPORT',
      coverSubtitle: 'VEHICLE INSPECTION & REPAIR ASSESSMENT',
      accent: '#1a6fb5',
      navy: '#1f3349'
    },
    rates: { Body: 72.5, Painting: 72.5, Mechanical: 72.5, Auxiliary: 72.5, Electrical: 72.5 },
    vatPct: 20,
    salvagePct: 15,
    berThresholdPct: 60,
    berBasis: 'net',
    paintMaterialsPerHour: 0,
    paintTypeFactor: { solid: 1.0, metallic: 1.0, pearl: 1.2, 'three-stage': 1.3, matt: 1.3 },
    blendFactor: 0.5,
    ai: { model: 'claude-opus-5-5', effort: 'high' },
    dvlaEnv: 'live',
    assessor: {
      name: '',
      title: 'Automotive Accident Damage Assessor',
      qualifications: '',
      aqpId: '',
      accreditationExpiry: '',
      declaration: [
        'I certify that I have assessed the vehicle and reviewed the supporting evidence made available in connection with the reported accident damage.',
        'The findings, repair methodology, structural assessment, valuation and engineering conclusions contained within this report represent my professional assessment based upon the vehicle condition, photographic evidence, diagnostic information and documentation available at the date of assessment.',
        'Where the complete extent of damage remains concealed or requires dismantling, dimensional measurement or mechanical investigation, this has been expressly identified.',
        'To the best of my professional knowledge and judgement, this report accurately records the accident-related condition identified at the time of assessment.'
      ].join('\n\n'),
      signature: ''
    }
  };
  let settings = clone(DEFAULT_SETTINGS);
  function deepMerge(base, over) {
    if (!over || typeof over !== 'object') return base;
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
      else base[k] = over[k];
    }
    return base;
  }
  async function loadSettings() {
    const saved = await Store.get('settings');
    settings = deepMerge(clone(DEFAULT_SETTINGS), saved || {});
    return settings;
  }
  async function saveSettings() { await Store.set('settings', settings); }

  // ---------- catalogue ----------
  const CAT = {};
  (window.CATALOGUE || []).forEach((r) => {
    CAT[r[0]] = { code: r[0], name: r[1], group: r[2], sided: !!r[3], replaceHrs: r[4], refinishHrs: r[5], kind: r[6], mat: r[7] || '', repairHrs: num(r[8]) || 0 };
  });
  const OPS = {};
  (window.LABOUR_OPS || []).forEach((r) => { OPS[r[0]] = { code: r[0], name: r[1], type: r[2], hours: r[3] }; });
  // Our own guide-time adjustment by vehicle size (not manufacturer data)
  const SIZE_CLASSES = { small: ['Small (city / supermini)', 0.9], medium: ['Medium (hatch / saloon)', 1.0], large: ['Large (exec / estate / MPV)', 1.1], suv: ['SUV / 4x4', 1.15], premium: ['Large premium / luxury', 1.2], lcv: ['Van / LCV', 1.15] };
  const sizeFactor = (job) => ((SIZE_CLASSES[(job && job.vehicle && job.vehicle.sizeClass) || 'medium'] || [0, 1])[1]);
  const paintFactor = (job) => num((settings.paintTypeFactor || {})[(job && job.vehicle && job.vehicle.paintType) || 'metallic'] || 1);
  const sideWord = (s) => (s === 'R' ? 'RH' : s === 'L' ? 'LH' : '');

  // ---------- estimate-line helpers ----------
  const cat = (code) => (code && Object.prototype.hasOwnProperty.call(CAT, code) ? CAT[code] : null);
  const desc = (l) => txt(l && l.description);
  // Catalogue rows that are operations, services or consumables rather than parts (calibrations, scans, jig, fixings).
  function isServiceCode(code) {
    const p = cat(code);
    if (!p) return false;
    if (p.mat) return p.mat === 'operation' || p.mat === 'consumable';
    return p.kind === 'C' || code === 'ST006' || code === 'ST007' || (p.kind === 'A' && /calibrat|scan|alignment|geometry|\baim\b|beam|coding|diagnostic/i.test(p.name));
  }
  const DAMAGE_OPS = ['renew', 'repair1', 'repair', 'repair3', 'pdr'];
  const NON_DAMAGE_TEXT = /blend|refinish|remove & refit|r&i|strip|smart|polish|inspect|check|measure|calibrat|test/i;
  const isPaintLine = (l) => l.type === 'Painting' || l.costClass === 'paint';
  // True when the line renews or repairs a part. Picker lines carry `op`; manual and legacy lines are judged by their
  // wording. AI lines too, falling back to `aiOperation`, which is the AI's operation for the whole component
  // (so it can say "renew" on that component's refinish line).
  function isDamageOp(line) {
    const l = obj(line);
    if (l.op && l.op !== 'ai' && l.op !== 'manual') return DAMAGE_OPS.includes(l.op);
    const d = desc(l);
    if (l.op === 'ai') {
      if (isPaintLine(l) || NON_DAMAGE_TEXT.test(d)) return false;
      if (/\b(?:renew|renewal|replace|replacement|repair|pdr|paintless|straighten|sectional?)\b/i.test(d)) return true;
      const aiOp = fold(l.aiOperation);
      if (aiOp) return /^(?:renew|replace|repair|paintless|pdr)/.test(aiOp);
    }
    return !NON_DAMAGE_TEXT.test(d);
  }
  // True when the line fits a new part.
  function isRenewLine(line) {
    const l = obj(line);
    if (l.op && l.op !== 'ai' && l.op !== 'manual') return l.op === 'renew';
    const d = desc(l);
    if (/\b(?:renew|renewal|replace|replacement)\b/i.test(d)) return !/refinish|blend|paint|polish|smart|lacquer|\brefit\b/i.test(d);
    if (l.op === 'ai' && !isPaintLine(l) && !/repair|refinish|blend|refit|inspect|check|test|refurb|polish|smart/i.test(d)) return /^(?:renew|replace)/.test(fold(l.aiOperation));
    return false;
  }
  // Figure numbers of the photos printed in the report: Map(photoId → 1, 2, 3 …); excluded photos get none.
  function photoNumbers(job) {
    const m = new Map();
    let n = 0;
    for (const p of arr(obj(job).photos)) if (p && !p.exclude) m.set(p.id, ++n);
    return m;
  }

  // OEM lookups: window.OEM_VEHICLES = [{key, make, model, generation, years, parts:{ 'CODE|SIDE': {...} } }]
  let customOem = []; // user-added vehicles / numbers, persisted in kv 'customOem'
  function setCustomOem(list) { customOem = Array.isArray(list) ? list.filter((cv) => cv && cv.key) : []; }
  function oemVehicles() {
    const base = (window.OEM_VEHICLES || []).map((v) => Object.assign({}, v, { parts: Object.assign({}, v.parts) }));
    for (const cv of customOem) {
      let v = base.find((x) => x.key === cv.key);
      if (!v) { v = { key: cv.key, make: cv.make, model: cv.model, generation: cv.generation || '', years: cv.years || '', notes: 'Added by user', parts: {} }; base.push(v); }
      for (const [k, list] of Object.entries(obj(cv.parts))) v.parts[k] = arr(list).concat(v.parts[k] || []);
    }
    return base;
  }
  function findOemVehicle(key) { return oemVehicles().find((v) => v.key === key); }
  const MAKE_KEY_ALIASES = { vw: 'volkswagen', mercedes: 'mercedesbenz', merc: 'mercedesbenz' };
  const makeKey = (s) => { const k = fold(s).replace(/[^a-z0-9]+/g, ''); return MAKE_KEY_ALIASES[k] || k; };
  const modelKey = (s) => fold(s).replace(/[-_/.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const genTokens = (s) => fold(s).replace(/\b(?:mk|mark)\s*(?=\d)/g, 'mk').split(/[^a-z0-9]+/).filter(Boolean);
  // sibling models / body styles with their own panels: OEM numbers for the base model would be wrong
  const SIBLING_MODEL = /\b(sv|plus|sportsvan|gtc|coupe|cabrio|cabriolet|convertible|roadster|all ?terrain|alltrack|van)\b/;
  const OTHER_BODY = /\b(coupe|cabrio|cabriolet|convertible|all ?terrain|alltrack)\b/;
  function guessOemVehicle(vehicle) {
    const veh = obj(vehicle);
    const mk = makeKey(veh.make);
    const model = txt(veh.model);
    const md = modelKey(model.replace(/\s*\(.*\)\s*$/, ''));
    if (!mk || !md) return null;
    const gen = ((/\(([^)]+)\)/.exec(model) || [])[1] || '').trim();
    const genKey = fold(gen), genToks = genTokens(gen);
    const year = parseInt(txt(veh.firstReg).slice(0, 4), 10) || parseInt(obj(veh.dvla).yearOfManufacture, 10) || 0;
    const body = modelKey(veh.body);
    const builtIn = new Set((window.OEM_VEHICLES || []).map((o) => o.key));
    const pool = oemVehicles().filter((o) => {
      const m = modelKey(o.model);
      if (makeKey(o.make) !== mk || !m || !(md === m || md.startsWith(m + ' '))) return false; // whole words: "Golf" ≠ "Golfo"
      const own = modelKey([o.model, o.generation].concat(arr(o.bodies)).join(' '));
      const sib = SIBLING_MODEL.exec(md.slice(m.length)); // "Golf SV", "Astra GTC", "E-Class Coupe"
      if (sib && !own.includes(sib[1])) return false;
      if (body && arr(o.bodies).length) return o.bodies.some((b) => { const k = modelKey(b); return k && (body.includes(k) || k.includes(body)); });
      const ob = body && builtIn.has(o.key) ? OTHER_BODY.exec(body) : null; // e.g. variant body "Coupe" on a saloon-only entry
      return !(ob && !own.includes(ob[1]));
    });
    const inRange = (o) => { const r = yearRange(o.years); return !!(year && r && year >= r[0] && year <= r[1]); };
    if (!genToks.length) return year ? pool.find(inRange) || null : pool[0] || null;
    // A generation was chosen (e.g. "E-Class (W214)"): never fall back to a different generation. Whole tokens only;
    // a single-letter code ("K", "E") inside a longer name ("Corsa-e") must also agree with the year.
    const scored = [];
    for (const o of pool) {
      const g = fold(o.generation);
      if (!g) { scored.push({ o, strong: false }); continue; } // entry without a generation: by year only
      const og = genTokens(o.generation);
      const shared = genToks.filter((x) => og.includes(x));
      if (g === genKey || shared.some((x) => x.length >= 2)) scored.push({ o, strong: true });
      else if (shared.length) scored.push({ o, strong: false });
    }
    const pick = scored.find((s) => s.strong && inRange(s.o)) || scored.find((s) => inRange(s.o)) || scored.find((s) => s.strong);
    return pick ? pick.o : null;
  }
  // Candidate order (as tools/build-oem.js sorts the research): primary before variant numbers, auto-fill candidates
  // first, UK market first, then confirmed numbers — the assessor's own numbers (confidence 'user') rank with confirmed
  // ones — then the stored order (the assessor's numbers come first there). A number not marked auto-fill (autoFill:false)
  // is never ahead of one that is, so it is never the one used to pre-fill a line.
  const MARKET_RANK = { UK: 0, unknown: 1, 'EU-LHD': 2, US: 3 };
  const confRank = (c) => (c.confidence === 'confirmed' || c.confidence === 'user' ? 0 : 1);
  const marketRank = (c) => { const r = MARKET_RANK[c.market || 'unknown']; return r == null ? 1 : r; };
  function rankOem(list) {
    return list.map((c, i) => ({ c, i })).sort((a, b) =>
      ((a.c.role === 'variant') - (b.c.role === 'variant')) || ((a.c.autoFill === false) - (b.c.autoFill === false)) ||
      (marketRank(a.c) - marketRank(b.c)) || (confRank(a.c) - confRank(b.c)) || (a.i - b.i)).map((x) => x.c);
  }
  // Returns an array of candidate OEM entries (best first), or []. Parts researched without a side
  // (e.g. alloy wheels, TPMS sensors) are found for either side.
  function oemLookup(vehicleKey, code, side) {
    const v = findOemVehicle(vehicleKey);
    if (!v) return [];
    const list = v.parts[code + '|' + (side || '')] || (side ? v.parts[code + '|'] : null) || [];
    return rankOem(arr(list).filter((c) => c && typeof c === 'object'));
  }

  // ---------- VIN decode (WMI) ----------
  const WMI = {
    SJN: 'Nissan (UK)', JN1: 'Nissan', VSK: 'Nissan (Spain)', WVW: 'Volkswagen', WVG: 'Volkswagen (SUV)', WV1: 'Volkswagen Commercial', WV2: 'Volkswagen Commercial',
    WF0: 'Ford (Germany)', WF1: 'Ford', SFA: 'Ford (UK)', W0L: 'Vauxhall / Opel', W0V: 'Vauxhall / Opel', VXK: 'Vauxhall / Opel (PSA)', SB1: 'Toyota (UK)', NMT: 'Toyota (Turkey)',
    JTD: 'Toyota', VNK: 'Toyota (France)', WBA: 'BMW', WBS: 'BMW M', WBY: 'BMW i', WMW: 'MINI', WDD: 'Mercedes-Benz', W1K: 'Mercedes-Benz', WDB: 'Mercedes-Benz', W1N: 'Mercedes-Benz (SUV)',
    WAU: 'Audi', WUA: 'Audi Sport', TRU: 'Audi (Hungary)', VF1: 'Renault', VF3: 'Peugeot', VF7: 'Citroën', VR3: 'Peugeot', VR7: 'Citroën / DS', UU1: 'Dacia', KNA: 'Kia', KNE: 'Kia', U5Y: 'Kia (Slovakia)',
    KMH: 'Hyundai', TMA: 'Hyundai (Czech)', NLH: 'Hyundai (Turkey)', TMB: 'Škoda', VSS: 'SEAT / Cupra', ZFA: 'Fiat', ZAR: 'Alfa Romeo', JMZ: 'Mazda', JM1: 'Mazda', SAL: 'Land Rover',
    SAJ: 'Jaguar', SAR: 'Rover', JHM: 'Honda', SHH: 'Honda (UK)', SHS: 'Honda (UK)', YV1: 'Volvo', YV4: 'Volvo', JSA: 'Suzuki', TSM: 'Suzuki (Hungary)', JMB: 'Mitsubishi', JF1: 'Subaru',
    LRW: 'Tesla (China)', '5YJ': 'Tesla', XP7: 'Tesla (Germany)', LJC: 'MG / SAIC', LSJ: 'MG / SAIC', SCC: 'Lotus', SCF: 'Aston Martin', ZHW: 'Lamborghini', ZFF: 'Ferrari', WP0: 'Porsche', WP1: 'Porsche (SUV)'
  };
  const VIN_YEAR = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  function decodeVin(vin) {
    vin = txt(vin).toUpperCase().replace(/\s/g, '');
    const out = { valid: false, issues: [] };
    if (!vin) return out;
    if (vin.length !== 17) out.issues.push(`VIN has ${vin.length} characters (should be 17).`);
    if (/[IOQ]/.test(vin)) out.issues.push('VIN contains I, O or Q, which are not used in VINs.');
    const bad = [...new Set(vin.replace(/[A-Z0-9]/g, ''))];
    if (bad.length) out.issues.push(`VIN contains characters that are not allowed (${bad.map((c) => `"${c}"`).join(' ')}). A VIN uses only 0–9 and A–Z, except I, O and Q.`);
    out.manufacturer = WMI[vin.slice(0, 3)] || null;
    const yc = vin.charAt(9);
    const idx = VIN_YEAR.indexOf(yc);
    if (idx >= 0) out.yearCodes = [1980 + idx, 2010 + idx].filter((y) => y <= new Date().getFullYear() + 1);
    out.valid = out.issues.length === 0;
    return out;
  }
  // Brands built under another brand's WMI (Abarth VINs start ZFA = Fiat, Suzuki Swace/Across are Toyota-built, …).
  const VIN_MAKE_ALIASES = {
    abarth: ['fiat'], suzuki: ['toyota'], lexus: ['toyota'], genesis: ['hyundai'], ds: ['citroen'], 'ds automobiles': ['citroen'],
    alpine: ['renault'], dacia: ['renault'], cupra: ['seat'], smart: ['mercedes'], infiniti: ['nissan'], mini: ['bmw'],
    'range rover': ['land rover'], vw: ['volkswagen'], polestar: ['volvo'], opel: ['vauxhall'], vauxhall: ['opel']
  };
  function vinMakeMatches(manufacturer, make) {
    const m = fold(manufacturer), want = fold(make);
    if (!m || !want) return true;
    const first = want.split(/[\s/-]+/)[0];
    return [want, first].concat(VIN_MAKE_ALIASES[want] || [], VIN_MAKE_ALIASES[first] || []).some((c) => c && m.includes(c));
  }

  // ---------- job model ----------
  function newJob() {
    const id = uid();
    const s = Object.assign({}, DEFAULT_SETTINGS, obj(settings));
    s.assessor = obj(s.assessor);
    return {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      report: {
        ref: '', date: todayISO(), version: '1.0', status: 'Draft', headline: '', subHeadline: '', cpr35: false, conflicts: 'I have no conflict of interest in relation to this matter.',
        materialsRelied: '' // CPR 35: literature and other material relied on (PD 35 para 3.2(2)), printed in court-compliant mode
      },
      aiLog: [],
      aiFlags: [], // AI narrative-draft review flags kept until dismissed: [{ section, text, at }]
      instruction: {
        instructingParty: '', ownInsurer: '', ownRef: '', tpInsurer: '', tpRef: '', dateOfLoss: '', locationOfLoss: '',
        tpVehicle: '', tpReg: '', dateInstructed: todayISO(), fileRef: '',
        purpose: 'To undertake an engineering and accident-damage assessment of the claimant\'s vehicle, establish the nature and extent of the accident-related damage, assess structural condition, roadworthiness and associated mechanical concerns, determine an appropriate repair methodology and estimated repair costs, and consider the vehicle\'s pre-accident value and economic repair position.'
      },
      vehicle: {
        reg: '', vin: '', make: '', model: '', derivative: '', mileage: '', mileageUnit: 'miles', body: '', fuel: '', transmission: '',
        engineSize: '', engineCode: '', colour: '', paintCode: '', paintType: 'metallic', firstReg: '', oemKey: '',
        sizeClass: 'medium', variantKey: '', dvla: null, motHistory: [], motModel: '',
        adas: '' // ADAS / driver-assistance systems fitted (optional, sent to the AI)
      },
      inspection: {
        date: todayISO(), time: '', location: '', type: 'Physical vehicle inspection / pre-strip engineering assessment',
        condition: '', dismantling: 'No dismantling undertaken. Assessment limited to damage visible and accessible with the vehicle in its assembled condition.',
        photos: 'Yes', diagnostic: '', roadTest: '', warningLamps: '', by: '', byQualifications: ''
      },
      circumstances: { providedBy: '', narrative: '', impactType: '', primaryArea: '', secondaryArea: '', direction: '', symptoms: '', liabilityNote: 'Legal liability is outside the scope of this engineering report.' },
      assessment: { structural: '', mechanical: '', wheels: '', geometry: '', diagnostics: '', roadworthiness: '' },
      zones: [],
      valuation: {
        date: '', mileage: '', costNew: '', condition: 'SATISFACTORY',
        sources: [{ name: "Glass's Guide", amount: '' }, { name: 'CAP HPI', amount: '' }, { name: 'AutoTrader', amount: '' }],
        adopted: '', salvagePct: s.salvagePct, salvageOverride: '', comments: '', belowHighestReason: '',
        adverts: [], historyNotes: '', optionsNotes: '', ai: null,
        claimType: '' // 'own-insurer' | 'third-party' | 'court' | '' (not specified): the valuation standard the AI applies
      },
      outcome: { decision: '', category: '' },
      lines: [],
      discount: 0,
      // labour rates and VAT are snapshotted per job, so later Settings changes do not alter an existing estimate
      rates: clone(s.rates && typeof s.rates === 'object' ? s.rates : DEFAULT_SETTINGS.rates),
      vatPct: s.vatPct != null ? s.vatPct : DEFAULT_SETTINGS.vatPct,
      estimateNotes: '',
      opinion: '',
      photos: [],
      aiFindings: null,
      // provenance: { '<field path>': '<AI text last applied there>' }. A field still holding that text is an unedited AI draft.
      aiText: {},
      customer: { name: '', company: '', representative: '', relationship: 'Owner', address: '', town: '', postcode: '', telephone: '', mobile: '', email: '', vat: '', notes: '' },
      assessor: { name: s.assessor.name, title: s.assessor.title, qualifications: s.assessor.qualifications, aqpId: s.assessor.aqpId, dateSigned: '', signature: '', useDefaultSignature: true }
    };
  }

  function newLine(over) {
    return Object.assign({
      id: uid(), type: 'Body', description: '', partNo: '', code: '', side: '', hours: 0, rate: '', amount: 0,
      costClass: 'parts', ai: false, source: ''
    }, over || {});
  }

  // ---------- calculations ----------
  // Labour value of one line, rounded to the penny the same way everywhere, so printed lines add up to TOTAL LABOUR.
  const lineLabour = (hours, rate) => Math.round(Math.round(num(hours) * 100) * Math.round(num(rate) * 100) / 100) / 100;
  // The snapshot frozen when the report was finalised (job.issued), or null.
  const issuedOf = (job) => (job && job.issued && typeof job.issued === 'object' && !Array.isArray(job.issued) ? job.issued : null);
  const given = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null && o[k] !== '';
  // VAT % for a job: the finalised report's snapshot, else the job's own snapshot, else the current Settings.
  const vatPctFor = (job) => {
    const iss = issuedOf(job);
    if (iss && given(iss, 'vatPct')) return num(iss.vatPct);
    return job && job.vatPct != null && job.vatPct !== '' ? num(job.vatPct) : num(settings.vatPct);
  };
  // Economic-repair threshold: a blank (or 0) setting falls back to the default instead of flagging every job.
  const berThreshold = () => { const n = parseFloat(settings.berThresholdPct); return isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.berThresholdPct; };
  // Valuation sources the report can show: a name and a positive amount. Unnamed rows are ignored everywhere.
  const namedSources = (job) => arr(obj(obj(job).valuation).sources).filter((x) => x && txt(x.name).trim() && num(x.amount) > 0);
  // Explicit line rate → (finalised report: the issued rate for the line type, else its Body rate) → the job's own rate for
  // the line type → Settings rate for the type → Body rate (job, then Settings).
  function lineRate(job, line) {
    const l = obj(line);
    if (l.rate != null && txt(l.rate).trim() !== '') return num(l.rate);
    const type = txt(l.type);
    const iss = issuedOf(job);
    const ir = iss && iss.rates && typeof iss.rates === 'object' ? iss.rates : null;
    if (ir && given(ir, type)) return num(ir[type]);
    if (ir && given(ir, 'Body')) return num(ir.Body);
    const jr = obj(job && job.rates), sr = obj(settings.rates);
    if (given(jr, type)) return num(jr[type]);
    if (given(sr, type)) return num(sr[type]);
    return num(given(jr, 'Body') ? jr.Body : sr.Body);
  }
  // What a finalised report freezes of the figures: the effective labour rate for every standard type and every line type in
  // use, and the VAT %. APP stores it as job.issued.rates / job.issued.vatPct; totals() then ignores later Settings changes.
  function rateSnapshot(job) {
    const j = obj(job);
    const types = new Set(['Body'].concat(Object.keys(obj(settings.rates)), Object.keys(obj(j.rates))));
    for (const l of arr(j.lines)) if (l && typeof l === 'object' && txt(l.type)) types.add(txt(l.type));
    const rates = {};
    for (const type of types) rates[type] = lineRate(j, { type });
    return { rates, vatPct: vatPctFor(j) };
  }
  function totals(job) {
    job = obj(job);
    // a discount or a PAV below zero is an input error (qaChecks reports it): neither is allowed to add to the estimate
    const t = { labourHours: 0, labour: 0, parts: 0, paint: 0, other: 0, discount: Math.max(0, num(job.discount)) };
    let labourPence = 0;
    for (const l of arr(job.lines)) {
      if (!l || typeof l !== 'object') continue;
      const h = num(l.hours);
      t.labourHours += h;
      labourPence += Math.round(lineLabour(h, lineRate(job, l)) * 100);
      const a = num(l.amount);
      if (l.costClass === 'paint') t.paint += a;
      else if (l.costClass === 'other') t.other += a;
      else t.parts += a;
    }
    t.labour = labourPence / 100;
    Object.keys(t).forEach((k) => { t[k] = round2(t[k]); });
    t.net = round2(t.labour + t.parts + t.paint + t.other - t.discount);
    t.vatPct = vatPctFor(job);
    t.vat = round2(t.net * t.vatPct / 100);
    t.gross = round2(t.net + t.vat);
    const v = obj(job.valuation);
    t.pav = Math.max(0, num(v.adopted));
    t.salvage = v.salvageOverride !== '' && v.salvageOverride != null ? num(v.salvageOverride) : round2(t.pav * num(v.salvagePct) / 100);
    t.pctNet = t.pav ? round2(t.net / t.pav * 100) : 0;
    t.pctGross = t.pav ? round2(t.gross / t.pav * 100) : 0;
    // economic repair: the chosen basis, the unrounded ratio, and the default threshold when the setting is blank
    t.berBasis = settings.berBasis === 'gross' ? 'gross' : 'net';
    t.berThresholdPct = berThreshold();
    const ratio = t.pav > 0 ? (t.berBasis === 'gross' ? t.gross : t.net) / t.pav * 100 : 0;
    t.berPct = round2(ratio);
    t.berSuggested = t.pav > 0 && ratio >= t.berThresholdPct;
    const vals = namedSources(job).map((x) => num(x.amount));
    t.valMin = vals.length ? Math.min(...vals) : 0;
    t.valMax = vals.length ? Math.max(...vals) : 0;
    t.valAvg = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    return t;
  }

  // ---------- QA checks (rule based, no AI needed) ----------
  // Structural-assessment wording, read clause by clause so that negated ("No structural damage has been
  // identified", "found to be undamaged", "non-structural") and speculative ("cannot be ruled out") statements
  // do not count as recording structural damage.
  const STRUCT_PHRASE = /(?<!non[- ])structural (?:damage|deformation|distortion|failure)/i;
  const STRUCT_MEMBER = /(?<!non[- ])structural (?:members?|components?)|chassis (?:legs?|rails?|members?)|\b[abcd][- ]?pillars?\b|floor ?pans?|inner wings?|suspension turrets?|strut towers?|cross[- ]?members?|sill reinforcements?/i;
  const DAMAGE_WORD = /damag|deform|distort|kink|buckl|crack|fractur|crush|\bbent\b|displac|misalign|pushed|creas|collaps|shear|\btorn\b|\bsplit\b|compromis|sectional|replace|renew|repair|straighten|out of (?:tolerance|alignment|datum|position)|affected|involved/i;
  const NEGATION = /\b(?:no|not|nor|none|never|without|neither|nil)\b|n't\b|\bundamaged\b|\bunaffected\b|\bintact\b|\bfree (?:from|of)\b|\bruled out\b|\bexcluded\b|\b(?:is|are|remains?|appears?) straight\b|\bstructurally sound\b|\bwithin (?:tolerance|limits|specification)\b/i;
  const HEDGE = /\b(?:may|might|could)\s+(?:not\s+|also\s+|well\s+)?(?:have|be|exist)\b|\b(?:possible|possibly|potential|potentially|suspected|suspect|probable|probably|likely|unknown|unclear|unconfirmed|undetermined|tbc)\b|\b(?:if|unless|whether)\b|\bcan ?not (?:yet |currently |presently |at this stage )?(?:be )?(?:ruled out|excluded|discounted|confirmed|established|determined|assessed|fully assessed|conclusively assessed|inspected|seen|verified|rule)\b|\bunable to\b|\bto be confirmed\b/i;
  const NON_STRUCT = /\b(?:sustained|suffered|has|having|is|was|are|were|assessed as|classed as|categorised as|considered)\s+(?:\w+\s+){0,3}?non-structural\b(?!\s+(?:trims?|components?|parts?|panels?|items?|mouldings?|brackets?|clips?))|\bdamage (?:is|was) (?:confined|limited|restricted) to (?:the )?(?:exterior|external|outer|non-structural|cosmetic|bolt-on)/i;
  const clausesOf = (t) => txt(t)
    .split(/(?<=[.!?])\s+|\n+|;\s*|:\s+|,?\s+(?:but|however|whereas|although|though)\b,?\s*|,\s*(?:which|so|therefore|meaning|requiring)\b|,?\s+and\s+(?=(?:the|its|a|an|there|it|this|these|no)\b)/i)
    .map((s) => (s || '').trim()).filter(Boolean);
  // → { records: first clause recording structural damage, denies: first clause saying there is none }
  function structuralWording(text) {
    const res = { records: '', denies: '' };
    for (const raw of clausesOf(text)) {
      const c = raw.replace(/\bnot only\b/gi, ' ');
      const phrase = STRUCT_PHRASE.test(c), member = STRUCT_MEMBER.test(c), nonStruct = NON_STRUCT.test(c);
      if ((!phrase && !member && !nonStruct) || HEDGE.test(c)) continue; // speculative clauses neither record nor deny
      const neg = NEGATION.test(c);
      if ((phrase || (member && DAMAGE_WORD.test(c))) && !neg) { if (!res.records) res.records = raw; } else if (((phrase || member) && neg) || nonStruct) { if (!res.denies) res.denies = raw; }
    }
    return res;
  }
  const snip = (s) => (s.length > 110 ? s.slice(0, 107).trim() + '…' : s);

  // ADAS / geometry: each trigger needs its own calibration or check (a geometry line does not calibrate a camera).
  const CAMERA_CAL = /camera[^.]*calibrat|calibrat[^.]*camera/i;
  const ADAS_CAL = /\badas\b[^.]*calibrat|calibrat[^.]*\badas\b/i;
  const ADAS_NOT = /calibrat|\baim\b|beam sett|alignment|geometry|diagnostic|\bscan\b|coding|initiali[sz]/i; // service lines are not triggers
  const ADAS_RULES = [
    { label: 'ADAS: windscreen / front camera work', codes: ['GL001'],
      re: /\bwindscreen\b(?!\s*(?:washer|wiper|scuttle|cowl|trim|seal|surround|finisher|moulding|rubber|jet|pump|motor|reservoir|bottle|demist|chip))|\b(?:front|forward[- ]facing|lane|multi[- ]?function|mono|stereo) camera\b/i,
      ok: ['GL005', 'EL003'], okText: (x) => (CAMERA_CAL.test(x) && !/surround|\b360\b|around[- ]view|rear|reversing|side|mirror/i.test(x)) || ADAS_CAL.test(x),
      need: 'windscreen / front camera calibration line (GL005 or EL003)' },
    { label: 'ADAS: front radar work', codes: ['EL001', 'FE020'],
      re: /\bradar\b|\badaptive cruise\b|\b(?:acc|aeb) sensor\b/i, not: /blind[- ]?spot|\bbsm\b|\brear\b/i,
      ok: ['EL002'], okText: (x) => (/radar[^.]*calibrat|calibrat[^.]*radar/i.test(x) && !/blind[- ]?spot|\bbsm\b|\brear\b/i.test(x)) || ADAS_CAL.test(x),
      need: 'front radar calibration line (EL002)' },
    { label: 'ADAS: blind-spot radar work', codes: ['RE013'],
      re: /blind[- ]?spot|\bbsm\b|rear radar/i,
      ok: ['EL005'], okText: (x) => /(?:blind[- ]?spot|\bbsm\b|rear radar)[^.]*calibrat|calibrat[^.]*(?:blind[- ]?spot|\bbsm\b|rear radar)/i.test(x) || ADAS_CAL.test(x),
      need: 'blind-spot radar calibration line (EL005)' },
    { label: 'ADAS: surround-view camera work', codes: ['EL004'],
      re: /surround[- ]?view|\b360\b|around[- ]view|bird'?s[- ]eye|(?:side|mirror)[- ]camera/i,
      ok: [], okText: (x) => /(?:surround[- ]?view|\b360\b|around[- ]view|bird'?s[- ]eye|side|mirror)[^.]*calibrat|calibrat[^.]*(?:surround[- ]?view|\b360\b|around[- ]view)/i.test(x) || ADAS_CAL.test(x),
      need: 'surround-view camera calibration line' },
    { label: 'Geometry: steering / suspension work', codes: ['SU001', 'SU002', 'SU004', 'SU006', 'SU007', 'SU008', 'SU011', 'SU014', 'SU016'],
      re: /track[- ]?rod|steering rack|sub[- ]?frame|(?:control|trailing|radius|lower|upper) arm|wishbone|axle beam|twist beam|hub carrier|knuckle/i,
      ok: ['SU017', 'OP012'], okText: (x) => /geometry|(?:wheel|four[- ]wheel|4[- ]?wheel|laser|suspension) alignment|\btracking\b|\btoe\b|camber/i.test(x),
      need: 'four-wheel alignment / geometry line (SU017 or OP012)' },
    { label: 'Parking sensor / camera / mirror work', codes: ['FE019', 'RE007', 'TG007', 'MR001'],
      re: /parking (?:sensor|aid)|\bpdc\b|\bcamera\b|door mirror(?! (?:glass|cap|cover|indicator|repeater|trim|housing|lower))/i,
      ok: ['EL008', 'OP011', 'EL002', 'EL003', 'EL005', 'GL005'], okText: (x) => /post[- ]repair (?:diagnostic|scan|check|test|procedure)|function(?:al)? (?:check|test)|calibrat|coding|initiali[sz]/i.test(x),
      need: 'post-repair function check, diagnostic scan or calibration line (EL008 or OP011)' },
    { label: 'Headlamp work', level: 'info', codes: ['LT001'],
      re: /head ?lamp|headlight/i, not: /washer|levelling|\baim\b|beam/i,
      ok: ['LT009'], okText: (x) => /\baim\b|beam (?:setting|alignment|adjust)|head ?lamp (?:alignment|adjust)|headlight (?:alignment|adjust)/i.test(x),
      need: 'headlamp aim / beam setting line (LT009)' }
  ];
  const RANGE_OF_OPINION = /range of (?:expert |professional )?opinions?|alternative (?:views?|opinions?|explanations?|approach(?:es)?|methods?)|other (?:expert |professional )?(?:views?|opinions?)|opinions? (?:may |might |could )?differ|differing (?:views?|opinions?)|contrary (?:views?|opinions?)|different (?:views?|opinions?)/i;
  const FREE_PART = /existing|supplied|customer|insurer|\bf\.?o\.?c\b|free of charge|no charge|warranty|goodwill/i;
  // Name words that identify a catalogue part in a free-text line ("Front bumper cover" → "front bumper").
  function partWords(name) {
    let w = fold(name).replace(/\([^)]*\)/g, ' ').split('/')[0].replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9 -]+/g, ' ').split(/\s+/).filter(Boolean);
    const generic = /^(?:panel|cover|shell|assembly|skin|outer|section|full|complete)$/, positional = /^(?:front|rear|side|upper|lower|inner|outer|lh|rh|left|right|centre|center)$/;
    while (w.length > 1 && generic.test(w[w.length - 1]) && w.slice(0, -1).some((x) => !positional.test(x))) w = w.slice(0, -1);
    return w.join(' ');
  }
  // Does refinish line x cover the renewed painted part on line l? Same code and side, or a free-text line naming the part.
  function refinishCovers(x, l) {
    if (!isPaintLine(x) || ['blend', 'smart'].includes(x.op) || /blend|polish|smart/i.test(desc(x))) return false;
    if (x.code && x.code === l.code && txt(x.side) === txt(l.side)) return true;
    if (cat(x.code) && x.code !== l.code) return false;
    const name = partWords(cat(l.code).name), xd = fold(desc(x));
    if (!name || !xd.includes(name)) return false;
    const otherSide = l.side === 'R' ? /\b(?:lh|left|n\/s|nearside)\b/ : l.side === 'L' ? /\b(?:rh|right|o\/s|offside)\b/ : null;
    return !(otherSide && otherSide.test(xd));
  }
  // Part numbers compared on letters and digits only ("76850-1KA6A" = "768501KA6A").
  const partKey = (s) => txt(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // How many OTHER researched numbers exist for the part and side of a line that uses a researched number: the right one
  // depends on the variant (facelift, trim, options), so it must be confirmed by VIN. 0 when the line's number is not a
  // researched candidate, or is one the assessor added themselves (their own confirmation).
  function oemAlternatives(oemKey, line) {
    const l = obj(line);
    const pn = partKey(l.partNo);
    if (!pn || !l.code || !oemKey) return 0;
    const cands = arr(oemLookup(oemKey, txt(l.code), txt(l.side))).filter((c) => c && typeof c === 'object');
    const hit = cands.find((c) => partKey(c.oem) === pn);
    if (!hit || hit.user || hit.confidence === 'user') return 0;
    return new Set(cands.map((c) => partKey(c.oem)).filter((k) => k && k !== pn)).size;
  }

  // A total-loss / beyond-economical-repair decision ("Beyond Economical Repair / Total Loss Recommended", "BER", …).
  const isTotalLoss = (decision) => /total|\bber\b|beyond/i.test(txt(decision));
  // Salvage category letter as entered ("cat s", "Category N" → "S", "N").
  const categoryOf = (job) => txt(obj(obj(job).outcome).category).trim().toUpperCase().replace(/^CAT(?:EGORY)?\.?\s*/, '');

  // ---------- AI provenance: fields that still hold the AI's text unchanged ----------
  // job.aiText = { '<field path>': '<AI text applied there>' } (kept by the renderer). A field counts as unreviewed AI text while
  // its current value is the stored AI text (ignoring spacing). Photo titles / captions use photos.<id>.title / .caption.
  const AI_TEXT_FIELDS = [
    ['report.summary', 'Section 01 summary', 'opinion'],
    ['inspection.condition', 'Vehicle condition at inspection (section 04)', 'inspection'],
    ['circumstances.providedBy', 'Account provided by (section 05)', 'circumstances'],
    ['circumstances.narrative', 'Circumstances as reported (section 05)', 'circumstances'],
    ['circumstances.impactType', 'Impact type (section 05)', 'circumstances'],
    ['circumstances.primaryArea', 'Primary impact area (section 05)', 'circumstances'],
    ['circumstances.secondaryArea', 'Secondary contact area (section 05)', 'circumstances'],
    ['circumstances.direction', 'Direction of contact (section 05)', 'circumstances'],
    ['circumstances.symptoms', 'Post-impact symptoms (section 05)', 'circumstances'],
    ['assessment.structural', 'Structural and body/panel assessment (section 06)', 'assessment'],
    ['assessment.mechanical', 'Mechanical assessment (section 06)', 'assessment'],
    ['assessment.wheels', 'Wheels & tyres (section 06)', 'assessment'],
    ['assessment.geometry', 'Wheel alignment / geometry (section 06)', 'assessment'],
    ['assessment.diagnostics', 'Diagnostics & warning lamps (section 06)', 'assessment'],
    ['assessment.roadworthiness', 'Roadworthiness (section 06)', 'assessment'],
    ['valuation.comments', 'Valuation comments (section 07)', 'valuation'],
    ['outcome.decision', 'Economic repair / total-loss decision (section 07)', 'valuation'],
    ['outcome.category', 'Salvage category (section 07)', 'valuation'],
    ['estimateNotes', 'Estimate notes (section 08)', 'estimate'],
    ['opinion', "Engineer's opinion (section 10)", 'opinion']
  ];
  const AI_TEXT_TABS = ['claim', 'vehicle', 'inspection', 'circumstances', 'photos', 'assessment', 'estimate', 'valuation', 'opinion', 'customer', 'signoff'];
  const sameText = (a, b) => txt(a).replace(/\s+/g, ' ').trim() === txt(b).replace(/\s+/g, ' ').trim();
  // own properties only, so job data can never reach Object.prototype ("constructor.name" …)
  function ownPath(o, path) {
    let cur = o;
    for (const k of String(path).split('.')) {
      if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  // → [{ path, label, tab }] in report order: every field whose current text is still the AI's, unedited.
  // Photos left out of the report, and photos since deleted, are not listed.
  function unreviewedAiText(job) {
    const j = obj(job), map = obj(j.aiText);
    const known = new Map(AI_TEXT_FIELDS.map((f, i) => [f[0], i]));
    const nums = photoNumbers(j);
    const photos = arr(j.photos).filter((p) => p && typeof p === 'object');
    const items = [];
    for (const path of Object.keys(map)) {
      const ai = map[path];
      if (typeof ai !== 'string' || !ai.trim()) continue;
      const pm = /^photos\.(.+)\.(title|caption)$/.exec(path);
      if (pm) {
        const p = photos.find((x) => x.id != null && String(x.id) === pm[1]);
        if (!p || p.exclude || !nums.has(p.id)) continue;
        const cur = p[pm[2]];
        if (typeof cur !== 'string' || !cur.trim() || !sameText(cur, ai)) continue;
        const fig = 'IMAGE ' + String(nums.get(p.id)).padStart(2, '0');
        items.push({ path, label: `${pm[2] === 'title' ? 'Title' : 'Caption'} of ${fig}`, tab: 'photos', order: 1000 + nums.get(p.id) * 2 + (pm[2] === 'title' ? 0 : 1) });
        continue;
      }
      const cur = ownPath(j, path);
      if (!(typeof cur === 'string' || typeof cur === 'number') || !txt(cur).trim() || !sameText(cur, ai)) continue;
      const k = known.get(path);
      if (k != null) { items.push({ path, label: AI_TEXT_FIELDS[k][1], tab: AI_TEXT_FIELDS[k][2], order: k }); continue; }
      const head = path.split('.')[0];
      const words = path.split('.').map((s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(': ');
      items.push({ path, label: words.charAt(0).toUpperCase() + words.slice(1), tab: AI_TEXT_TABS.includes(head) ? head : 'report', order: 100000 + items.length });
    }
    return items.sort((a, b) => a.order - b.order).map(({ path, label, tab }) => ({ path, label, tab }));
  }

  // ---------- job summary (the Jobs list) ----------
  // The few fields the Jobs list shows, stored beside each job. Never throws: a damaged job gives safe defaults.
  function jobSummary(job) {
    const str = (x) => (typeof x === 'string' ? x : typeof x === 'number' && isFinite(x) ? String(x) : '');
    const out = { id: undefined, v: SUMMARY_VERSION, rev: 0, updatedAt: '', createdAt: '', reg: '', vehicle: '', ref: '', instructingParty: '', dateOfLoss: '', decision: '', category: '', net: 0, pav: 0, issued: false, photoCount: 0 };
    try {
      const j = obj(job);
      out.id = j.id;
      const v = obj(j.vehicle), r = obj(j.report), ins = obj(j.instruction), oc = obj(j.outcome);
      Object.assign(out, {
        rev: revOf(j), updatedAt: str(j.updatedAt), createdAt: str(j.createdAt), reg: str(v.reg),
        vehicle: [v.make, v.model, v.derivative].map(str).filter((s) => s.trim()).join(' '),
        ref: str(r.ref), instructingParty: str(ins.instructingParty), dateOfLoss: str(ins.dateOfLoss),
        decision: str(oc.decision), category: str(oc.category), issued: !!j.issued,
        photoCount: arr(j.photos).filter((p) => p && typeof p === 'object').length
      });
      const t = totals(j);
      out.net = isFinite(t.net) ? t.net : 0;
      out.pav = isFinite(t.pav) ? t.pav : 0;
    } catch (err) {
      // the defaults above, and the reason (unreadable), so the Jobs list shows the record as one that could not be read
      try { out.unreadable = String((err && err.message) || err).slice(0, 200) || 'This record could not be read.'; } catch (e) { out.unreadable = 'This record could not be read.'; }
    }
    return out;
  }

  function qaChecks(job) {
    job = obj(job);
    const t = totals(job);
    const out = [];
    const add = (level, msg, tab) => out.push({ level, msg, tab });
    const v = obj(job.vehicle), ins = obj(job.instruction), insp = obj(job.inspection), rep = obj(job.report);
    const oc = obj(job.outcome), ass = obj(job.assessment), val = obj(job.valuation), asr = obj(job.assessor);
    const issued = job.issued && typeof job.issued === 'object' ? job.issued : null;
    const sa = obj(settings.assessor);
    const lines = arr(job.lines).map((l) => obj(l));
    const photos = arr(job.photos).map((p) => obj(p));
    const shown = photos.filter((p) => !p.exclude); // only photos printed in the report count
    const d = desc;
    if (!v.reg) add('error', 'Registration is missing.', 'vehicle');
    if (!v.make || !v.model) add('error', 'Make / model is missing.', 'vehicle');
    const vin = decodeVin(v.vin);
    if (!v.vin) add('warn', 'VIN is missing.', 'vehicle');
    else vin.issues.forEach((i) => add('warn', i, 'vehicle'));
    if (vin.manufacturer && v.make && !vinMakeMatches(vin.manufacturer, v.make)) {
      add('warn', `VIN manufacturer code suggests ${vin.manufacturer}, but make is "${v.make}".`, 'vehicle');
    }
    if (!ins.dateOfLoss) add('error', 'Date of loss is missing.', 'claim');
    if (ins.dateOfLoss && insp.date && insp.date < ins.dateOfLoss) add('error', 'Inspection date is before the date of loss.', 'inspection');
    if (!ins.instructingParty) add('warn', 'Instructing party is missing.', 'claim');
    // an entered or imported date that is not a real calendar date ("2023-02-29") is printed as entered, never shifted
    for (const [when, label, tab] of [[ins.dateOfLoss, 'Date of loss', 'claim'], [ins.dateInstructed, 'Date instructions received', 'claim'], [rep.date, 'Report date', 'claim'],
      [insp.date, 'Inspection date', 'inspection'], [v.firstReg, 'First registration date', 'vehicle'], [asr.dateSigned, 'Date signed', 'signoff']]) {
      const s = txt(when).trim();
      if (s && !calendarDate(s)) add('warn', `${label} "${s}" is not a valid date (YYYY-MM-DD). The report prints it as entered: correct it before issuing.`, tab);
    }
    if (!shown.length) add('warn', photos.length ? `No photographs are included in the report (${photos.length} excluded).` : 'No photographs attached.', 'photos');
    const unlabelled = shown.filter((p) => !p.title).length;
    if (unlabelled) add('info', `${unlabelled} photo(s) in the report have no title.`, 'photos');
    const aiLabelled = shown.filter((p) => !p.labelsReviewed && arr(p.labels).some((x) => x && x.ai && !x.hidden)).length;
    if (aiLabelled) add('warn', `${aiLabelled} photo(s) in the report carry AI damage labels that have not been reviewed. Open "Edit labels" on each, check the labels and save.`, 'photos');
    if (!lines.length) add('warn', 'Repair estimate has no lines.', 'estimate');
    lines.forEach((l, i) => {
      if (!d(l)) add('warn', `Estimate line ${i + 1} has no description.`, 'estimate');
      if (l.costClass === 'parts' && num(l.amount) > 0 && !l.partNo) add('info', `Line ${i + 1} (${d(l)}) has a part cost but no part number.`, 'estimate');
      if (!num(l.hours) && !num(l.amount)) add('info', `Line ${i + 1} (${d(l) || 'blank'}) has no hours and no cost.`, 'estimate');
      if (isRenewLine(l) && (l.costClass || 'parts') === 'parts' && !num(l.amount) && !isServiceCode(l.code) && !FREE_PART.test(txt(l.partNo))) add('warn', `Line ${i + 1} (${d(l) || 'blank'}) renews a part but has no part price.`, 'estimate');
      if (l.ai && !l.reviewed) add('warn', `Line ${i + 1} (${d(l)}) was suggested by AI and has not been marked as reviewed.`, 'estimate');
      const alt = oemAlternatives(v.oemKey, l);
      if (alt) add('info', `Line ${i + 1} uses researched part number ${txt(l.partNo).trim()}; there ${alt === 1 ? 'is 1 alternative (variant)' : `are ${alt} alternatives (variants)`}: confirm by VIN.`, 'estimate');
    });
    const renewedPainted = lines.filter((l) => cat(l.code) && cat(l.code).refinishHrs > 0 && isRenewLine(l) && !isPaintLine(l));
    renewedPainted.forEach((l) => {
      if (!lines.some((x) => x !== l && refinishCovers(x, l))) add('info', `"${d(l)}" renews a painted part, but no refinish line covers it.`, 'estimate');
    });
    if (t.net < 0) add('error', t.discount > 0 ? `The discount (${gbp(t.discount)}) is larger than the estimate, so the net repair cost is ${gbp(t.net)}. Reduce the discount.` : `The net repair cost is negative (${gbp(t.net)}). Check the hours and amounts.`, 'estimate');
    // totals() ignores a negative discount or PAV; the entry itself is an error
    if (num(job.discount) < 0) add('error', `The discount is negative (${gbp(job.discount)}), so it is ignored. A discount must be zero or more: enter it as a positive amount, or add an estimate line for an extra charge.`, 'estimate');
    if (num(val.adopted) < 0) add('error', `The pre-accident value is negative (${gbp(val.adopted)}), so it is treated as not assessed. Enter it as a positive amount.`, 'valuation');
    if (!(t.pav > 0)) add('warn', 'No pre-accident value adopted.', 'valuation');
    if (t.pav > 0) {
      // the BER basis chosen in Settings (net or gross); never show a rounded figure on the wrong side of the threshold
      const ratio = (t.berBasis === 'gross' ? t.gross : t.net) / t.pav * 100;
      const pct = !t.berSuggested && t.berPct >= t.berThresholdPct ? Math.floor(ratio * 100) / 100 : t.berPct;
      if (t.berSuggested && oc.decision === 'Repair') add('warn', `Repair cost is ${pct}% (${t.berBasis}) of PAV, at or above your ${t.berThresholdPct}% threshold, but the decision is "Repair".`, 'valuation');
      if (!t.berSuggested && isTotalLoss(oc.decision)) add('info', `Decision is total loss, but repair cost is ${pct}% (${t.berBasis}) of PAV, below your ${t.berThresholdPct}% threshold. Make sure the opinion explains why.`, 'opinion');
    }
    // a salvage category belongs to a total loss only (the report prints "Not applicable" beside any other decision)
    const catL = categoryOf(job), totalLoss = isTotalLoss(oc.decision);
    if (catL && !totalLoss) {
      const dec = txt(oc.decision).trim();
      if ((catL === 'A' || catL === 'B') && /repair/i.test(dec)) add('error', `Category ${catL} (${catL === 'A' ? 'scrap' : 'break for parts'}) is recorded with the decision "${dec}". A Category ${catL} vehicle must not return to the road, so it cannot be repaired: change the category or the decision.`, 'valuation');
      else add('warn', `A salvage category (Category ${catL}) is recorded, but the decision is ${dec ? `"${dec}"` : 'not set'}. A salvage category applies only to a total loss (beyond economical repair): clear the category or change the decision. Until then the report prints the category as "Not applicable".`, 'valuation');
    }
    const sw = structuralWording(ass.structural);
    if (catL === 'S' && sw.denies && !sw.records) add('warn', `Category S selected, but the structural assessment text says there is no structural damage ("${snip(sw.denies)}"). Check the categorisation.`, 'assessment');
    if (catL === 'N' && sw.records) add('warn', `Category N selected, but the structural assessment text records structural damage ("${snip(sw.records)}"). Check the categorisation.`, 'assessment');
    if (!txt(job.opinion).trim()) add('warn', "Engineer's opinion is empty.", 'opinion');
    // ---- engineer checks ----
    const has = (re) => lines.some((l) => re.test(d(l)));
    // structural parts renewed or repaired (blend, refinish, R&I, checks and measuring do not count)
    const structural = lines.filter((l) => cat(l.code) && cat(l.code).kind === 'S' && !isServiceCode(l.code) && isDamageOp(l));
    if (structural.length && catL === 'N') add('error', `Category N selected, but structural parts are being repaired/renewed (${structural.map((l) => d(l)).join('; ')}). Damage to a structural member rules out Category N.`, 'valuation');
    if (catL && totalLoss && !(asr.aqpId || (issued && issued.aqpId) || sa.aqpId)) add('warn', 'A salvage category is recommended but no AQP (Appropriately Qualified Person) ID is recorded. Add it in Settings → Assessor defaults or on Sign-off.', 'signoff');
    // accreditation: judged at the signature (or report) date, so a report signed while it was valid stays valid
    const expiry = txt(sa.accreditationExpiry).slice(0, 10);
    if (expiry) {
      const today = todayISO();
      const signed = txt(asr.dateSigned).slice(0, 10) || (issued && issued.at ? localISODate(issued.at) : '');
      const ref = signed || txt(rep.date).slice(0, 10) || today;
      if (expiry < ref) add('error', `Your recorded accreditation expiry date (${ukDate(expiry)}) is before the ${signed ? 'signature' : 'report'} date (${ukDate(ref)}). Update it in Settings → Assessor defaults.`, 'signoff');
      else if (expiry < today) add(signed ? 'info' : 'warn', signed ? `Your recorded accreditation expired on ${ukDate(expiry)}, after this report was signed. Renew it before signing new reports.` : `Your recorded accreditation expired on ${ukDate(expiry)}. Renew it (Settings → Assessor defaults) before signing this report.`, 'signoff');
    }
    if (/electric|hybrid|plug-in/i.test(txt(v.fuel)) && (structural.length || arr(job.zones).some((z) => /under|sill/i.test(txt(z))))) add('warn', 'Electric/hybrid vehicle with underbody, sill or structural involvement: assess the high-voltage battery under the ABI salvage code battery provisions and isolate before repair.', 'assessment');
    const srs = lines.filter((l) => cat(l.code) && cat(l.code).group === 'SRS / airbags');
    if (srs.length && !has(/diagnostic/i)) add('warn', 'SRS components are included but there is no diagnostic scan line.', 'estimate');
    // ADAS / geometry: parts renewed, repaired or refitted, each checked against its own calibration or check line
    const fitment = (l) => isDamageOp(l) || l.op === 'rr' || (l.op === 'ai' && /remove (?:&|and) refit/.test(fold(l.aiOperation))) || ((!l.op || l.op === 'ai' || l.op === 'manual') && /remove ?(?:&|and|\/) ?refit|\br ?& ?i\b|\brefit\b/i.test(d(l)));
    const triggered = new Map();
    lines.forEach((l) => {
      if (!fitment(l)) return;
      const text = d(l);
      const rule = ADAS_RULES.find((r) => r.codes.includes(l.code)) || (ADAS_NOT.test(text) ? null : ADAS_RULES.find((r) => r.re.test(text) && !(r.not && r.not.test(text))));
      if (rule) { if (!triggered.has(rule)) triggered.set(rule, []); triggered.get(rule).push(l); }
    });
    for (const [r, ls] of triggered) {
      const done = lines.some((x) => r.ok.includes(x.code) || r.ok.some((c) => OPS[c] && fold(d(x)).includes(fold(OPS[c].name))) || r.okText(d(x)));
      if (!done) add(r.level || 'warn', `${r.label} (${ls.slice(0, 3).map((l) => d(l) || 'blank').join('; ')}${ls.length > 3 ? '…' : ''}) but no ${r.need} is included.`, 'estimate');
    }
    if (lines.length && !has(/pre-repair diagnostic|pre repair diagnostic|pre-repair scan/i)) add('info', 'No pre-repair diagnostic scan line. Most manufacturers require pre- and post-repair scans.', 'estimate');
    const painting = lines.filter((l) => l.type === 'Painting');
    if (renewedPainted.length && /metallic|pearl|three-stage/.test(txt(v.paintType)) && !has(/blend/i)) add('info', `Metallic/pearl colour with renewed painted panels and no blend lines. Consider blending adjacent panels for colour match.`, 'estimate');
    if (painting.length && !lines.some((l) => l.costClass === 'paint' && num(l.amount) > 0)) add('info', 'Refinish labour is included but no paint materials cost.', 'estimate');
    // ---- MOT mileage evidence (DVSA) ----
    const wantKm = /km/i.test(v.mileageUnit || '');
    const toUnit = (n, unit) => { const u = String(unit || '').toLowerCase(); if (u === 'km' && !wantKm) return n * 0.621371; if ((u === 'mi' || u === 'miles') && wantKm) return n * 1.609344; return n; };
    const unitWord = wantKm ? 'km' : 'miles';
    const fmt = (n) => Math.round(n).toLocaleString('en-GB');
    const readings = arr(v.motHistory)
      .filter((t) => t && num(t.odometer) > 0 && t.date && (!t.odometerResult || t.odometerResult === 'READ'))
      .map((t) => ({ date: String(t.date).slice(0, 10), miles: toUnit(num(t.odometer), t.unit) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const cutoff = ins.dateOfLoss || insp.date || '';
    const before = cutoff ? readings.filter((r) => r.date <= cutoff) : readings;
    const after = cutoff ? readings.filter((r) => r.date > cutoff) : [];
    if (num(v.mileage) && before.length) {
      const maxBefore = before.reduce((a, r) => (r.miles > a.miles ? r : a));
      if (num(v.mileage) + 50 < maxBefore.miles) add('error', `Recorded mileage (${fmt(num(v.mileage))} ${unitWord}) is LOWER than the MOT reading of ${fmt(maxBefore.miles)} on ${ukDate(maxBefore.date)}, before the loss. Possible odometer tampering, instrument replacement or an entry error: investigate before valuing.`, 'vehicle');
    }
    for (let i = 1; i < readings.length; i++) {
      if (readings[i].miles + 50 < readings[i - 1].miles) { add('warn', `MOT history shows the mileage going DOWN between ${ukDate(readings[i - 1].date)} (${fmt(readings[i - 1].miles)}) and ${ukDate(readings[i].date)} (${fmt(readings[i].miles)}). Check for an odometer discrepancy.`, 'vehicle'); break; }
    }
    if (after.length) {
      const last = after[after.length - 1];
      const since = num(v.mileage) ? last.miles - num(v.mileage) : 0;
      const offRoad = totalLoss || /off the road|not .*(suitable|roadworthy)|unroadworthy|should not be (used|driven)/i.test(txt(ass.roadworthiness) + ' ' + txt(insp.roadTest));
      add(offRoad ? 'warn' : 'info', `The vehicle was presented for an MOT AFTER the date of loss: ${after.map((r) => `${ukDate(r.date)} at ${fmt(r.miles)} ${unitWord}`).join('; ')}${since > 0 ? ` (${fmt(since)} ${unitWord} more than the inspection reading)` : ''}. ${offRoad ? 'The report treats it as off the road / a total loss: confirm whether it has been repaired or used, and address this in the opinion.' : 'Confirm the repair / usage history.'}`, 'vehicle');
    }
    if (/image|desktop|photo/i.test(txt(insp.type))) {
      const cap = (p) => `${txt(p.title)} ${txt(p.caption)}`;
      if (shown.length < 8) add('warn', `Image-based assessment with only ${shown.length} photo(s) in the report. Desktop reports are commonly challenged on coverage: include all four corners, the damage close-up and in context, VIN plate and odometer.`, 'photos');
      if (!shown.some((p) => /\bodometer\b|\bodo\b|\bmileage\b|\bspeedo(?:meter)?\b|instrument (?:cluster|panel)|\bdash(?:board)?\b/i.test(cap(p)))) add('info', 'No photo identified as the odometer / instrument cluster.', 'photos');
      if (!shown.some((p) => /\bvin\b|chassis (?:no|number|plate)|(?:identification|build|manufacturer'?s) plate/i.test(cap(p)))) add('info', 'No photo identified as the VIN plate.', 'photos');
    }
    if (rep.cpr35) {
      if (!txt(ins.purpose).trim()) add('error', 'CPR 35 report: the substance of the instructions must be stated (Purpose of instruction).', 'claim');
      if (!(asr.qualifications || (issued && issued.qualifications) || sa.qualifications)) add('error', 'CPR 35 report: the expert\'s qualifications must be stated (Settings → Assessor defaults, or on Sign-off).', 'signoff');
      if (!txt(insp.by).trim()) add('error', 'CPR 35 report: state who carried out the examination and any tests (Inspection → Examined by).', 'inspection');
      else if (!txt(insp.byQualifications).trim() && fold(insp.by) !== fold(asr.name)) add('warn', 'CPR 35 report: give the qualifications of the person who carried out the examination (Inspection → Qualifications of examiner).', 'inspection');
      if (!RANGE_OF_OPINION.test(txt(job.opinion))) add('warn', 'CPR 35 report: where there is a range of opinion, summarise it and give reasons for your own view.', 'opinion');
      if (!txt(rep.materialsRelied).trim()) add('error', 'CPR 35 report: give details of the literature and other material relied on in making the report (PD 35 para 3.2(2)), for example the trade guides and adverts, the ABI salvage Code of Practice, the labour-time basis and the data services used (Sign-off → Material relied on).', 'signoff');
    }
    // only real AI use counts (DVLA / DVSA lookups are logged with ai:false)
    const aiUsed = arr(job.aiLog).filter((a) => a && a.ai).length;
    if (aiUsed) add('info', `AI tools were used on this report (${aiUsed} logged action${aiUsed === 1 ? '' : 's'}). The report includes a "Use of AI and data tools" statement listing them (recommended by the Civil Justice Council, Oct 2026).`, 'report');
    // AI-drafted text still exactly as the AI wrote it (job.aiText): one warning per tab, naming the fields
    const byTab = new Map();
    for (const f of unreviewedAiText(job)) { if (!byTab.has(f.tab)) byTab.set(f.tab, []); byTab.get(f.tab).push(f.label); }
    for (const [tab, labels] of byTab) add('warn', `AI-drafted text not yet edited by the assessor: ${labels.join('; ')}. Review it before issuing: while it is unchanged, the report's AI statement lists it as not reviewed.`, tab);
    // review flags the AI attached to an applied narrative draft, kept until the assessor dismisses them
    for (const f of arr(job.aiFlags)) {
      const fl = obj(f), text = txt(fl.text).trim();
      if (!text) continue;
      const section = txt(fl.section).trim(), day = fl.at ? ukDate(localISODate(fl.at)) : '';
      add('warn', `AI review flag${section ? ` (${section})` : ''}${day ? `, ${day}` : ''}: ${text}${/[.!?]$/.test(text) ? '' : '.'} Check it, then dismiss the flag.`, 'opinion');
    }
    // comparables reported by an AI web search whose advert has not been checked (the report lists them separately)
    const unverified = arr(val.adverts).filter((x) => x && typeof x === 'object' && x.aiUnverified && (x.description || x.price));
    if (unverified.length) {
      const name = (x) => [txt(x.description).trim(), txt(x.year).trim(), num(x.price) ? gbp(x.price) : ''].filter(Boolean).join(' ') || 'advert';
      const n = unverified.length;
      add('warn', `${n} advert${n === 1 ? '' : 's'} found by AI web search ${n === 1 ? 'has' : 'have'} not been verified (${unverified.slice(0, 3).map(name).join('; ')}${n > 3 ? `; and ${n - 3} more` : ''}). Open each advert and check it exists at that price, then tick "Verified", or delete it. The report lists unverified adverts separately, not as market evidence.`, 'valuation');
    }
    if (t.pav > 0 && t.valMax && t.pav < t.valMax && !txt(val.belowHighestReason).trim()) add('warn', `Adopted PAV (${gbp(t.pav)}) is below the highest guide figure (${gbp(t.valMax)}). The ombudsman's starting point is the highest retail guide: record the vehicle-specific reason for the lower figure on the Valuation tab.`, 'valuation');
    if (!asr.name) add('error', 'Assessor name is missing.', 'signoff');
    if (!asr.dateSigned) add('info', 'Report has not been dated / signed.', 'signoff');
    return out;
  }

  // ---------- image helpers ----------
  function readFileAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  // True when any pixel drawn on the canvas is not fully opaque.
  function canvasHasAlpha(ctx, w, h) {
    try {
      const px = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
    } catch (e) { /* unreadable canvas: treat as opaque */ }
    return false;
  }
  // Scales an image to fit maxEdge. Re-encoded as JPEG on a WHITE background (JPEG has no transparency, so transparent
  // pixels would otherwise turn black); an image with transparency (a signature, a logo, a PNG diagram) stays a PNG.
  async function resizeDataURL(dataUrl, maxEdge, quality) {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const mayHaveAlpha = !/^data:image\/(?:jpe?g|pjpeg)[;,]/i.test(String(dataUrl));
    if (mayHaveAlpha && canvasHasAlpha(ctx, w, h)) return { dataUrl: c.toDataURL('image/png'), width: w, height: h, type: 'image/png' };
    ctx.globalCompositeOperation = 'destination-over'; // white goes BEHIND what is drawn
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return { dataUrl: c.toDataURL('image/jpeg', quality || 0.85), width: w, height: h, type: 'image/jpeg' };
  }

  window.Core = {
    $, $$, uid, esc, num, round2, gbp, gbp0, hrs, todayISO, localISODate, ukDate, longDate, getPath, setPath, debounce, clone, fold, yearRange,
    Store, DEFAULT_SETTINGS, loadSettings, saveSettings, get settings() { return settings; }, set settings(v) { settings = v; },
    CAT, OPS, sideWord, SIZE_CLASSES, sizeFactor, paintFactor, oemVehicles, setCustomOem, get customOem() { return customOem; }, findOemVehicle, guessOemVehicle, oemLookup, decodeVin,
    newJob, newLine, lineRate, lineLabour, vatPctFor, rateSnapshot, namedSources, totals, qaChecks, isDamageOp, isRenewLine, photoNumbers, oemAlternatives,
    isTotalLoss, unreviewedAiText, jobSummary,
    readFileAsDataURL, loadImage, resizeDataURL
  };
})();
