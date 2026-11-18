// Minimal in-memory IndexedDB for the Store tests (fake-indexeddb is not installed). It follows the parts of the spec the
// app relies on: versioned open (upgradeneeded with oldVersion and the versionchange transaction, blocked, VersionError),
// object stores with an in-line keyPath or out-of-line keys, get / put / add / delete / getAll / getAllKeys / count /
// openCursor, transactions that run in creation order when their scopes overlap and auto-commit once no request is
// pending, request errors that bubble (request → transaction → database) and abort the transaction unless prevented, an
// exception in a callback aborting the transaction, abort() with rollback, and a commit-time quota failure reported only
// as an abort (as Chromium does). It is STRICTER than browsers in one way: a transaction is inactive as soon as a request
// callback returns (browsers keep it active for that callback's microtasks), so code that passes here works there.
'use strict';

const DE = (message, name) => new DOMException(message, name);
const rank = (k) => (typeof k === 'number' ? 1 : k instanceof Date ? 2 : typeof k === 'string' ? 3 : Array.isArray(k) ? 5 : 9);
function validKey(k) {
  return (typeof k === 'number' && !Number.isNaN(k)) || typeof k === 'string' || (k instanceof Date && !Number.isNaN(k.getTime())) || (Array.isArray(k) && k.every(validKey));
}
function cmp(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 2) return a.getTime() - b.getTime();
  if (ra === 5) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  return a < b ? -1 : a > b ? 1 : 0;
}
const event = (type, target, extra) => Object.assign({
  type, target, defaultPrevented: false, stopped: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }
}, extra || {});
function fire(target, ev) {
  ev.currentTarget = target;
  const h = target && target['on' + ev.type];
  if (typeof h === 'function') h.call(target, ev);
}
const copyStores = (rec, scope) => new Map([...rec.stores].filter(([n]) => !scope || scope.includes(n))
  .map(([n, s]) => [n, { keyPath: s.keyPath, records: s.records.map((r) => ({ key: r.key, value: r.value })) }]));

class FakeRequest {
  constructor(source, transaction) { this.source = source; this.transaction = transaction; this.readyState = 'pending'; this.result = undefined; this.error = null; this.onsuccess = this.onerror = null; }
}

class FakeCursor {
  constructor(store, req, rec) { this._store = store; this._req = req; this.key = rec.key; this.primaryKey = rec.key; this.value = structuredClone(rec.value); this._done = false; }
  get source() { return this._store; }
  continue() {
    if (this._done) throw DE('The cursor is being iterated or has iterated past its end.', 'InvalidStateError');
    this._done = true;
    const last = this.key, s = this._store;
    s.transaction._request(() => s._cursorFrom(last, this._req), s, this._req);
  }
}

class FakeObjectStore {
  constructor(tx, name) { this.transaction = tx; this.name = name; }
  get _data() { const d = this.transaction.db._rec.stores.get(this.name); if (!d) throw DE('The object store has been deleted.', 'InvalidStateError'); return d; }
  get keyPath() { return this._data.keyPath; }
  _find(k) { return this._data.records.findIndex((r) => cmp(r.key, k) === 0); }
  _write(value, key, noOverwrite) {
    const t = this.transaction;
    if (t.mode === 'readonly') throw DE('The transaction is read-only.', 'ReadOnlyError');
    t._assertActive();
    const d = this._data;
    const v = structuredClone(value); // DataCloneError, synchronously
    let k;
    if (d.keyPath != null) { if (key !== undefined) throw DE('The object store uses in-line keys and the key parameter was provided.', 'DataError'); k = v == null ? undefined : v[d.keyPath]; } else k = key;
    if (!validKey(k)) throw DE('Evaluating the object store\'s key path did not yield a value.', 'DataError');
    const f = t.db._factory;
    return t._request(() => {
      if (f.failRequest && f.failRequest(this.name, noOverwrite ? 'add' : 'put', v)) throw DE('Simulated request failure.', f.failName || 'UnknownError');
      const i = this._find(k);
      if (i >= 0) { if (noOverwrite) throw DE('Key already exists in the object store.', 'ConstraintError'); d.records[i] = { key: k, value: v }; } else { d.records.push({ key: k, value: v }); d.records.sort((a, b) => cmp(a.key, b.key)); }
      return k;
    }, this);
  }
  put(value, key) { return this._write(value, key, false); }
  add(value, key) { return this._write(value, key, true); }
  get(key) {
    this.transaction._assertActive();
    if (!validKey(key)) throw DE('The parameter is not a valid key.', 'DataError');
    const f = this.transaction.db._factory;
    f._stat('get', this.name);
    return this.transaction._request(() => {
      if (f.failRequest && f.failRequest(this.name, 'get', key)) throw DE('Simulated request failure.', f.failName || 'UnknownError');
      const i = this._find(key); return i >= 0 ? structuredClone(this._data.records[i].value) : undefined;
    }, this);
  }
  delete(key) {
    if (this.transaction.mode === 'readonly') throw DE('The transaction is read-only.', 'ReadOnlyError');
    this.transaction._assertActive();
    if (!validKey(key)) throw DE('The parameter is not a valid key.', 'DataError');
    return this.transaction._request(() => { const i = this._find(key); if (i >= 0) this._data.records.splice(i, 1); return undefined; }, this);
  }
  clear() {
    if (this.transaction.mode === 'readonly') throw DE('The transaction is read-only.', 'ReadOnlyError');
    this.transaction._assertActive();
    return this.transaction._request(() => { this._data.records.length = 0; return undefined; }, this);
  }
  getAll() { this.transaction._assertActive(); this.transaction.db._factory._stat('getAll', this.name); return this.transaction._request(() => this._data.records.map((r) => structuredClone(r.value)), this); }
  getAllKeys() { this.transaction._assertActive(); this.transaction.db._factory._stat('getAllKeys', this.name); return this.transaction._request(() => this._data.records.map((r) => r.key), this); }
  count() { this.transaction._assertActive(); return this.transaction._request(() => this._data.records.length, this); }
  openCursor() {
    this.transaction._assertActive();
    this.transaction.db._factory._stat('openCursor', this.name);
    const req = new FakeRequest(this, this.transaction);
    return this.transaction._request(() => this._cursorFrom(undefined, req), this, req);
  }
  _cursorFrom(last, req) {
    const rec = this._data.records.find((r) => last === undefined || cmp(r.key, last) > 0);
    if (rec) this.transaction.db._factory._stat('cursorValue', this.name);
    return rec ? new FakeCursor(this, req, rec) : null;
  }
}

class FakeTransaction {
  constructor(db, scope, mode, rec) {
    this.db = db; this.mode = mode; this._scope = scope.slice(); this._queue = []; this._state = 'active'; this.error = null;
    this.oncomplete = this.onerror = this.onabort = null;
    this._active = true; // until the task that created it ends
    setImmediate(() => { this._active = false; });
    // the rollback copy is taken when the transaction starts (an earlier overlapping one may still be writing)
    this._before = mode === 'versionchange' ? { version: rec.prevVersion, stores: copyStores(rec) } : null;
    this._started = mode === 'versionchange';
    db._factory._txs.push(this);
    db._factory._log.push({ mode, scope: this._scope.slice() });
    this._schedule();
  }
  get objectStoreNames() { return this._scope.slice(); }
  _assertActive() { if (this._state !== 'active' || !this._active) throw DE('The transaction is not active.', 'TransactionInactiveError'); }
  objectStore(name) {
    if (this._state !== 'active') throw DE('The transaction has finished.', 'InvalidStateError');
    if (!this._scope.includes(name) || !this.db._rec.stores.has(name)) throw DE(`No object store named ${name} in this transaction.`, 'NotFoundError');
    return new FakeObjectStore(this, name);
  }
  abort() {
    if (this._state !== 'active') throw DE('The transaction has already finished.', 'InvalidStateError');
    this._abortWith(null);
  }
  _request(fn, source, req) {
    this._assertActive();
    const r = req || new FakeRequest(source, this);
    r.readyState = 'pending';
    this._queue.push({ r, fn });
    this._schedule();
    return r;
  }
  _blockedBy() {
    // runs only when no earlier unfinished transaction on the same database overlaps its scope (a readwrite one, or any one when this is readwrite)
    const f = this.db._factory;
    for (const t of f._txs) {
      if (t === this) return false;
      if (t._state === 'finished' || t.db._rec !== this.db._rec) continue;
      if (t.mode === 'readonly' && this.mode === 'readonly') continue;
      if (t.mode === 'versionchange' || this.mode === 'versionchange' || t._scope.some((s) => this._scope.includes(s))) return true;
    }
    return false;
  }
  _schedule() { if (this._tick) return; this._tick = true; setImmediate(() => { this._tick = false; this._step(); }); }
  _step() {
    if (this._state !== 'active') return;
    if (!this._started) { if (this._blockedBy()) return; this._started = true; this._before = copyStores(this.db._rec, this._scope); }
    if (this._active && !this._queue.length) { this._schedule(); return; } // the creating task may still add requests
    const item = this._queue.shift();
    if (!item) return this._commit();
    const { r, fn } = item;
    let result, error = null;
    try { result = fn(); } catch (err) { error = err; }
    r.readyState = 'done';
    this._active = true;
    try {
      if (error) {
        r.error = error; r.result = undefined;
        const ev = event('error', r, { bubbles: true });
        fire(r, ev);
        if (!ev.stopped) { fire(this, ev); if (!ev.stopped) fire(this.db, ev); }
        if (!ev.defaultPrevented) { this._active = false; this._abortWith(error); return; }
      } else {
        r.result = result; r.error = null;
        fire(r, event('success', r));
      }
    } catch (err) {
      this._active = false;
      this._abortWith(DE('An exception was thrown in an event handler: ' + (err && err.message), 'AbortError'));
      return;
    }
    this._active = false;
    if (this._state === 'active') this._schedule();
  }
  _commit() {
    const f = this.db._factory;
    // test hook: a slow upgrade (the version-change transaction commits upgradeDelayMs later)
    if (this.mode === 'versionchange' && f.upgradeDelayMs > 0 && !this._delayed) {
      this._delayed = true;
      setTimeout(() => { if (this._state === 'active') this._commit(); }, f.upgradeDelayMs);
      return;
    }
    if (this.mode !== 'readonly' && f.quotaBytes != null && f._size(this.db._rec) > f.quotaBytes) {
      // Chromium: a commit-time quota failure fires 'abort' only (no 'error' event)
      this._abortWith(DE('The current transaction exceeded its quota limitations.', 'QuotaExceededError'));
      return;
    }
    this._state = 'finished';
    f._wake();
    fire(this, event('complete', this));
    if (this._onfinish) this._onfinish(true);
  }
  _abortWith(err) {
    if (this._state === 'finished') return;
    this._state = 'finished';
    this.error = err;
    const rec = this.db._rec;
    if (this.mode === 'versionchange') { rec.stores = this._before.stores; rec.version = this._before.version; } else if (this._before) for (const [n, s] of this._before) if (rec.stores.has(n)) rec.stores.set(n, s);
    const pending = this._queue.splice(0);
    const f = this.db._factory;
    setImmediate(() => {
      for (const { r } of pending) { r.readyState = 'done'; r.error = DE('The transaction was aborted.', 'AbortError'); const ev = event('error', r); try { fire(r, ev); } catch (e) { /* ignored */ } }
      try { fire(this, event('abort', this)); } finally { f._wake(); if (this._onfinish) this._onfinish(false); }
    });
  }
}

class FakeDatabase {
  constructor(factory, name, rec) {
    this._factory = factory; this.name = name; this._rec = rec; this._closed = false; this._upgrade = null;
    this.onversionchange = this.onclose = this.onerror = this.onabort = null;
    factory._conns.add(this);
  }
  get version() { return this._rec.version; }
  get objectStoreNames() {
    const names = [...this._rec.stores.keys()].sort();
    return { contains: (n) => names.includes(n), get length() { return names.length; }, item: (i) => names[i] || null, [Symbol.iterator]: () => names[Symbol.iterator]() };
  }
  createObjectStore(name, opts) {
    const t = this._upgrade;
    if (!t || t._state !== 'active') throw DE('Not in a version change transaction.', 'InvalidStateError');
    if (this._rec.stores.has(name)) throw DE(`Object store ${name} already exists.`, 'ConstraintError');
    this._rec.stores.set(name, { keyPath: opts && opts.keyPath != null ? opts.keyPath : null, records: [] });
    t._scope.push(name);
    return new FakeObjectStore(t, name);
  }
  deleteObjectStore(name) {
    if (!this._upgrade || this._upgrade._state !== 'active') throw DE('Not in a version change transaction.', 'InvalidStateError');
    this._rec.stores.delete(name);
  }
  transaction(names, mode) {
    if (this._closed) throw DE('The database connection is closing.', 'InvalidStateError');
    if (this._upgrade && this._upgrade._state === 'active') throw DE('A version change transaction is running.', 'InvalidStateError');
    const scope = [].concat(names);
    if (!scope.length) throw DE('The scope is empty.', 'InvalidAccessError');
    for (const n of scope) if (!this._rec.stores.has(n)) throw DE(`One of the specified object stores (${n}) was not found.`, 'NotFoundError');
    mode = mode || 'readonly';
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('bad mode');
    return new FakeTransaction(this, scope, mode, this._rec);
  }
  close() { if (this._closed) return; this._closed = true; this._factory._conns.delete(this); this._factory._wakeOpens(); }
}

class FakeIDBFactory {
  constructor() {
    this._dbs = new Map(); this._conns = new Set(); this._txs = []; this._waiting = []; this._log = [];
    this.quotaBytes = null; this.failRequest = null; this.failName = null; this.stats = {}; this.upgradeDelayMs = 0;
  }
  _stat(op, store) { const k = op + ':' + store; this.stats[k] = (this.stats[k] || 0) + 1; }
  _size(rec) { let n = 0; for (const s of rec.stores.values()) for (const r of s.records) n += JSON.stringify(r.value === undefined ? null : r.value).length; return n; }
  _wake() { this._txs = this._txs.filter((t) => t._state !== 'finished'); for (const t of this._txs) if (!t._started) t._schedule(); }
  _wakeOpens() { const w = this._waiting.splice(0); for (const fn of w) setImmediate(fn); }
  cmp(a, b) { if (!validKey(a) || !validKey(b)) throw DE('Not a valid key.', 'DataError'); return Math.sign(cmp(a, b)); }
  deleteDatabase(name) { const req = new FakeRequest(null, null); setImmediate(() => { this._dbs.delete(name); req.readyState = 'done'; fire(req, event('success', req)); }); return req; }
  open(name, version) {
    if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw new TypeError('The version must be a positive integer.');
    const req = new FakeRequest(null, null);
    req.onupgradeneeded = req.onblocked = null;
    setImmediate(() => this._open(req, String(name), version, false));
    return req;
  }
  _open(req, name, version, retried) {
    let rec = this._dbs.get(name);
    const old = rec ? rec.version : 0;
    if (version === undefined) version = old || 1;
    if (version < old) { req.readyState = 'done'; req.error = DE(`The requested version (${version}) is less than the existing version (${old}).`, 'VersionError'); fire(req, event('error', req)); return; }
    if (version === old) { req.readyState = 'done'; req.result = new FakeDatabase(this, name, rec); fire(req, event('success', req)); return; }
    const others = [...this._conns].filter((c) => c.name === name);
    if (!retried) for (const c of others) { try { fire(c, event('versionchange', c, { oldVersion: old, newVersion: version })); } catch (e) { /* ignored */ } }
    if ([...this._conns].some((c) => c.name === name)) {
      if (!retried) fire(req, event('blocked', req, { oldVersion: old, newVersion: version }));
      this._waiting.push(() => this._open(req, name, version, true));
      return;
    }
    const isNew = !rec;
    if (isNew) { rec = { version: 0, stores: new Map() }; this._dbs.set(name, rec); }
    rec.prevVersion = old;
    const conn = new FakeDatabase(this, name, rec);
    const t = new FakeTransaction(conn, [...rec.stores.keys()], 'versionchange', rec);
    rec.version = version;
    conn._upgrade = t;
    req.result = conn; req.transaction = t; req.readyState = 'done';
    t._onfinish = (ok) => {
      req.transaction = null;
      conn._upgrade = null;
      if (ok) { fire(req, event('success', req)); return; }
      conn._closed = true; this._conns.delete(conn);
      if (isNew && rec.version === 0) this._dbs.delete(name);
      req.result = undefined; req.error = DE('Version change transaction was aborted in upgradeneeded event handler.', 'AbortError');
      fire(req, event('error', req));
    };
    try { fire(req, event('upgradeneeded', req, { oldVersion: old, newVersion: version })); } catch (err) { t._abortWith(DE('Upgrade handler threw: ' + (err && err.message), 'AbortError')); }
  }
  // test helpers: the raw records of a store, and a v1 database as the previous app version created it
  dump(name, store) { const rec = this._dbs.get(name); const s = rec && rec.stores.get(store); return s ? s.records.map((r) => structuredClone(r.value)) : null; }
  keys(name, store) { const rec = this._dbs.get(name); const s = rec && rec.stores.get(store); return s ? s.records.map((r) => r.key) : null; }
  version(name) { const rec = this._dbs.get(name); return rec ? rec.version : 0; }
  seed(name, version, stores) {
    const rec = { version, stores: new Map() };
    for (const [sn, def] of Object.entries(stores)) {
      const records = (def.records || []).map((x) => (def.keyPath ? { key: x[def.keyPath], value: structuredClone(x) } : { key: x[0], value: structuredClone(x[1]) }));
      records.sort((a, b) => cmp(a.key, b.key));
      rec.stores.set(sn, { keyPath: def.keyPath || null, records });
    }
    this._dbs.set(name, rec);
  }
}

module.exports = { FakeIDBFactory, cmp, validKey };
