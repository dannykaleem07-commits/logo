/* Engineer Report Studio: UI controller. */
(function () {
  'use strict';
  const C = window.Core;
  const { $, $$, esc, num, gbp, hrs, getPath, setPath } = C;
  const main = $('#main');
  const desktop = window.desktop || null;

  let job = null;            // current job
  let tab = 'claim';
  let aiStatus = { hasKey: false };
  const ui = { pickQ: '', pickGroup: '', pickSide: '', pickOp: 'replace', pickSel: null, addRefinish: true, suggestSel: {}, vp: null, zoneGroups: null, zoneLabel: '', jobId: null };
  // per-job UI state (variant picker, zone filter, AI suggestion ticks, picked part): cleared when a different job is opened
  function resetJobUi(id) { if (ui.jobId === id) return; ui.jobId = id; ui.vp = null; ui.zoneGroups = null; ui.zoneLabel = ''; ui.suggestSel = {}; ui.pickSel = null; }
  // lookups and AI calls in flight, keyed `${kind}:${jobId}`, so a spinner only shows on the job it belongs to
  const running = new Set();
  const busy = (kind) => !!job && running.has(kind + ':' + job.id);
  const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  const httpUrl = (u) => /^https?:\/\//i.test(String(u || '').trim());
  // OEM candidates: only the first one marked for auto-fill may pre-fill a line; line amounts always use the EX-VAT price.
  // Researched numbers fill unless marked "choose by VIN"; the assessor's own numbers only when they ticked auto-fill.
  const autoOem = (cands) => (cands || []).find((c) => c && (c.user ? c.autoFill === true : c.autoFill !== false)) || null;
  const oemPrice = (c, short) => (!c ? '' : c.price ? (short || !c.priceIncVat ? `${gbp(c.price)} ex VAT` : `${gbp(c.price)} ex VAT (${gbp(c.priceIncVat)} inc VAT)`) : c.priceIncVat ? `${gbp(c.priceIncVat)} inc VAT` : '');
  const MARKETS = { US: 'US listing', 'EU-LHD': 'LHD listing', unknown: 'market unknown' };
  const oemBadges = (c) => (c.user ? (c.autoFill === true ? '<span class="badge">auto-fill</span>' : '')
    : [c.role === 'variant' ? 'variant' : '', c.autoFill === false ? 'choose by VIN' : '', MARKETS[c.market] || ''].filter(Boolean).map((b) => `<span class="badge warn">${b}</span>`).join(' '));
  const confBadge = (c) => (c.user ? '<span class="badge user">your number</span>' : `<span class="badge ${c.confidence === 'confirmed' ? 'ok' : 'warn'}">${esc(c.confidence)}</span>`);
  // why no number was filled in: researched numbers that depend on the variant, and/or own numbers without auto-fill
  function noAutoNote(cands) {
    const own = (cands || []).filter((c) => c && c.user).length, res = (cands || []).length - own;
    return [res ? `${res} researched number${res === 1 ? '' : 's'}: choose the variant by VIN` : '', own ? `${own} of your own number${own === 1 ? '' : 's'} (not set to auto-fill)` : ''].filter(Boolean).join('; ');
  }
  // part numbers compared without case, spaces, dots or dashes ("1K0 805-588" = "1K0805588")
  const normPn = (s) => String(s == null ? '' : s).toUpperCase().replace(/[\s.\-‐-―−]/g, '');
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  // readable text for any failure: FileReader / Image errors are DOM Events with no message
  function errText(err, fallback) {
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) return err.message;
    if (typeof Event !== 'undefined' && err instanceof Event) return fallback || 'The file could not be read.';
    return String(err || fallback || 'Something went wrong.');
  }
  const IMAGE_UNREADABLE = 'That image could not be read. Use a JPG or PNG file (HEIC photos from an iPhone are not supported: export them as JPG first).';
  const h1 = (n) => `${(Math.round(num(n) * 10) / 10).toFixed(1)}h`;
  const sameText = (a, b) => String(a == null ? '' : a).replace(/\s+/g, ' ').trim() === String(b == null ? '' : b).replace(/\s+/g, ' ').trim();
  // job.aiText: { '<field path>': '<AI text applied there>' }, so the AI can tell its own earlier drafts from the assessor's text
  const aiTextOf = (j) => (isObj(j.aiText) ? j.aiText : (j.aiText = {}));
  const photoTextPath = (p, field) => `photos.${p.id}.${field}`;
  // True while a photo's title / caption is still unedited AI text: what the AI last suggested (aiTitle / aiCaption) or what was applied.
  function photoTextByAi(j, p, field) {
    const cur = p && p[field];
    if (!String(cur || '').trim()) return false;
    const applied = isObj(j.aiText) ? j.aiText[photoTextPath(p, field)] : '';
    const suggested = field === 'title' ? p.aiTitle : p.aiCaption;
    return [applied, suggested].some((t) => typeof t === 'string' && t.trim() !== '' && sameText(t, cur));
  }
  // Status replies from the main process: { ok, error?, protection: 'os' | 'weak' | 'none', encrypted, … }
  const statusError = (s) => (!isObj(s) ? 'No status was returned.' : s.error ? String(s.error) : s.ok === false ? 'The status could not be read.' : '');
  async function readStatus(fn) { try { const s = await fn(); return isObj(s) ? s : { ok: false }; } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; } }
  // How saved keys are protected on this PC: 'os' = encrypted by the operating system; 'weak' = Linux's fallback with a fixed
  // key (no keyring found); 'none' = no secure storage, so saved as plain text.
  const protectionOf = (s) => (!isObj(s) ? '' : ['os', 'weak', 'none'].includes(s.protection) ? s.protection : s.encrypted === false ? 'none' : s.encrypted === true ? 'os' : '');
  function storageNote(s, one) {
    const p = protectionOf(s), it = one ? 'the key is' : 'the keys are';
    if (p === 'none') return `<b class="keyWarn" style="color:var(--err)">Stored without encryption: this PC has no secure storage, so ${it} saved as plain text.</b>`;
    if (p === 'weak') return `<b class="keyWarn" style="color:var(--err)">Stored without proper encryption: no system keyring was found, so ${it} protected only by a fixed key built into the app (the Linux fallback). Set up a keyring such as GNOME Keyring or KWallet, then save ${one ? 'it' : 'them'} again.</b>`;
    if (p === 'os') return `${one ? 'The key is' : 'Keys are'} encrypted by your operating system and never stored in jobs, backups or reports.`;
    return `${one ? 'The key is' : 'Keys are'} never stored in jobs, backups or reports.`;
  }
  const errBox = (title, msg, extra) => `<div class="card errBox" role="alert" style="border-color:#f0b5ad;background:#fff6f5;margin:8px 0"><b style="color:var(--err)">${esc(title)}</b> ${esc(msg)}${extra || ''}</div>`;
  const flagBox = (title, flags) => (flags.length ? `<div class="card flagBox" style="border-color:#f0c36d;background:#fffaf0;margin-top:10px"><b>${esc(title)}</b><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '');
  const CLAIM_TYPES = [['', 'Not specified'], ['own-insurer', 'Own-insurer total loss (FOS approach)'], ['third-party', 'Third-party claim'], ['court', 'Court (CPR 35)']];
  const claimKey = (s) => { const k = String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_]+/g, '-'); return CLAIM_TYPES.some((c) => c[0] === k) ? k : ''; };
  const claimLabel = (k) => (CLAIM_TYPES.find((c) => c[0] === claimKey(k)) || CLAIM_TYPES[0])[1];

  // ---------- dates ----------
  // Calendar dates are local (core.js's localISODate: Europe/London), never the UTC date of an ISO timestamp.
  const stampOk = (s) => (typeof s === 'string' || typeof s === 'number') && String(s).trim() !== '' && !isNaN(new Date(s).getTime());
  // YYYY-MM-DD of a timestamp (no argument: today), in local time; '' for a missing or invalid timestamp
  function dayOf(s) {
    if (s !== undefined && !stampOk(s)) return '';
    return C.localISODate(s === undefined ? new Date() : new Date(s));
  }
  const today = () => dayOf();
  // a timestamp for display: "—" when it is missing or is not a date
  const fmtWhen = (s) => (stampOk(s) ? new Date(s).toLocaleString('en-GB') : '—');

  const TABS = [
    ['claim', 'Claim'], ['vehicle', 'Vehicle'], ['inspection', 'Inspection'], ['circumstances', 'Circumstances'],
    ['photos', 'Photos & AI'], ['assessment', 'Damage & assessment'], ['estimate', 'Estimate'], ['valuation', 'Valuation & outcome'],
    ['opinion', 'Opinion'], ['customer', 'Customer'], ['signoff', 'Sign-off'], ['report', 'Check & report']
  ];
  const LINE_TYPES = ['Body', 'Painting', 'Mechanical', 'Auxiliary', 'Electrical', 'Other', 'Materials'];
  const COST_CLASSES = [['parts', 'Parts'], ['paint', 'Paint'], ['other', 'Other / service']];
  const DECISIONS = ['', 'Repair', 'Beyond Economical Repair / Total Loss Recommended', 'Total Loss — Uneconomical to Repair', 'Further investigation required'];

  // ---------- toast / modal ----------
  let toastT;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), isErr ? 6500 : 2800);
  }
  // Every modal gets a fresh body element, so listeners added by an earlier modal never fire in a later one.
  // Only one modal is open at a time: openModal() refuses (returns null) while another is open, so a result that finishes in
  // the background can never replace the labeler or the signature pad. A modal with unsaved work passes opts.isDirty, and
  // closing it from the × button, the backdrop or by navigating away asks first.
  let modalGuard = null;
  const modalOpen = () => !$('#modal').classList.contains('hidden');
  const modalDirty = () => { try { return !!(modalGuard && modalGuard()); } catch (e) { return false; } };
  function freshModalBody() { const old = $('#modalBody'); const b = old.cloneNode(false); old.replaceWith(b); return b; }
  function openModal(title, content, opts) {
    if (modalOpen()) return null;
    $('#modalTitle').textContent = title;
    const b = freshModalBody();
    if (typeof content === 'string') b.innerHTML = content; else b.appendChild(content);
    modalGuard = (opts && typeof opts.isDirty === 'function') ? opts.isDirty : null;
    $('#modal').classList.remove('hidden');
    return b;
  }
  function closeModal() { $('#modal').classList.add('hidden'); freshModalBody(); modalGuard = null; }
  // close unless the modal holds unsaved work and the user chooses to keep it; true when it is closed
  function requestCloseModal(question) {
    if (!modalOpen()) return true;
    if (modalDirty() && !confirm(`${question || 'Close this window?'}\n\nWhat you drew or changed in it has not been saved and will be lost.`)) return false;
    closeModal();
    return true;
  }
  // the backdrop closes the modal only when the press also started on it (not a drag that ends outside the card)
  let pressOnBackdrop = false;
  $('#modal').addEventListener('pointerdown', (e) => { pressOnBackdrop = e.target.id === 'modal'; });
  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || (e.target.id === 'modal' && pressOnBackdrop)) requestCloseModal('Close this window?');
    pressOnBackdrop = false;
  });

  // ---------- loaded jobs ----------
  // One object per job id, shared by route() and every background result (jobFor / applyToJob), so a lookup or AI result that
  // lands while the job is being opened or re-opened goes into the object on screen, never into a copy saved over later.
  const loaded = new Map(); // id → { job, promise }
  async function loadJob(id) {
    const hit = loaded.get(id);
    if (hit) return hit.job || hit.promise;
    const entry = { job: null, promise: null };
    entry.promise = (async () => {
      const j = await C.Store.getJob(id);
      if (!isObj(j)) return null;
      if (migrate(j)) { markDirty(j); await Promise.race([flushSave(), delay(ROUTE_SAVE_WAIT)]); }
      return j;
    })();
    loaded.set(id, entry);
    try {
      const j = await entry.promise;
      if (loaded.get(id) === entry) { if (j) entry.job = j; else loaded.delete(id); }
      return j;
    } catch (err) {
      if (loaded.get(id) === entry) loaded.delete(id);
      throw err;
    }
  }
  const remember = (j) => { loaded.set(j.id, { job: j, promise: Promise.resolve(j) }); return j; };
  // a lookup or AI call (not the thumbnail maker) still running for job id
  const callRunning = (id) => [...running].some((k) => !k.startsWith('thumbs:') && k.slice(k.indexOf(':') + 1) === id);
  const anyRunning = (id) => [...running].some((k) => k.slice(k.indexOf(':') + 1) === id);
  // Drops loaded jobs nothing refers to any more: not open, nothing unsaved, no lookup / AI call running for them.
  function pruneLoaded() {
    for (const [id, e] of loaded) if (e.job && !(job && job.id === id) && !pending.has(id) && !failed.has(id) && !conflicted.has(id) && !anyRunning(id)) loaded.delete(id);
  }
  function forgetJob(id) { loaded.delete(id); pending.delete(id); failed.delete(id); conflicted.delete(id); }

  // ---------- saving ----------
  // Changes stay in `pending` until a save that started after them has succeeded. A failed save keeps them and shows a banner
  // with Retry (storage full or unavailable); navigation never waits on storage for more than a few seconds. A job that
  // another window or tab saved meanwhile (ConflictError) is not saved again until it is reloaded.
  const pending = new Map();    // job id → job object with changes not yet stored
  const failed = new Map();     // job id (or 'settings') → the error of its last failed save
  const conflicted = new Set(); // ids of jobs changed elsewhere since they were loaded
  const editSeq = new Map(), savedSeq = new Map(), inflight = new Map(); // per job: latest change, latest change stored, change being stored
  let settingsPending = false;
  const SAVE_TIMEOUT = 20000, ROUTE_SAVE_WAIT = 3000;
  const isConflict = (err) => !!err && err.name === 'ConflictError';
  function withTimeout(p, ms, msg) {
    let tm;
    const t = new Promise((res, rej) => { tm = setTimeout(() => rej(Object.assign(new Error(msg || 'storage did not respond'), { name: 'TimeoutError' })), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(tm));
  }
  function markDirty(j) { pending.set(j.id, j); editSeq.set(j.id, (editSeq.get(j.id) || 0) + 1); }
  const paintSaved = (text) => { const s = $('#savedState'); if (s) s.textContent = text; };
  async function storeJob(j, force) {
    if (conflicted.has(j.id)) { pending.delete(j.id); return false; }
    const seq = editSeq.get(j.id) || 0;
    if (!force && inflight.get(j.id) === seq) return false; // this version is already being stored
    inflight.set(j.id, seq);
    try {
      await withTimeout(C.Store.saveJob(j), SAVE_TIMEOUT, 'storage did not respond within 20 seconds');
      savedSeq.set(j.id, Math.max(savedSeq.get(j.id) || 0, seq));
      failed.delete(j.id);
      if ((editSeq.get(j.id) || 0) === seq && pending.get(j.id) === j) pending.delete(j.id);
      if (j === job && !pending.has(j.id)) paintSaved('Saved ' + new Date().toLocaleTimeString('en-GB'));
      return true;
    } catch (err) {
      if ((savedSeq.has(j.id) ? savedSeq.get(j.id) : -1) >= seq) return false; // a later save of this version already worked
      if (isConflict(err)) { conflicted.add(j.id); pending.delete(j.id); failed.delete(j.id); if (j === job) paintSaved('Not saved: changed elsewhere'); }
      else { failed.set(j.id, err); if (j === job) paintSaved('Not saved'); }
      return false;
    } finally {
      if (inflight.get(j.id) === seq) inflight.delete(j.id);
      showBanners();
    }
  }
  async function saveSettingsNow() {
    try { await withTimeout(Promise.resolve(C.saveSettings()), SAVE_TIMEOUT, 'storage did not respond within 20 seconds'); failed.delete('settings'); }
    catch (err) { failed.set('settings', err); settingsPending = true; }
    showBanners();
  }
  // Stores everything pending. Never rejects. force: try again even where a save of the same version has not answered yet.
  async function flushSave(force) {
    if (settingsPending) { settingsPending = false; await saveSettingsNow(); }
    await Promise.all([...pending.values()].map((j) => storeJob(j, force)));
  }
  const saveSoon = C.debounce(() => { flushSave(); }, 500);
  function changed() {
    if (!job) return;
    if (conflicted.has(job.id)) paintSaved('Not saved: changed elsewhere');
    else { markDirty(job); paintSaved('Saving…'); saveSoon(); }
    updateHeader(); refreshLive();
  }
  const reasonOf = (err) => (err && err.name === 'QuotaExceededError' ? 'the disk is full, or the space this app may use has run out' : errText(err, 'the storage could not be written').replace(/\.$/, ''));
  // Persistent banners above every screen: unsaved changes (with Retry) and jobs changed elsewhere (with Reload).
  function showBanners() {
    const el = $('#banners'); if (!el) return;
    const out = [];
    if (failed.size) {
      out.push(`<div class="banner err" role="alert"><span class="grow"><b>Not saved:</b> storage is full or unavailable — ${esc(reasonOf([...failed.values()].pop()))}. Free disk space, then click Retry.</span><button class="btn sm" data-banner="retry">Retry</button></div>`);
    }
    for (const id of conflicted) {
      const e = loaded.get(id), reg = e && e.job && e.job.vehicle ? e.job.vehicle.reg : '';
      out.push(`<div class="banner warn" role="alert"><span class="grow">${reg ? `<b>${esc(reg)}:</b> ` : ''}This assessment was changed in another window or tab. Reload it to continue.</span><button class="btn sm" data-banner="reload" data-id="${esc(id)}">Reload</button></div>`);
    }
    el.innerHTML = out.join('');
    el.classList.toggle('hidden', !out.length);
  }
  // A job changed elsewhere: drop this window's copy (and its unsaved changes) and read the stored one again.
  async function reloadJob(id) {
    forgetJob(id);
    if (job && job.id === id) job = null;
    showBanners();
    await route();
  }
  $('#banners').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-banner]'); if (!b || b.disabled) return;
    b.disabled = true;
    try {
      if (b.dataset.banner === 'retry') {
        if (failed.has('settings')) settingsPending = true;
        await flushSave(true);
        if (!failed.size) toast('Saved.');
      } else if (b.dataset.banner === 'reload') await reloadJob(b.dataset.id);
    } finally { b.disabled = false; }
  });

  // ---------- form helpers ----------
  // number inputs never take a negative value (money, hours, mileage, percentages)
  const minAttr = (o) => (o.type === 'number' && o.min !== null ? ` min="${o.min == null ? 0 : o.min}"` : '');
  // A field still holding text the AI applied, unedited, says so: the report treats it as AI output until it is edited.
  function aiTextNote(path, val) {
    const t = job && isObj(job.aiText) ? job.aiText[path] : null;
    if (typeof t !== 'string' || !String(val).trim() || !sameText(t, val)) return '';
    return `<div class="hint aiTextHint">✦ AI text, not edited yet. ${path.startsWith('circumstances.') ? 'The report prints it as assessed from the photographs (AI-assisted), not as reported, until you edit it.' : 'The report lists it as unreviewed AI output until you edit it.'}</div>`;
  }
  function F(path, label, o) {
    o = o || {};
    const v = getPath(job, path);
    const val = v == null ? '' : v;
    let input;
    if (o.type === 'textarea') input = `<textarea data-bind="${path}" rows="${o.rows || 4}" placeholder="${esc(o.ph || '')}">${esc(val)}</textarea>`;
    else if (o.type === 'select') input = `<select data-bind="${path}">${o.options.map((x) => { const [k, t] = Array.isArray(x) ? x : [x, x || '—']; return `<option value="${esc(k)}"${String(k) === String(val) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else input = `<input data-bind="${path}" type="${o.type || 'text'}" value="${esc(val)}" placeholder="${esc(o.ph || '')}"${o.list ? ` list="${o.list}"` : ''}${o.step ? ` step="${o.step}"` : ''}${minAttr(o)}>`;
    return `<label class="fld ${o.full ? 'full' : ''}"><span>${esc(label)}</span>${input}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}${o.type === 'select' ? '' : aiTextNote(path, val)}</label>`;
  }
  function S(path, label, o) { // settings field
    o = o || {};
    const v = getPath(C.settings, path);
    const val = v == null ? '' : v;
    let input;
    if (o.type === 'textarea') input = `<textarea data-sbind="${path}" rows="${o.rows || 4}">${esc(val)}</textarea>`;
    else if (o.type === 'select') input = `<select data-sbind="${path}">${o.options.map((x) => { const [k, t] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(k)}"${String(k) === String(val) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else input = `<input data-sbind="${path}" type="${o.type || 'text'}" value="${esc(val)}" ${o.step ? `step="${o.step}"` : ''}${minAttr(o)}>`;
    return `<label class="fld ${o.full ? 'full' : ''}"><span>${esc(label)}</span>${input}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</label>`;
  }

  // ---------- routing ----------
  let routeSeq = 0; // a newer navigation supersedes one still waiting on storage
  let lastUrl = location.href, lastPage = '';
  const pageOf = (parts) => (parts[0] === 'job' && parts[1] ? 'job/' + parts[1] : parts[0] || 'jobs');
  const failCard = (title, err) => { main.innerHTML = `<div class="wrap"><div class="card"><h2 style="margin-top:0">${esc(title)}</h2><p class="hint">${esc(errText(err))}</p><a class="btn" href="#/jobs">← Jobs</a></div></div>`; };
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    // a modal belongs to the page it was opened on; unsaved work in it (labeler, signature pad) is dropped only after a confirm,
    // otherwise the address goes back to where it was and nothing changes (Back / Alt+Left while drawing)
    if (modalOpen() && pageOf(parts) !== lastPage && !requestCloseModal('Leave this page?')) { history.pushState(null, '', lastUrl); return; }
    const seq = ++routeSeq;
    lastUrl = location.href; lastPage = pageOf(parts);
    $$('.side nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] === 'job' ? 'jobs' : parts[0] || 'jobs')));
    await Promise.race([flushSave(), delay(ROUTE_SAVE_WAIT)]); // storage that is full or hangs never holds up navigation
    if (seq !== routeSeq) return;
    if (parts[0] === 'new') {
      try {
        const j = C.newJob();
        migrate(j);
        await withTimeout(C.Store.saveJob(j), SAVE_TIMEOUT, 'storage did not respond within 20 seconds');
        remember(j);
        if (seq === routeSeq) location.replace(`#/job/${j.id}/claim`); // keep #/new out of the history, so Back does not create another job
      } catch (err) {
        if (seq !== routeSeq) return;
        failCard('A new assessment could not be created', `Storage is full or unavailable — ${reasonOf(err)}. Free disk space and try again.`);
        toast('A new assessment could not be created: ' + reasonOf(err), true);
      }
      return;
    }
    if (parts[0] === 'job' && parts[1]) {
      try {
        if (!job || job.id !== parts[1]) {
          const j = await loadJob(parts[1]);
          if (seq !== routeSeq) return;
          if (!j) { job = null; location.replace('#/jobs'); return; }
          resetJobUi(j.id);
          job = j;
        }
        tab = parts[2] || 'claim';
        renderJob();
      } catch (err) {
        job = null;
        failCard('This assessment could not be opened', err);
        toast('This assessment could not be opened: ' + errText(err), true);
      }
      pruneLoaded();
      return;
    }
    job = null;
    rendered = { id: null, tab: null }; // the next job view is a fresh render (no focus or scroll carried over)
    pruneLoaded();
    if (parts[0] === 'settings') return renderSettings();
    if (parts[0] === 'catalogue') return renderCatalogue();
    return renderJobs();
  }

  const isoDate = (s) => { const m = /^(\d{4})[-./](\d{2})[-./](\d{2})/.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
  // Older DVLA records stored the raw VES response; convert them to the normalised shape the Vehicle tab reads.
  const RAW_DVLA_KEYS = ['motExpiryDate', 'monthOfFirstRegistration', 'yearOfFirstRegistration', 'wheelplan'];
  function normaliseRawDvla(d) {
    const out = Object.assign({}, d);
    const pad2 = (n) => String(n).padStart(2, '0');
    if (out.motExpiry == null && d.motExpiryDate != null) out.motExpiry = d.motExpiryDate;
    if (out.wheelPlan == null && d.wheelplan != null) out.wheelPlan = d.wheelplan;
    if (!out.firstRegistration) {
      const m = d.monthOfFirstRegistration;
      if (typeof m === 'string' && /^\d{4}-\d{2}/.test(m)) out.firstRegistration = m.slice(0, 7) + '-01';
      else if (d.yearOfFirstRegistration && m) out.firstRegistration = `${d.yearOfFirstRegistration}-${pad2(m)}-01`;
      else if (d.yearOfFirstRegistration) out.firstRegistration = `${d.yearOfFirstRegistration}-01-01`;
    }
    RAW_DVLA_KEYS.forEach((k) => { delete out[k]; });
    if (!out.lookedUpAt) out.lookedUpAt = '';
    return out;
  }
  // Bring a stored or imported job up to the current shape. Returns true when anything was added or converted.
  function migrate(j) {
    let ch = false;
    const set = (o, k, v) => { o[k] = v; ch = true; };
    const del = (o, k) => { delete o[k]; ch = true; };
    const blank = C.newJob();
    for (const k of Object.keys(blank)) {
      const b = blank[k];
      if (j[k] == null) { if (b != null) set(j, k, b); } // null defaults (aiFindings, …) need no filling
      else if (Array.isArray(b)) { if (!Array.isArray(j[k])) set(j, k, b); }
      else if (isObj(b)) {
        if (!isObj(j[k])) { set(j, k, b); continue; }
        for (const kk of Object.keys(b)) {
          const bv = b[kk], jv = j[k][kk];
          if (jv == null) { if (bv != null) set(j[k], kk, bv); } else if (Array.isArray(bv) && !Array.isArray(jv)) set(j[k], kk, bv);
        }
      }
    }
    // estimate lines: drop junk entries, fill fields added since they were written
    if (j.lines.some((l) => !isObj(l))) set(j, 'lines', j.lines.filter(isObj));
    for (const l of j.lines) {
      const base = C.newLine();
      for (const kk of Object.keys(base)) if (l[kk] == null && base[kk] != null) set(l, kk, base[kk]);
      if (typeof l.description !== 'string') set(l, 'description', String(l.description));
      // the operation and AI fields (op, aiOperation, guideHours, hoursBasis, aiHoursSeen, pfApplied) are kept; only their shape is repaired
      if (l.op != null && typeof l.op !== 'string') del(l, 'op');
      if (l.op === 'replace') set(l, 'op', 'renew'); // the picker's "replace" is stored as "renew"
      if (l.aiOperation != null && typeof l.aiOperation !== 'string') del(l, 'aiOperation');
      if (l.guideHours != null && !(typeof l.guideHours === 'number' && isFinite(l.guideHours))) set(l, 'guideHours', num(l.guideHours));
      if (l.hoursBasis != null) {
        const hb = String(l.hoursBasis).trim().toLowerCase();
        if (hb !== 'guide' && hb !== 'adjusted') del(l, 'hoursBasis'); else if (hb !== l.hoursBasis) set(l, 'hoursBasis', hb);
      }
      if (l.aiHoursSeen != null && !(Array.isArray(l.aiHoursSeen) && l.aiHoursSeen.every((h) => typeof h === 'number'))) del(l, 'aiHoursSeen');
    }
    if (Object.values(j.aiText).some((t) => typeof t !== 'string')) set(j, 'aiText', Object.fromEntries(Object.entries(j.aiText).filter(([, t]) => typeof t === 'string')));
    if (j.valuation.claimType !== claimKey(j.valuation.claimType)) set(j.valuation, 'claimType', claimKey(j.valuation.claimType));
    if (j.photos.some((p) => !isObj(p))) set(j, 'photos', j.photos.filter(isObj));
    for (const p of j.photos) { if (!p.id) set(p, 'id', C.uid()); if (!Array.isArray(p.labels)) set(p, 'labels', []); }
    ['sources', 'adverts'].forEach((k) => { if (Array.isArray(j.valuation[k]) && j.valuation[k].some((x) => !isObj(x))) set(j.valuation, k, j.valuation[k].filter(isObj)); });
    // per-job rates and VAT (snapshotted from Settings when the job was created)
    if (!isObj(j.rates)) set(j, 'rates', C.clone(C.settings.rates));
    else for (const rk of Object.keys(C.settings.rates)) if (j.rates[rk] == null) set(j.rates, rk, C.settings.rates[rk]);
    if (j.vatPct == null) set(j, 'vatPct', C.settings.vatPct);
    // fields added in this version
    const v = j.vehicle;
    if (j.inspection.by == null) set(j.inspection, 'by', '');
    if (j.inspection.byQualifications == null) set(j.inspection, 'byQualifications', '');
    if (j.valuation.belowHighestReason == null) set(j.valuation, 'belowHighestReason', '');
    if (isObj(v.dvla) && !v.dvla.lookedUpAt && RAW_DVLA_KEYS.some((k) => k in v.dvla)) set(v, 'dvla', normaliseRawDvla(v.dvla));
    if (v.firstRegPrecision == null) {
      const fr = String(v.firstReg || '');
      const fromDvla = isObj(v.dvla) && fr === String(v.dvla.firstRegistration || '');
      const fromMot = isObj(v.motSummary) && fr === isoDate(v.motSummary.registrationDate || v.motSummary.firstUsedDate);
      set(v, 'firstRegPrecision', !fr ? '' : fromDvla && !fromMot ? 'month' : 'day');
    }
    // an AI narrative draft waiting for review; the draft's "check before signing" flags; CPR 35 material relied on
    if (j.aiDraftPending != null && !(isObj(j.aiDraftPending) && isObj(j.aiDraftPending.draft))) del(j, 'aiDraftPending');
    if (j.aiFlags != null) {
      const ok = Array.isArray(j.aiFlags) ? j.aiFlags.filter((f) => isObj(f) && typeof f.text === 'string' && f.text.trim()) : [];
      if (!Array.isArray(j.aiFlags) || ok.length !== j.aiFlags.length) set(j, 'aiFlags', ok);
    }
    if (j.report.materialsRelied == null) set(j.report, 'materialsRelied', '');
    // timestamps that are missing or not dates are stored as '' and shown as "—"
    if (j.aiLog.some((a) => !isObj(a))) set(j, 'aiLog', j.aiLog.filter(isObj));
    for (const a of j.aiLog) if (a.at !== '' && !stampOk(a.at)) set(a, 'at', '');
    if (j.issued != null) { if (!isObj(j.issued)) del(j, 'issued'); else if (j.issued.at !== '' && !stampOk(j.issued.at)) set(j.issued, 'at', ''); }
    // numbers stored as text by other tools or older exports ("60,000", "£5,995", "1,5"), read with core.js's tolerant num()
    normaliseNumbers(j, set);
    return ch;
  }
  // Numeric fields as numbers. Fields that may be left blank keep ''; text without a digit is not a number.
  function normaliseNumbers(j, set) {
    const fix = (o, k, blankOk) => {
      if (!isObj(o) || o[k] == null) return;
      const v = o[k];
      if (typeof v === 'number') { if (!isFinite(v)) set(o, k, blankOk ? '' : 0); return; }
      const s = typeof v === 'string' ? v.trim() : '';
      if (!/\d/.test(s)) { if (v !== (blankOk ? '' : 0)) set(o, k, blankOk ? '' : 0); return; }
      set(o, k, C.num(s));
    };
    for (const l of j.lines) { fix(l, 'hours', false); fix(l, 'amount', false); fix(l, 'rate', true); }
    fix(j, 'discount', false); fix(j, 'vatPct', true);
    if (isObj(j.rates)) for (const k of Object.keys(j.rates)) fix(j.rates, k, true);
    const val = j.valuation;
    ['adopted', 'salvagePct', 'salvageOverride', 'mileage'].forEach((k) => fix(val, k, true));
    (Array.isArray(val.sources) ? val.sources : []).forEach((s) => fix(s, 'amount', true));
    (Array.isArray(val.adverts) ? val.adverts : []).forEach((a) => { fix(a, 'mileage', true); fix(a, 'price', true); });
    fix(j.vehicle, 'mileage', true); fix(j.vehicle, 'engineSize', true);
    (Array.isArray(j.vehicle.motHistory) ? j.vehicle.motHistory : []).forEach((t) => fix(t, 'odometer', true));
  }

  // ---------- JOBS LIST ----------
  // Rows come from the small per-job summaries (Store.listSummaries), never from the full records with their photos.
  // One row per summary, each rendered on its own, so one bad record (a summary marked `unreadable`, or one that cannot be read
  // at all) shows an error row instead of blanking the list.
  function jobRow(s) {
    try {
      if (!isObj(s) || !s.id) throw new Error('The record has no ID.');
      if (s.unreadable) throw new Error(s.unreadable);
      const id = esc(s.id), dec = String(s.decision || '');
      return `<tr>
          <td><a href="#/job/${id}/claim"><span class="plate">${esc(s.reg || 'NEW')}</span></a></td>
          <td>${esc(s.vehicle)}</td>
          <td>${esc(s.ref)}${s.issued ? ' <span class="badge ok">finalised</span>' : ''}</td><td>${esc(s.instructingParty)}</td><td>${esc(C.ukDate(String(s.dateOfLoss || '')))}</td>
          <td>${dec ? `<span class="badge ${/total|ber|beyond/i.test(dec) ? 'err' : 'ok'}">${esc(dec.split('/')[0])}${s.category ? ' · Cat ' + esc(s.category) : ''}</span>` : ''}</td>
          <td class="num">${gbp(s.net)}</td><td class="num">${num(s.pav) ? gbp(s.pav) : '—'}</td>
          <td class="hint">${esc(fmtWhen(s.updatedAt))}</td>
          <td class="row" style="flex-wrap:nowrap"><a class="btn sm" href="#/job/${id}/claim">Open</a><button class="btn sm" data-act="dupJob" data-id="${id}">Duplicate</button><button class="btn sm danger" data-act="delJob" data-id="${id}">Delete</button></td></tr>`;
    } catch (err) {
      let reg = '', id = '';
      try { reg = isObj(s) ? String(s.reg || '') : ''; } catch (e) { /* unreadable field */ }
      try { id = isObj(s) && s.id ? esc(s.id) : ''; } catch (e) { /* unreadable field */ }
      return `<tr class="bad"><td><span class="plate">${esc(reg || '?')}</span></td>
          <td colspan="8"><span class="badge err">This record could not be read</span> <span class="hint">${esc(errText(err))}</span></td>
          <td class="row" style="flex-wrap:nowrap">${id ? `<a class="btn sm" href="#/job/${id}/claim">Open</a><button class="btn sm danger" data-act="delJob" data-id="${id}">Delete</button>` : ''}</td></tr>`;
    }
  }
  async function renderJobs() {
    const seq = routeSeq;
    let jobs = [];
    try { jobs = await C.Store.listSummaries(); } catch (err) { toast('Could not read the saved assessments: ' + errText(err), true); }
    if (seq !== routeSeq) return;
    if (!Array.isArray(jobs)) jobs = [];
    const when = (s) => { try { return String((isObj(s) && s.updatedAt) || ''); } catch (e) { return ''; } };
    jobs.sort((a, b) => when(b).localeCompare(when(a)));
    main.innerHTML = `<div class="wrap">
      <div class="row"><div class="grow"><h1>Assessments</h1><div class="sub">Each assessment produces a full engineering &amp; accident damage report.</div></div>
        <button class="btn" data-act="importJob">Import job file</button>
        <button class="btn" data-act="loadSample">Load sample job</button>
        <a class="btn primary" href="#/new">+ New assessment</a></div>
      <div class="card" style="padding:0">${jobs.length ? `<table class="tbl"><thead><tr><th>Registration</th><th>Vehicle</th><th>Report ref</th><th>Instructing party</th><th>Date of loss</th><th>Outcome</th><th class="num">Net repair</th><th class="num">PAV</th><th>Updated</th><th></th></tr></thead><tbody>
        ${jobs.map(jobRow).join('')}
        </tbody></table>` : '<div class="empty">No assessments yet. Start a new one, or load the sample job to see a completed report.</div>'}</div></div>`;
  }

  // ---------- JOB VIEW ----------
  const tabCounts = () => ({ photos: job.photos.length, estimate: job.lines.length, report: C.qaChecks(job).filter((q) => q.level !== 'info').length });
  const tabsHtml = (counts) => TABS.map(([k, t]) => `<a href="#/job/${esc(job.id)}/${k}" class="${k === tab ? 'active' : ''}">${t}${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ''}</a>`).join('');
  function paintTabCounts() { const el = $('.jobhead .tabs'); if (el && job) el.innerHTML = tabsHtml(tabCounts()); }
  const saveStateText = (j) => (conflicted.has(j.id) ? 'Not saved: changed elsewhere' : failed.has(j.id) ? 'Not saved' : pending.has(j.id) ? 'Saving…' : '');
  const LOCKED = 'This report is finalised. Re-open it to edit.';
  let rendered = { id: null, tab: null };
  function renderJob() {
    // a re-render of the same tab (often a lookup or AI result landing) keeps the field being typed in, its caret and the scroll
    const keep = rendered.id === job.id && rendered.tab === tab ? focusState() : null;
    const pd = isObj(job.aiDraftPending) && !job.issued;
    main.innerHTML = `<div class="jobhead"><div class="top">
        <a href="#/jobs" class="link">← Jobs</a><span class="plate">${esc(job.vehicle.reg || 'NEW')}</span>
        <b id="hdVeh">${esc([job.vehicle.make, job.vehicle.model, job.vehicle.derivative].filter(Boolean).join(' ') || 'New assessment')}</b>
        ${job.issued ? '<span class="badge ok">finalised</span>' : ''}<span class="saved" id="savedState">${esc(saveStateText(job))}</span>
        ${pd ? '<button class="btn sm ai draftReady" data-act="reviewPendingDraft">✦ AI draft ready – Review</button>' : ''}
        <div class="chips" id="chips"></div>
      </div>
      <div class="tabs">${tabsHtml(tabCounts())}</div></div>
      <div class="wrap" id="tabBody"></div>`;
    updateHeader();
    const body = $('#tabBody');
    const r = { claim: tabClaim, vehicle: tabVehicle, inspection: tabInspection, circumstances: tabCircumstances, photos: tabPhotos, assessment: tabAssessment, estimate: tabEstimate, valuation: tabValuation, opinion: tabOpinion, customer: tabCustomer, signoff: tabSignoff, report: tabReport }[tab] || tabClaim;
    body.innerHTML = (job.issued ? issuedBanner() : '') + r();
    rendered = { id: job.id, tab };
    afterRender();
    if (job.issued) lockTab(body);
    restoreFocus(keep);
  }
  const issuedBanner = () => `<div class="card lockBanner" role="status"><span class="grow"><b>Finalised on ${esc(fmtWhen(job.issued.at))} — Re-open to edit.</b> <span class="hint">The report's text, figures and photos are locked as issued.</span></span><button class="btn" data-act="reopenReport">Re-open</button></div>`;
  // Finalised report: every input on the tab is disabled and every action except re-open, export and the zone filter is off.
  const LOCK_FREE = new Set(['reopenReport', 'exportPdf', 'exportJson', 'zonePick']);
  function lockTab(body) {
    body.classList.add('locked');
    $$('input, select, textarea', body).forEach((el) => { el.disabled = true; });
    $$('[data-act]', body).forEach((el) => { if (LOCK_FREE.has(el.dataset.act)) return; if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') el.disabled = true; el.setAttribute('aria-disabled', 'true'); });
    $$('[data-zone]', body).forEach((el) => el.setAttribute('aria-disabled', 'true'));
  }
  // The focused field of the job view, found again after a re-render by its data attributes.
  const FOCUS_KEYS = ['bind', 'bindCheck', 'lf', 'pf', 'adv', 'advVerify', 'vs', 'vp'];
  function focusState() {
    const st = { scroll: main.scrollTop };
    const el = document.activeElement;
    if (!el || el === document.body || !main.contains(el)) return st;
    const d = el.dataset || {};
    const k = FOCUS_KEYS.find((x) => d[x] != null);
    let sel = '';
    if (k) sel = `[data-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${CSS.escape(d[k])}"]` + ['id', 'pid', 'i'].filter((x) => d[x] != null).map((x) => `[data-${x}="${CSS.escape(d[x])}"]`).join('');
    else if (el.id) sel = '#' + CSS.escape(el.id);
    if (!sel) return st;
    let a = null, b = null;
    try { a = el.selectionStart; b = el.selectionEnd; } catch (e) { /* not a text field */ }
    return Object.assign(st, { sel, tag: el.tagName, a, b, top: el.scrollTop });
  }
  function restoreFocus(st) {
    if (!st) return;
    if (st.sel) {
      const el = main.querySelector(st.sel);
      if (el && el.tagName === st.tag && !el.disabled) {
        el.focus({ preventScroll: true });
        if (st.a != null) { try { el.setSelectionRange(st.a, st.b); } catch (e) { /* no caret in this kind of input */ } }
        if (st.top) el.scrollTop = st.top;
      }
    }
    main.scrollTop = st.scroll;
  }
  function updateHeader() {
    const el = $('#chips'); if (!el || !job) return;
    const t = C.totals(job);
    el.innerHTML = `<div class="chip">Labour<b>${hrs(t.labourHours)} h</b></div><div class="chip">Net repair<b>${gbp(t.net)}</b></div><div class="chip">Inc. VAT<b>${gbp(t.gross)}</b></div>
      <div class="chip">PAV<b>${t.pav ? gbp(t.pav) : '—'}</b></div><div class="chip ${t.berSuggested ? 'ber' : ''}" title="Economic-repair threshold ${esc(t.berThresholdPct)}% (${esc(t.berBasis)})">Repair / PAV (${esc(t.berBasis)})<b>${t.pav ? num(t.berPct).toFixed(1) + '% ' + esc(t.berBasis) : '—'}</b></div>`;
    const v = $('#hdVeh'); if (v) v.textContent = [job.vehicle.make, job.vehicle.model, job.vehicle.derivative].filter(Boolean).join(' ') || 'New assessment';
    const p = $('.jobhead .plate'); if (p) p.textContent = job.vehicle.reg || 'NEW';
  }
  // Figures shown next to the field being typed in are updated in place (re-rendering the tab would lose focus).
  function refreshLive() {
    if (!job) return;
    const t = C.totals(job);
    const tb = $('#totalsBox'); if (tb) tb.innerHTML = totalsBox(t);
    $$('[data-lv]').forEach((cell) => {
      const l = job.lines.find((x) => x.id === cell.dataset.lv); if (!l) return;
      const r = C.lineRate(job, l);
      cell.textContent = num(l.hours) ? gbp(C.lineLabour(l.hours, r)) : '—';
      const ri = cell.parentElement.querySelector('input[data-lf="rate"]'); if (ri) ri.placeholder = r.toFixed(2);
    });
    const vr = $('#valRange'); if (vr) vr.innerHTML = valRange(t);
    const sh = $('#salvageHint'); if (sh) sh.textContent = '= ' + gbp(C.round2(t.pav * num(job.valuation.salvagePct) / 100));
    const eb = $('#econBox'); if (eb) eb.innerHTML = econBox(t);
  }

  function tabClaim() {
    return `<div class="card"><h2 style="margin-top:0">Report</h2><div class="form3">
      ${F('report.ref', 'Report reference', { hint: '<button class="link" data-act="genRef">Generate from reg &amp; date</button>' })}${F('report.date', 'Report date', { type: 'date' })}${F('report.version', 'Version')}
      ${F('report.status', 'Report status', { full: true, ph: 'e.g. Final Engineering Assessment — Repair' })}</div>
      ${isObj(job.copiedFrom) ? `<p class="hint copiedFrom">Copied from ${esc(job.copiedFrom.ref || 'another assessment')} on ${esc(fmtWhen(job.copiedFrom.at))}, as a new unsigned draft. The original's signature, dates and AI and data-use log stay with it.</p>` : ''}</div>
      <div class="card"><h2 style="margin-top:0">Instruction &amp; claim details</h2><div class="form">
      ${F('instruction.instructingParty', 'Instructing party')}${F('instruction.fileRef', 'Instruction / file reference')}
      ${F('instruction.ownInsurer', 'Own insurer')}${F('instruction.ownRef', 'Own insurer claim reference')}
      ${F('instruction.tpInsurer', 'Third-party insurer')}${F('instruction.tpRef', 'Third-party claim reference')}
      ${F('instruction.dateOfLoss', 'Date of loss', { type: 'date' })}${F('instruction.locationOfLoss', 'Location of loss')}
      ${F('instruction.tpVehicle', 'Third-party vehicle')}${F('instruction.tpReg', 'Third-party registration')}
      ${F('instruction.dateInstructed', 'Date instructions received', { type: 'date' })}<div></div>
      ${F('instruction.purpose', 'Purpose of instruction', { type: 'textarea', full: true })}</div></div>`;
  }

  function tabVehicle() {
    const vin = C.decodeVin(job.vehicle.vin);
    const guess = C.guessOemVehicle(job.vehicle);
    const ov = C.oemVehicles();
    const mot = job.vehicle.motHistory || [];
    const dv = job.vehicle.dvla;
    const ms = job.vehicle.motSummary;
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Vehicle lookup</h2>
        <button class="btn primary" data-act="lookupVehicle" ${desktop && !busy('lookup') ? '' : 'disabled'}>${busy('lookup') ? '<span class="spinner"></span>Looking up…' : 'Look up registration'}</button>
        <button class="btn" data-act="motByVin" ${desktop && job.vehicle.vin && !busy('motvin') ? '' : 'disabled'} title="MOT history by VIN">${busy('motvin') ? '<span class="spinner" style="border-color:#999;border-top-color:#333"></span>' : ''}MOT history by VIN</button></div>
      <p class="hint">Enter the registration (and VIN if you have it) below, then look it up. DVLA fills make, colour, fuel, engine size and first registration; MOT History adds the model and every recorded mileage. Either works on its own. ${desktop ? '' : 'Lookups run in the desktop app.'}</p>
      ${dv ? `<div class="hint"><b>DVLA</b>${dayOf(dv.lookedUpAt) ? ' (' + esc(C.ukDate(dayOf(dv.lookedUpAt))) + ')' : ''}: tax <b>${esc(dv.taxStatus || '—')}</b>${dv.taxDueDate ? ' (due ' + esc(C.ukDate(dv.taxDueDate)) + ')' : ''} · MOT <b>${esc(dv.motStatus || '—')}</b>${dv.motExpiry ? ' (expires ' + esc(C.ukDate(dv.motExpiry)) + ')' : ''}${dv.euroStatus ? ' · ' + esc(dv.euroStatus) : ''}${dv.co2Emissions !== '' && dv.co2Emissions != null ? ' · CO₂ ' + esc(dv.co2Emissions) + ' g/km' : ''}${dv.wheelPlan ? ' · ' + esc(dv.wheelPlan) : ''}${dv.dateOfLastV5CIssued ? ' · last V5C ' + esc(C.ukDate(dv.dateOfLastV5CIssued)) : ''}
        ${dv.markedForExport ? ' · <b style="color:var(--err)">marked for export</b>' : ''}${dv.markedAsScrapped ? ' · <b style="color:var(--err)">marked as scrapped</b>' : ''}${dv.importedOrReRegistered ? ` · <b style="color:var(--warn)">first registered ${esc(C.ukDate(dv.firstRegistration))} but with DVLA ${esc(C.ukDate(dv.firstRegistrationWithDvla))} (import / re-registration)</b>` : ''}</div>` : ''}
      ${ms ? `<div class="hint"><b>MOT History</b>${dayOf(ms.lookedUpAt) ? ' (' + esc(C.ukDate(dayOf(ms.lookedUpAt))) + ')' : ''}: ${esc(ms.make)} ${esc(ms.model)} · ${esc(ms.fuelType)} · ${esc(ms.primaryColour)}${ms.engineSize ? ' · ' + esc(ms.engineSize) + 'cc' : ''} · recall: <b>${esc(ms.recall || 'Unknown')}</b>${ms.motTestDueDate ? ' · first MOT due ' + esc(C.ukDate(ms.motTestDueDate)) : ''}</div>` : ''}
      ${variantPicker()}
    </div>
    ${mot.length ? `<div class="card"><h2 style="margin-top:0">MOT mileage history</h2><table class="tbl"><thead><tr><th>Date</th><th>Result</th><th class="num">Odometer</th><th>Expiry</th><th>Advisories / defects</th></tr></thead><tbody>
      ${mot.map((t) => `<tr><td>${esc(C.ukDate(t.date))}</td><td><span class="badge ${/pass/i.test(t.result) ? 'ok' : 'err'}">${esc(t.result)}</span></td><td class="num">${num(t.odometer) ? num(t.odometer).toLocaleString('en-GB') + ' ' + esc(String(t.unit || '').toLowerCase()) : esc(t.odometerResult || 'not read')}</td><td>${esc(C.ukDate(t.expiry || ''))}</td><td class="hint">${esc((t.defects || []).slice(0, 4).join('; '))}${(t.defects || []).length > 4 ? '…' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card"><div class="form">
      ${F('vehicle.reg', 'Registration')}${F('vehicle.vin', 'VIN / chassis number', { hint: vinHint(vin) })}
      ${F('vehicle.make', 'Make', { list: 'makes' })}${F('vehicle.model', 'Model')}
      ${F('vehicle.derivative', 'Derivative / trim')}${F('vehicle.body', 'Body type / number of doors')}
      ${F('vehicle.mileage', 'Mileage at inspection', { type: 'number' })}${F('vehicle.mileageUnit', 'Mileage unit', { type: 'select', options: ['miles', 'km'] })}
      ${F('vehicle.fuel', 'Fuel type', { type: 'select', options: ['', 'Petrol', 'Diesel', 'Hybrid', 'Plug-in hybrid', 'Electric', 'LPG'] })}${F('vehicle.transmission', 'Transmission', { list: 'gearboxes', ph: 'e.g. Manual, Automatic / DSG, 9G-Tronic' })}
      ${F('vehicle.engineSize', 'Engine size (cc)', { type: 'number' })}${F('vehicle.engineCode', 'Engine code')}
      ${F('vehicle.colour', 'Colour')}${F('vehicle.paintCode', 'Paint code')}
      ${F('vehicle.paintType', 'Paint finish', { type: 'select', options: [['solid', 'Solid'], ['metallic', 'Metallic'], ['pearl', 'Pearlescent'], ['three-stage', '3-stage / tri-coat'], ['matt', 'Matt']], hint: 'Affects refinish time and blend recommendations.' })}
      ${F('vehicle.sizeClass', 'Vehicle size class (scales guide labour times)', { type: 'select', options: Object.entries(C.SIZE_CLASSES).map(([k, v]) => [k, `${v[0]} ×${v[1]}`]) })}
      ${F('vehicle.firstReg', 'First registration date', { type: 'date', hint: job.vehicle.firstRegPrecision === 'month' ? 'DVLA gives the month only, so the report prints the month and year.' : '' })}
      ${F('vehicle.oemKey', 'Parts catalogue vehicle (for OEM part numbers)', { type: 'select', options: [['', '— none —']].concat(ov.map((v) => [v.key, `${v.make} ${v.model} ${v.generation} (${v.years})`])), hint: guess && guess.key !== job.vehicle.oemKey ? `Suggested: <button class="link" data-act="useOem" data-key="${guess.key}">${esc(guess.make + ' ' + guess.model + ' ' + guess.generation)}</button>` : 'Links estimate lines to researched OEM part numbers.' })}
      ${F('vehicle.adas', 'ADAS / driver-assistance systems fitted (optional)', { full: true, ph: 'e.g. windscreen camera (lane keeping), front radar (adaptive cruise), blind-spot radar, parking sensors, 360° cameras', hint: 'From the VIN / build data or the vehicle itself. The AI costs a calibration only for a system recorded here or visible in the photos; otherwise it lists the check and asks you to confirm the fit.' })}
      </div><datalist id="makes">${[...new Set(ov.map((v) => v.make).concat(['Audi', 'BMW', 'Citroën', 'Dacia', 'Fiat', 'Honda', 'Hyundai', 'Kia', 'Land Rover', 'Mazda', 'Mercedes-Benz', 'MG', 'MINI', 'Peugeot', 'Renault', 'SEAT', 'Škoda', 'Tesla', 'Toyota', 'Volvo']))].sort().map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <datalist id="gearboxes">${GEARBOXES.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div>`;
  }
  const GEARBOXES = ['Manual', 'Automatic', 'Automatic / CVT', 'Automatic / DSG', 'Semi-automatic'];
  const fold = C.fold;
  const inYears = (str, y) => { const r = C.yearRange(str); return !y || !r || (y >= r[0] - 1 && y <= r[1]); };
  function vehicleYear() {
    const v = job.vehicle;
    return parseInt((v.firstReg || '').slice(0, 4), 10) || (v.dvla && +v.dvla.yearOfManufacture) || 0;
  }
  function variantChoices(mdl) {
    // Year-matched options first; everything else for the generation stays selectable (period data may be incomplete).
    const y = vehicleYear();
    const all = mdl.engines.map((e, i) => ({ e, i }));
    const engMatch = all.filter((x) => inYears(x.e.years, y));
    const engOther = all.filter((x) => !engMatch.includes(x));
    let trimMatch = [];
    if (mdl.trims_by_period && y) trimMatch = [...new Set(Object.entries(mdl.trims_by_period).filter(([k]) => inYears(k, y)).flatMap(([, t]) => t))];
    const allTrims = [...new Set([...(mdl.trims || []), ...Object.values(mdl.trims_by_period || {}).flat()])];
    const trimOther = allTrims.filter((t) => !trimMatch.includes(t));
    return { y, engMatch, engOther, trimMatch, trimOther };
  }
  // variantKey: make|model|generation|engine badge|trim|body|gearbox|engine signature (the last field since this version: badges
  // repeat within a model, e.g. a 136PS and a 140PS "118i")
  const engineSig = (e) => [e.ps || '', e.years || '', e.fuel || ''].join('/');
  // The picker state for a job's saved variant, or null when the key does not match the variant data (or another make).
  function fromVariantKey(key, make) {
    const f = String(key || '').split('|');
    if (f.length < 7 || !f[0]) return null;
    if (make && fold(make) !== fold(f[0])) return null; // the vehicle has been changed since (e.g. a new lookup)
    const V = window.VARIANTS || [];
    const i = V.findIndex((m) => m.make === f[0] && m.model === f[1] && String(m.generation || '') === f[2]);
    if (i < 0) return null;
    const m = V[i];
    const engs = m.engines.map((e, k) => ({ e, k })).filter((x) => f[3] && x.e.badge === f[3]);
    const eng = (f[7] ? engs.find((x) => engineSig(x.e) === f[7]) : null) || engs[0];
    const trims = [...new Set([...(m.trims || []), ...Object.values(m.trims_by_period || {}).flat()])];
    const pick = (list, v) => (v && (list || []).includes(v) ? v : '');
    return { make: m.make, model: String(i), engine: eng ? String(eng.k) : '', trim: pick(trims, f[4]), body: pick(m.bodies, f[5]), trans: pick(m.transmissions, f[6]) };
  }
  function variantPicker() {
    const V = window.VARIANTS || [];
    if (!V.length) return '';
    const vp = ui.vp || (ui.vp = fromVariantKey(job.vehicle.variantKey, job.vehicle.make) || {});
    const makes = [...new Set(V.map((m) => m.make))].sort();
    if (!vp.make && job.vehicle.make) { const want = fold(job.vehicle.make); const mk = makes.find((m) => fold(m) === want) || makes.find((m) => fold(m).startsWith(want.split(' ')[0])); if (mk) vp.make = mk; }
    const models = V.map((m, i) => ({ m, i })).filter((x) => x.m.make === vp.make);
    if (vp.model === undefined || vp.model === '') {
      const y = vehicleYear(); const md = fold(job.vehicle.model || (job.vehicle.motModel || ''));
      const hit = models.filter((x) => md && (md.includes(fold(x.m.model)) || fold(x.m.model).includes(md.split(' ')[0])) && inYears(x.m.years, y));
      if (hit.length === 1) vp.model = String(hit[0].i);
    }
    const mdl = vp.model !== '' && vp.model != null ? V[+vp.model] : null;
    const ch = mdl ? variantChoices(mdl) : { y: vehicleYear(), engMatch: [], engOther: [], trimMatch: [], trimOther: [] };
    const sel = (name, items, cur, label, dis) => `<select data-vp="${name}" ${dis ? 'disabled' : ''}><option value="">${label}</option>${items.map(([val, text]) => `<option value="${esc(val)}"${String(cur) === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
    const grouped = (name, groups, cur, label, dis) => `<select data-vp="${name}" ${dis ? 'disabled' : ''}><option value="">${label}</option>${groups.filter((g) => g.items.length).map((g) => `<optgroup label="${esc(g.label)}">${g.items.map(([val, text]) => `<option value="${esc(val)}"${String(cur) === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</optgroup>`).join('')}</select>`;
    const engText = (x) => `${x.e.badge}${x.e.ps ? ' ' + x.e.ps + 'PS' : ''} ${x.e.fuel || ''}${x.e.years ? ' (' + x.e.years + ')' : ''}`;
    const yrLabel = ch.y ? `Sold in ${ch.y}` : 'All';
    return `<h3>Exact variant</h3><div class="form3">
      <label class="fld"><span>Make</span>${sel('make', makes.map((m) => [m, m]), vp.make, '— make —')}</label>
      <label class="fld"><span>Model / generation</span>${sel('model', models.map((x) => [x.i, `${x.m.model} ${x.m.generation} (${x.m.years})`]), vp.model, '— model —')}</label>
      <label class="fld"><span>Engine / badge</span>${grouped('engine', [{ label: yrLabel, items: ch.engMatch.map((x) => [x.i, engText(x)]) }, { label: 'Other years', items: ch.engOther.map((x) => [x.i, engText(x)]) }], vp.engine, '— engine —', !mdl)}</label>
      <label class="fld"><span>Trim</span>${grouped('trim', [{ label: ch.trimMatch.length ? `${ch.y} line-up` : 'Trims', items: (ch.trimMatch.length ? ch.trimMatch : ch.trimOther).map((t) => [t, t]) }, { label: 'Other trims for this generation', items: ch.trimMatch.length ? ch.trimOther.map((t) => [t, t]) : [] }], vp.trim, '— trim —', !mdl)}</label>
      <label class="fld"><span>Body</span>${sel('body', (mdl ? mdl.bodies : []).map((t) => [t, t]), vp.body, '— body —', !mdl)}</label>
      <label class="fld"><span>Transmission</span>${sel('trans', (mdl ? mdl.transmissions : []).map((t) => [t, t]), vp.trans, '— gearbox —', !mdl)}</label></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="applyVariant" ${mdl ? '' : 'disabled'}>Use this variant</button>
      ${mdl ? `<span class="hint">${mdl.status === 'verified' ? '<span class="badge ok">core line-up verified from sources</span>' : '<span class="badge warn">from general knowledge: check V5C / VIN</span>'} ${esc(mdl.notes || '').slice(0, 260)}${(mdl.notes || '').length > 260 ? '…' : ''}</span>` : `<span class="hint">${V.length} model generations covered. For anything else, type the derivative below.</span>`}</div>`;
  }
  function applyVariant() {
    const V = window.VARIANTS || []; const vp = ui.vp || {};
    const mdl = V[+vp.model]; if (!mdl) return;
    const e = vp.engine !== '' && vp.engine != null ? mdl.engines[+vp.engine] : null;
    const tr = vp.trim || '', b = vp.body || '', g = vp.trans || '';
    const v = job.vehicle;
    // the variant data carries research notes in brackets, e.g. "8-speed Steptronic (118d, 120d, 128ti)": keep them out of the vehicle fields
    const clean = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    v.make = mdl.make; v.model = `${mdl.model}${mdl.generation ? ' (' + mdl.generation + ')' : ''}`;
    v.derivative = [e && clean(e.badge), clean(tr), clean(b), clean(g)].filter(Boolean).join(' ');
    if (e) { if (e.fuel) v.fuel = variantFuel(e.fuel); if (e.cc) v.engineSize = e.cc; if (e.engine_code) v.engineCode = e.engine_code; }
    if (clean(b)) v.body = clean(b);
    if (clean(g)) v.transmission = clean(g);
    v.variantKey = [mdl.make, mdl.model, mdl.generation, e && e.badge, tr, b, g, e ? engineSig(e) : ''].join('|');
    const guess = C.guessOemVehicle(v); v.oemKey = guess ? guess.key : '';
    changed(); renderJob(); toast('Variant applied: ' + v.derivative);
  }
  // canonical make spelling from our own data (DVLA/DVSA return upper case)
  function canonicalMake(raw) {
    const want = fold(raw);
    if (!want) return '';
    const known = [...new Set((window.VARIANTS || []).map((m) => m.make).concat(C.oemVehicles().map((v) => v.make)).concat(['Audi', 'BMW', 'Citroën', 'Dacia', 'Fiat', 'Honda', 'Hyundai', 'Jaguar', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'MG', 'MINI', 'Mitsubishi', 'Peugeot', 'Porsche', 'Renault', 'SEAT', 'Škoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Vauxhall', 'Volkswagen', 'Volvo', 'Cupra', 'Polestar', 'BYD', 'Alfa Romeo', 'Jeep', 'DS', 'Genesis']))];
    const hit = known.find((m) => fold(m) === want) || (want === 'mercedes' ? 'Mercedes-Benz' : want === 'vw' ? 'Volkswagen' : null);
    if (hit) return hit;
    return String(raw).toLowerCase().replace(/\b([a-z])([a-z]*)/g, (m, a, b) => a.toUpperCase() + b);
  }
  // model names keep short acronyms (GTI, CX-5); colours are title-cased word by word (RED → Red, DARK BLUE → Dark Blue)
  const titleWords = (raw) => String(raw || '').split(/\s+/).map((w) => (w.length <= 3 && /[A-Z]/.test(w) && !/^(THE|AND)$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
  const titleColour = (raw) => String(raw || '').trim().toLowerCase().replace(/(^|[\s/])(\S)/g, (m, a, b) => a + b.toUpperCase());
  // 48V mild hybrids are not high-voltage hybrids: they keep their base fuel
  const MILD_HYBRID = /mild|mhev|48\s*v|eq boost/i;
  function variantFuel(f) {
    f = String(f || '');
    if (/plug/i.test(f)) return 'Plug-in hybrid';
    if (MILD_HYBRID.test(f)) return /diesel/i.test(f) ? 'Diesel' : 'Petrol';
    if (/hybrid/i.test(f)) return 'Hybrid';
    if (/diesel/i.test(f)) return 'Diesel';
    if (/electric/i.test(f)) return 'Electric';
    return 'Petrol';
  }
  function mapFuel(raw) {
    const f = String(raw || '').toLowerCase();
    if (!f) return '';
    if (/plug/.test(f)) return 'Plug-in hybrid';
    if (MILD_HYBRID.test(f)) return /diesel/.test(f) ? 'Diesel' : 'Petrol';
    if (/hybrid/.test(f) || (/electric/.test(f) && /petrol|diesel/.test(f))) return 'Hybrid';
    if (/^electric|electricity/.test(f)) return 'Electric';
    if (/diesel/.test(f)) return 'Diesel';
    if (/gas|lpg/.test(f)) return 'LPG';
    if (/petrol/.test(f)) return 'Petrol';
    return '';
  }
  // The live object for job j: the one loaded object for that id (the open job, or the one being opened), else the stored copy.
  const jobFor = (j) => loadJob(j.id);
  // Apply results to the job they were requested for, even if the user has left it or reopened it meanwhile.
  // Returns the job that was changed, or null if it no longer exists. A finalised job is never changed (it throws).
  async function applyToJob(j, fn) {
    const cur = await jobFor(j);
    if (!cur) return null;
    if (cur.issued) throw new Error(`${regOf(cur)} has been finalised, so this was not applied to it. Re-open the report first.`);
    fn(cur);
    if (cur === job) { changed(); renderJob(); } else { markDirty(cur); await flushSave(); }
    return cur;
  }
  const regOf = (j) => (j && j.vehicle && j.vehicle.reg) || 'the other assessment';
  function applyDvla(j, d) {
    const v = j.vehicle;
    v.dvla = Object.assign({}, d, { lookedUpAt: new Date().toISOString() });
    if (d.make) v.make = canonicalMake(d.make);
    if (d.colour) v.colour = titleColour(d.colour);
    if (mapFuel(d.fuelType)) v.fuel = mapFuel(d.fuelType);
    if (d.engineCapacity) v.engineSize = d.engineCapacity;
    // DVLA gives the month of first registration only; keep a full date from the MOT record when it is the same month
    const fr = isoDate(d.firstRegistration);
    if (fr && !(v.firstRegPrecision === 'day' && String(v.firstReg || '').slice(0, 7) === fr.slice(0, 7))) { v.firstReg = fr; v.firstRegPrecision = 'month'; }
    logAi(j, 'DVLA Vehicle Enquiry Service lookup', 'DVLA', false);
  }
  function applyMot(j, d) {
    const v = j.vehicle;
    v.motModel = d.model || '';
    v.motSummary = { make: d.make, model: d.model, fuelType: d.fuelType, primaryColour: d.primaryColour, engineSize: d.engineSize, recall: d.recall, motTestDueDate: d.motTestDueDate, firstUsedDate: d.firstUsedDate, registrationDate: d.registrationDate, lookedUpAt: new Date().toISOString() };
    if (!v.make && d.make) v.make = canonicalMake(d.make);
    if (!v.model && d.model) v.model = titleWords(d.model);
    if (!v.colour && d.primaryColour) v.colour = titleColour(d.primaryColour);
    if (!v.fuel && mapFuel(d.fuelType)) v.fuel = mapFuel(d.fuelType);
    if (!v.engineSize && Number(d.engineSize)) v.engineSize = Number(d.engineSize);
    // the MOT record's registration date is a full date: it replaces an empty date or DVLA's month for the same month
    const reg = isoDate(d.registrationDate), used = isoDate(d.firstUsedDate);
    if (reg && (!v.firstReg || (v.firstRegPrecision === 'month' && String(v.firstReg).slice(0, 7) === reg.slice(0, 7)))) { v.firstReg = reg; v.firstRegPrecision = 'day'; }
    else if (!v.firstReg && used) { v.firstReg = used; v.firstRegPrecision = 'day'; }
    v.motHistory = d.tests || [];
    logAi(j, `DVSA MOT History lookup (${(d.tests || []).length} tests)`, 'DVSA', false);
  }
  async function lookupVehicle() {
    const j = job;
    if (!j.vehicle.reg) return toast('Enter the registration first.', true);
    const key = 'lookup:' + j.id;
    if (running.has(key)) return;
    const st = await readStatus(() => desktop.data.status());
    if (!st.dvla && !st.mot) return toast(statusError(st) || 'No data connections set up. Add your DVLA key and/or MOT History credentials in Settings → Data connections.', true);
    running.add(key); if (job === j) renderJob();
    const reg = j.vehicle.reg;
    const msgs = [];
    let target = null, gone = false;
    try {
      if (st.dvla) {
        const r = await desktop.data.dvla(reg, C.settings.dvlaEnv || 'live');
        if (r.ok) { target = await applyToJob(j, (x) => applyDvla(x, r.result)); if (target) msgs.push('DVLA details applied'); else gone = true; } else msgs.push('DVLA: ' + r.error);
      }
      if (st.mot && !gone) {
        const r = await desktop.data.mot(reg, 'registration');
        if (r.ok) {
          target = await applyToJob(j, (x) => applyMot(x, r.result));
          if (!target) gone = true;
          else msgs.push(r.result.tests.length ? `MOT history: ${r.result.tests.length} test(s)` : `MOT History: no tests yet${r.result.motTestDueDate ? ' (first MOT due ' + C.ukDate(r.result.motTestDueDate) + ')' : ''}`);
          if (target && /^yes$/i.test(r.result.recall)) msgs.push('DVSA reports an OUTSTANDING RECALL');
        } else msgs.push('MOT History: ' + r.error);
      }
    } catch (err) {
      msgs.push('Lookup: ' + (err.message || err));
    } finally {
      running.delete(key);
      if (target && ui.jobId === j.id) ui.vp = null; // let the variant picker re-detect from the new make / model
      if (job && job.id === j.id) renderJob();
    }
    if (gone) return toast(`The lookup finished, but ${regOf(j)} has been deleted, so nothing was saved.`, true);
    const failed = msgs.some((m) => /^(DVLA|MOT History|Lookup): /.test(m) && !/no tests yet/.test(m));
    const elsewhere = target && target !== job ? ` (saved to ${regOf(target)})` : '';
    toast(msgs.join(' · ') + elsewhere + (failed || elsewhere ? '' : '. Now choose the exact variant.'), failed);
  }
  async function motByVin() {
    const j = job;
    if (!j.vehicle.vin) return toast('Enter the VIN first.', true);
    const key = 'motvin:' + j.id;
    if (running.has(key)) return;
    running.add(key); renderJob();
    let r, target = null;
    try {
      r = await desktop.data.mot(j.vehicle.vin, 'vin');
      if (r.ok) target = await applyToJob(j, (x) => applyMot(x, r.result));
    } finally {
      running.delete(key);
      if (job && job.id === j.id) renderJob();
    }
    if (!r.ok) return toast(r.error, true);
    if (!target) return toast(`${regOf(j)} has been deleted, so the MOT history was not saved.`, true);
    toast(`MOT history by VIN: ${r.result.tests.length} test(s)${target !== job ? ` (saved to ${regOf(target)})` : ''}.`);
  }
  function logAi(j, action, model, ai) { (j.aiLog = Array.isArray(j.aiLog) ? j.aiLog : []).push({ at: new Date().toISOString(), action, model, ai: ai !== false }); }

  function vinHint(vin) {
    if (!job.vehicle.vin) return '17 characters. Manufacturer and model year are read automatically.';
    const bits = [];
    if (vin.manufacturer) bits.push(`Manufacturer code: <b>${esc(vin.manufacturer)}</b>`);
    if (vin.yearCodes) bits.push(`Year code: ${vin.yearCodes.join(' or ')} (not used by all makers in Europe)`);
    vin.issues.forEach((i) => bits.push(`<span style="color:var(--err)">${esc(i)}</span>`));
    return bits.join(' · ');
  }

  function tabInspection() {
    return `<div class="card"><div class="form">
      ${F('inspection.date', 'Inspection date', { type: 'date' })}${F('inspection.time', 'Inspection time')}
      ${F('inspection.by', 'Examined by', { hint: !job.inspection.by && job.assessor.name ? `Who carried out the examination and any tests. <button class="link" data-act="inspByAssessor">Same as the assessor (${esc(job.assessor.name)})</button>` : 'Who carried out the examination and any tests (required for a CPR 35 report).' })}${F('inspection.byQualifications', 'Qualifications of examiner')}
      ${F('inspection.location', 'Inspection location', { type: 'textarea', rows: 3, full: true })}
      ${F('inspection.type', 'Inspection type', { list: 'itypes' })}${F('inspection.photos', 'Photographs taken / source')}
      ${F('inspection.condition', 'Vehicle condition at inspection', { type: 'textarea', full: true })}
      ${F('inspection.dismantling', 'Dismantling carried out', { type: 'textarea', rows: 3 })}${F('inspection.diagnostic', 'Diagnostic scan / tool', { type: 'textarea', rows: 3 })}
      ${F('inspection.roadTest', 'Road test / reason if not completed', { type: 'textarea', rows: 3 })}${F('inspection.warningLamps', 'Warning lamps', { type: 'textarea', rows: 3 })}
      </div><datalist id="itypes"><option value="Physical vehicle inspection / pre-strip engineering assessment"><option value="Image-based (desktop) assessment"><option value="Physical inspection following strip-down"><option value="Re-inspection / supplementary assessment"></datalist></div>`;
  }

  function tabCircumstances() {
    return `<div class="card"><div class="form">
      ${F('circumstances.providedBy', 'Account provided by', { full: true })}
      ${F('circumstances.narrative', 'Circumstances as reported', { type: 'textarea', rows: 7, full: true })}
      ${F('circumstances.impactType', 'Reported impact type', { list: 'impacts' })}${F('circumstances.primaryArea', 'Reported primary impact area')}
      ${F('circumstances.secondaryArea', 'Reported secondary contact area')}${F('circumstances.direction', 'Reported direction of contact')}
      ${F('circumstances.symptoms', 'Post-impact symptoms reported', { type: 'textarea', rows: 3, full: true })}
      ${F('circumstances.liabilityNote', 'Liability note', { full: true })}
      </div><datalist id="impacts"><option value="Sideswipe / lateral side contact"><option value="Rear-end impact"><option value="Frontal impact"><option value="Offset frontal impact"><option value="Side impact (T-bone)"><option value="Low-speed parking contact"><option value="Kerb / object strike"><option value="Multiple impacts"></datalist></div>`;
  }

  // ---------- PHOTOS & AI ----------
  function tabPhotos() {
    const aiReady = !!desktop;
    const f = job.aiFindings;
    const nums = C.photoNumbers(job);
    return `<div class="card">
      <div class="row"><div class="grow"><h2 style="margin:0">Photographs</h2><div class="hint">Add inspection photos. Photos are resized for storage. Draw labels by hand, or let the AI assessor label them. Only photos ticked "in report" are numbered, printed and sent to the AI.</div></div>
        <button class="btn ai" data-act="aiAnalyse" ${!aiReady || !nums.size || busy('photos') ? 'disabled' : ''}>${busy('photos') ? '<span class="spinner"></span>Analysing…' : '✦ AI assess &amp; label photos'}</button></div>
      ${!aiReady ? '<p class="hint">AI tools are available in the desktop app (they need your API key in Settings → AI assessor).</p>' : ''}
      ${job.issued ? '' : `<div class="drop" id="drop" style="margin-top:12px">Drop photos here or <b>click to choose</b> (JPG / PNG / HEIC exported as JPG)</div>
      <input type="file" id="photoInput" accept="image/*" multiple hidden>`}
      <div class="pgrid">${job.photos.map((p) => photoCard(p, nums.get(p.id))).join('')}</div>
    </div>
    ${f ? aiFindingsPanel(f) : ''}`;
  }
  const figLabel = (n) => (n ? 'IMAGE ' + String(n).padStart(2, '0') : 'not in report');
  // ISO date-time ↔ the local "YYYY-MM-DDTHH:MM" a datetime-local input shows
  const localDT = (iso) => { const d = iso ? new Date(iso) : null; if (!d || isNaN(d)) return ''; const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  // Cards show a small thumbnail (made once, stored as photo.thumb); the labeler, the report and the AI use the full image.
  // Controls name their photo by id, so moving or removing a card never needs the grid rebuilt.
  function photoCard(p, n) {
    const pid = esc(p.id);
    return `<div class="pcard ${p.exclude ? 'excluded' : ''}" data-pid="${pid}">
      <div class="pimg" data-act="label" data-pid="${pid}" title="Click to edit labels"><div class="pin"><img src="${esc(p.thumb || p.dataUrl)}" alt="">${Labeler.overlay(p.labels)}</div></div>
      <div class="pbody">
        <div class="row"><b class="pnum${n ? '' : ' out'}">${figLabel(n)}</b>${p.aiLabelled ? `<span class="badge ${p.labelsReviewed ? 'ok' : 'ai'}" title="${p.labelsReviewed ? 'Labels saved by the assessor' : 'Open the labels and save them once checked'}">AI labelled${p.labelsReviewed ? ' · reviewed' : ''}</span>` : ''}<span class="grow"></span>
          <button class="btn sm" data-act="pmove" data-pid="${pid}" data-d="-1" title="Move earlier">↑</button><button class="btn sm" data-act="pmove" data-pid="${pid}" data-d="1" title="Move later">↓</button>
          <button class="btn sm danger" data-act="pdel" data-pid="${pid}" title="Remove">✕</button></div>
        <input data-pf="title" data-pid="${pid}" value="${esc(p.title)}" placeholder="Title, e.g. RH front door - surface damage">
        <textarea data-pf="caption" data-pid="${pid}" placeholder="Caption">${esc(p.caption)}</textarea>
        <div class="row"><input data-pf="source" data-pid="${pid}" value="${esc(p.source)}" placeholder="Source" class="grow" style="width:auto">
          <label class="hint"><input type="checkbox" data-pf="include" data-pid="${pid}" ${p.exclude ? '' : 'checked'} style="width:auto"> in report</label></div>
        <label class="hint row" style="gap:6px;flex-wrap:nowrap" title="When the photo was taken: read from the photo's EXIF data or the file date. Correct it if it is wrong.">Taken<input type="datetime-local" data-pf="takenAt" data-pid="${pid}" value="${localDT(p.takenAt)}" style="width:auto;flex:1"></label>
        <button class="btn sm" data-act="label" data-pid="${pid}">✎ Edit labels (${(p.labels || []).length})</button>
      </div></div>`;
  }
  // after a photo is included / excluded / moved / removed: update every card's figure number and dimming in place
  function refreshPhotoNumbers() {
    const nums = C.photoNumbers(job);
    $$('.pcard[data-pid]').forEach((card) => {
      const p = job.photos.find((x) => String(x.id) === card.dataset.pid); if (!p) return;
      const n = nums.get(p.id);
      card.classList.toggle('excluded', !!p.exclude);
      const b = card.querySelector('.pnum'); if (b) { b.textContent = figLabel(n); b.classList.toggle('out', !n); }
    });
    const ab = $('[data-act="aiAnalyse"]'); if (ab && !busy('photos')) ab.disabled = !desktop || !nums.size || !!job.issued;
  }
  const THUMB_EDGE = 320;
  const thumbFailed = new WeakSet(); // photos whose image could not be read: not retried on every visit
  async function makeThumb(dataUrl) { try { return (await C.resizeDataURL(dataUrl, THUMB_EDGE, 0.8)).dataUrl; } catch (e) { return ''; } }
  // Older photos have no thumbnail yet: made once, in the background, then stored with the job.
  async function ensureThumbs(j) {
    const key = 'thumbs:' + j.id;
    if (running.has(key)) return;
    const todo = j.photos.filter((p) => isObj(p) && !p.thumb && p.dataUrl && !thumbFailed.has(p));
    if (!todo.length) return;
    running.add(key);
    let made = 0;
    try {
      for (const p of todo) {
        const t = await makeThumb(p.dataUrl);
        if (!t) { thumbFailed.add(p); continue; }
        p.thumb = t; made++;
        const img = job === j ? $(`.pcard[data-pid="${CSS.escape(String(p.id))}"] .pimg img`) : null;
        if (img) img.src = t;
      }
    } finally { running.delete(key); }
    if (made && j.photos.some((p) => p && p.thumb)) { markDirty(j); if (j === job) saveSoon(); else await flushSave(); }
  }
  function aiFindingsPanel(f) {
    const s = f.summary || {};
    const lines = f.suggested_lines || [];
    const nums = C.photoNumbers(job);
    // damage the AI found but could not place on its photo (box outside the image or unreadable): listed here, never drawn
    const unplaced = (f.photos || []).filter(isObj).flatMap((ph) => (Array.isArray(ph.unplaced_damages) ? ph.unplaced_damages : []).filter(isObj).map((d) => ({ ph, d })));
    const where = (ph) => (nums.has(ph.id) ? figLabel(nums.get(ph.id)) : `Photo ${ph.index} (no longer in the report)`);
    return `<div class="card aiPanel"><div class="row"><h2 class="grow">✦ AI assessor findings</h2><span class="hint">${esc(f.model || '')} · ${f.at ? new Date(f.at).toLocaleString('en-GB') : ''}</span></div>
      <p class="hint">Suggestions only. Check every item against the vehicle and photos before it goes in the report.</p>
      ${partialNotice(f)}
      ${flagBox('Check before relying on these findings:', (Array.isArray(f.review_flags) ? f.review_flags : []).map((x) => String(x == null ? '' : x)).filter((x) => x.trim()))}
      <div class="form">
        <div><b>Impact type:</b> ${esc(s.impact_type)}<br><b>Primary area:</b> ${esc(s.primary_area)}<br><b>Secondary:</b> ${esc(s.secondary_areas)}<br><b>Direction:</b> ${esc(s.direction_of_contact)}</div>
        <div><b>Structural concern:</b> ${s.structural_concern ? '<span class="badge err">Possible</span>' : '<span class="badge ok">None seen</span>'} ${esc(s.structural_notes)}</div>
        <div class="full"><b>Damage pattern:</b> ${esc(s.damage_pattern)}</div>
        <div class="full"><b>Consistency with circumstances:</b> ${esc(s.consistency_with_circumstances)}</div>
        ${(s.mechanical_checks || []).length ? `<div><b>Mechanical checks:</b><ul>${s.mechanical_checks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${(s.adas_and_calibration || []).length ? `<div><b>ADAS / calibration:</b><ul>${s.adas_and_calibration.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="row" style="margin:8px 0 14px"><button class="btn" data-act="aiApplySummary">Fill empty circumstances / assessment fields &amp; damage zones from these findings</button></div>
      ${unplaced.length ? `<div class="unplaced"><h3>Damage the AI could not place on a photo (${unplaced.length})</h3><p class="hint">Not drawn: the AI's box for these was outside the photo or could not be read. Check each one, and draw a label yourself if it is needed.</p>
        <ul>${unplaced.map(({ ph, d }) => `<li><b>${esc(where(ph))}</b>: ${esc(d.label || 'unnamed')}${d.component_name ? ' — ' + esc([C.sideWord(d.side), d.component_name].filter(Boolean).join(' ')) : ''}${d.damage_type ? ' · ' + esc(d.damage_type) : ''}${d.severity ? ' · ' + esc(d.severity) : ''}${d.accident_related ? ' · accident-related: ' + esc(d.accident_related) : ''}${d.recommended_operation ? ' · ' + esc(d.recommended_operation) : ''}${d.notes ? ' — ' + esc(d.notes) : ''}</li>`).join('')}</ul></div>` : ''}
      <h3>Recommended estimate lines (${lines.length})</h3>
      <table class="tbl sugg"><thead><tr><th><input type="checkbox" data-act="suggAll" style="width:auto" checked></th><th>Type</th><th>Line</th><th>Part no. (catalogue)</th><th class="num">Hours</th><th>Evidence</th><th>Conf.</th></tr></thead><tbody>
      ${lines.map((l, i) => { if (!isObj(l)) return ''; const cands = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side) : []; const o = autoOem(cands); const added = l.added; const hz = aiLineHours(job, l); return `<tr${added ? ' style="opacity:.5"' : ''} data-sugg-row="${i}">
        <td><input type="checkbox" data-sugg="${i}" style="width:auto" ${ui.suggestSel[i] === false || added ? '' : 'checked'} ${added ? 'disabled' : ''}></td>
        <td>${esc(l.type)}</td><td><b>${esc(l.description)}</b>${l.code && l.code !== 'OTHER' ? ` <code class="hint">${esc(l.code)}${l.side ? '-' + esc(l.side) : ''}${l.operation ? ' · ' + esc(l.operation) : ''}</code>` : ''}${added ? ' <span class="badge ok">added</span>' : ''}</td>
        <td>${o ? `<span class="oem ${o.user ? 'user' : esc(o.confidence)}">${esc(o.oem)}</span>` : cands.length ? `<span class="hint">${esc(noAutoNote(cands))}</span>` : (l.needs_part ? '<span class="hint">price needed</span>' : '')}</td>
        <td class="num">${hrs(hz.hours)}${suggHoursNote(l, hz)}</td><td class="reason">${esc(l.reason)}</td>
        <td><span class="conf" title="${Math.round(num(l.confidence) * 100)}%"><i style="width:${Math.round(num(l.confidence) * 100)}%"></i></span></td></tr>`; }).join('')}
      </tbody></table>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="aiAddLines">Add selected lines to estimate</button><span class="hint">They are added marked "AI" and need ticking as reviewed.</span></div></div>`;
  }

  // EXIF DateTimeOriginal (or DateTime) of a JPEG as an ISO string; '' when there is none.
  async function exifTakenAt(file) {
    try {
      if (!/jpe?g/i.test(file.type)) return '';
      const dv = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (dv.getUint16(0) !== 0xFFD8) return '';
      for (let off = 2; off + 10 < dv.byteLength;) {
        const marker = dv.getUint16(off), len = dv.getUint16(off + 2);
        if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) { // APP1 "Exif"
          const t = off + 10, le = dv.getUint16(t) === 0x4949;
          const u16 = (o) => dv.getUint16(t + o, le), u32 = (o) => dv.getUint32(t + o, le);
          const find = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12; return -1; };
          const str = (e) => { let s = ''; const o = u32(e + 8); for (let i = 0; i < Math.min(u32(e + 4), 32) - 1; i++) s += String.fromCharCode(dv.getUint8(t + o + i)); return s; };
          const ifd0 = u32(4), exif = find(ifd0, 0x8769);
          let e = exif >= 0 ? find(u32(exif + 8), 0x9003) : -1;
          if (e < 0) e = find(ifd0, 0x0132);
          const m = e >= 0 && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(str(e));
          if (!m) return '';
          const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
          return isNaN(d) ? '' : d.toISOString();
        }
        if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
        off += 2 + len;
      }
    } catch (e) { /* unreadable EXIF: fall back to the file date */ }
    return '';
  }
  async function addPhotos(files) {
    const list = Array.from(files).filter((f) => /^image\//.test(f.type));
    if (!list.length) return;
    const j = job;
    if (j.issued) return toast(LOCKED, true);
    toast(`Adding ${list.length} photo(s)…`);
    const added = [], unreadable = [];
    for (const f of list) {
      try {
        const raw = await C.readFileAsDataURL(f);
        const r = await C.resizeDataURL(raw, 1800, 0.86);
        const takenAt = (await exifTakenAt(f)) || (f.lastModified ? new Date(f.lastModified).toISOString() : '');
        const thumb = await makeThumb(r.dataUrl);
        added.push({ id: C.uid(), dataUrl: r.dataUrl, thumb, w: r.width, h: r.height, title: '', caption: '', source: C.settings.company.name ? C.settings.company.name.replace(/ LTD$/i, '') : '', labels: [], fileName: f.name, takenAt });
      } catch (e) { unreadable.push(f.name); }
    }
    if (unreadable.length) toast(`${unreadable.length === 1 ? `${unreadable[0]} could not be read` : `${unreadable.length} photos could not be read (${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ', …' : ''})`}. Use JPG or PNG files (HEIC photos from an iPhone are not supported: export them as JPG first).`, true);
    if (!added.length) return;
    try {
      if (!(await applyToJob(j, (x) => { x.photos.push(...added); }))) toast(`${regOf(j)} has been deleted, so the photos were not added.`, true);
    } catch (err) { toast(errText(err), true); }
  }

  // Job data for the AI: no images or signatures, and only the photos that are in the report, in figure order,
  // so "Image N" in prompts and drafts matches the printed figure numbers.
  // Provenance goes with it: job.aiText (fields still holding applied AI text), titleByAi / captionByAi per photo and labels[].ai.
  function slimJob(src) {
    const nums = C.photoNumbers(src);
    const j = C.clone(Object.assign({}, src, { photos: [], issued: undefined, aiDraftPending: undefined }));
    if (j.assessor) delete j.assessor.signature;
    j.aiText = {};
    for (const [k, t] of Object.entries(isObj(src.aiText) ? src.aiText : {})) if (typeof t === 'string' && !k.startsWith('photos.')) j.aiText[k] = t;
    j.photos = src.photos.filter((p) => nums.has(p.id)).sort((a, b) => nums.get(a.id) - nums.get(b.id))
      .map((p) => ({ index: nums.get(p.id), title: p.title, caption: p.caption, titleByAi: photoTextByAi(src, p, 'title'), captionByAi: photoTextByAi(src, p, 'caption'), labels: (p.labels || []).filter(isObj).map((l) => ({ text: l.text, ai: !!l.ai })) }));
    return j;
  }

  // ai.js's limits per photo (decoded bytes, pixels per side) and the image types it accepts.
  const AI_MAX_IMAGE_BYTES = 7 * 1000 * 1000, AI_MAX_SIDE = 8000, AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  function dataUrlParts(u) {
    const m = /^data:([^;,]*)[^,]*;base64,/i.exec(String(u || ''));
    if (!m) return null;
    const base64 = String(u).slice(m[0].length);
    const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const type = m[1].trim().toLowerCase();
    return { type: type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type, base64, bytes: Math.floor(base64.length * 3 / 4) - pad };
  }
  // One photo for analysePhotos: the stored image as it is (ai.js accepts it up to its limits), re-encoded as a JPEG only when it
  // is over the per-photo limit or not a type the AI reads. With its id (results come back by id), size and text provenance.
  async function aiPhotoPayload(j, p, index) {
    const item = { index, id: p.id, title: p.title || '', caption: p.caption || '', titleByAi: photoTextByAi(j, p, 'title'), captionByAi: photoTextByAi(j, p, 'caption') };
    const d = dataUrlParts(p.dataUrl);
    let w = num(p.w), h = num(p.h);
    if (d && (!w || !h)) { try { const img = await C.loadImage(p.dataUrl); w = img.naturalWidth; h = img.naturalHeight; } catch (e) { w = 0; h = 0; /* ai.js reads the size from the image header */ } }
    if (d && AI_IMAGE_TYPES.includes(d.type) && d.bytes <= AI_MAX_IMAGE_BYTES && Math.max(w, h) <= AI_MAX_SIDE) {
      return Object.assign(item, { mediaType: d.type, base64: d.base64 }, w && h ? { width: w, height: h } : {});
    }
    try {
      for (const [edge, q] of [[2576, 0.85], [2048, 0.8], [1568, 0.8], [1024, 0.75]]) {
        const r = await C.resizeDataURL(p.dataUrl, edge, q);
        const rd = dataUrlParts(r.dataUrl);
        if (rd && rd.bytes <= AI_MAX_IMAGE_BYTES) return Object.assign(item, { mediaType: 'image/jpeg', base64: rd.base64, width: r.width, height: r.height });
      }
    } catch (e) { throw new Error(`${figLabel(index)} could not be read, so it cannot be sent to the AI. Add the photo again.`); }
    throw new Error(`${figLabel(index)} is too large to send to the AI, even at a reduced size. Add a smaller copy of it.`);
  }

  // AI suggestions from several photo batches. The lines of one batch are never merged with each other. A later batch's line is
  // merged into an earlier one only when the code, operation, side and wording all match, and every batch's hours stay visible
  // (hoursSeen); the higher figure is offered.
  const suggDesc = (s) => C.fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
  const suggKey = (l) => [String(l.code || '').trim().toUpperCase(), String(l.operation || '').trim(), String(l.side || '').trim(), suggDesc(l.description)].join('|');
  function mergeBatchLines(into, lines, batch) {
    const fresh = [];
    for (const raw of lines) {
      if (!isObj(raw)) continue;
      const l = Object.assign({}, raw, { batches: [batch], hoursSeen: [num(raw.labour_hours)] });
      const key = suggKey(l);
      const dup = into.find((x) => !x.batches.includes(batch) && suggKey(x) === key);
      if (!dup) { fresh.push(l); continue; }
      dup.batches.push(batch); dup.hoursSeen.push(num(l.labour_hours));
      if (num(l.labour_hours) > num(dup.labour_hours)) { dup.labour_hours = l.labour_hours; dup.hours_basis = l.hours_basis; }
      dup.needs_part = !!(dup.needs_part || l.needs_part);
      dup.confidence = Math.max(num(dup.confidence), num(l.confidence));
      if (l.reason && !String(dup.reason || '').includes(l.reason)) dup.reason = [dup.reason, l.reason].filter(Boolean).join(' ');
    }
    into.push(...fresh);
  }
  const boxOk = (b) => isObj(b) && ['x', 'y', 'w', 'h'].every((k) => typeof b[k] === 'number' && isFinite(b[k]));

  // Photos in the report that the stored findings do not cover (a run where later batches failed).
  function photosNotAnalysed(j, f) {
    const nums = C.photoNumbers(j);
    const done = new Set((isObj(f) && Array.isArray(f.photos) ? f.photos : []).filter(isObj).map((ph) => ph.id));
    return j.photos.filter((p) => nums.has(p.id) && !done.has(p.id));
  }
  function partialNotice(f) {
    if (!isObj(f.partial)) return '';
    const rest = photosNotAnalysed(job, f).length;
    return `<div class="card errBox partialRun" role="status" style="border-color:#f0c36d;background:#fffaf0;margin:8px 0"><b>Only ${num(f.partial.analysed)} of ${num(f.partial.total)} photos were analysed.</b> ${esc(f.partial.error || '')}
      ${rest && desktop ? `<div class="row" style="margin-top:6px"><button class="btn sm ai" data-act="aiAnalyseRest" ${busy('photos') ? 'disabled' : ''}>✦ Analyse the remaining ${rest} photo${rest === 1 ? '' : 's'}</button><span class="hint">The findings so far are kept; only the remaining photos are sent.</span></div>` : ''}</div>`;
  }
  // AI analysis of the photos in the report, in batches of 10. If a batch fails, the batches already done are applied and kept,
  // and the findings say which photos are missing; opts.remaining analyses only those, adding to the stored findings.
  async function aiAnalyse(opts) {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    const j = job;
    const key = 'photos:' + j.id;
    if (running.has(key)) return;
    // only photos in the report are sent, numbered as their printed figures; results come back by that number and are mapped to the photo id
    const nums = C.photoNumbers(j);
    const prev = opts && opts.remaining && isObj(j.aiFindings) ? j.aiFindings : null;
    const photos = (prev ? photosNotAnalysed(j, prev) : j.photos.filter((p) => nums.has(p.id))).sort((a, b) => nums.get(a.id) - nums.get(b.id));
    if (!photos.length) return toast(prev ? 'Every photo in the report has been analysed.' : 'Add photos (ticked "in report") first.', true);
    const slim = slimJob(j);
    const ai = C.settings.ai || {};
    running.add(key); renderJob();
    try {
      const batches = [];
      for (let k = 0; k < photos.length; k += 10) batches.push(photos.slice(k, k + 10));
      const merged = prev ? C.clone(prev) : { photos: [], summary: null, suggested_lines: [], review_flags: [], model: '', at: '' };
      merged.at = new Date().toISOString();
      ['photos', 'suggested_lines', 'review_flags'].forEach((k) => { if (!Array.isArray(merged[k])) merged[k] = []; });
      for (const l of merged.suggested_lines) if (isObj(l)) { if (!Array.isArray(l.batches)) l.batches = [0]; if (!Array.isArray(l.hoursSeen)) l.hoursSeen = [num(l.labour_hours)]; }
      const b0 = Math.max(0, ...merged.suggested_lines.filter(isObj).flatMap((l) => l.batches.map(num)));
      const fresh = []; // photo results of this run (earlier runs' labels are not applied again)
      let analysed = 0, failure = null;
      for (let b = 0; b < batches.length; b++) {
        try {
          if (batches.length > 1) toast(`AI analysing batch ${b + 1} of ${batches.length}…`);
          const payload = [];
          const idByIndex = new Map();
          for (const p of batches[b]) {
            idByIndex.set(nums.get(p.id), p.id);
            payload.push(await aiPhotoPayload(j, p, nums.get(p.id)));
          }
          const res = await desktop.ai.analysePhotos({ job: slim, photos: payload, model: ai.model, effort: ai.effort });
          if (!res || !res.ok) throw new Error((res && res.error) || 'The AI photo analysis failed.');
          const d = isObj(res.result) ? res.result : {};
          merged.model = d.model || merged.model;
          // results come back by photo id (ai.js echoes the id sent); the figure number is only a fallback
          const sent = new Set(batches[b].map((p) => p.id));
          for (const ph of d.photos || []) if (isObj(ph)) { const r = Object.assign(ph, { id: sent.has(ph.id) ? ph.id : idByIndex.get(num(ph.index)) }); fresh.push(r); merged.photos.push(r); }
          merged.summary = merged.summary ? mergeSummary(merged.summary, d.summary) : d.summary;
          mergeBatchLines(merged.suggested_lines, d.suggested_lines || [], b0 + b + 1);
          for (const fl of d.review_flags || []) { const s = String(fl == null ? '' : fl); if (s.trim() && !merged.review_flags.includes(s)) merged.review_flags.push(s); }
          analysed += batches[b].length;
        } catch (err) { failure = err; break; } // the batches already done are kept
      }
      if (!analysed) throw failure;
      const before = prev && isObj(prev.partial) ? num(prev.partial.analysed) : 0;
      if (failure) merged.partial = { analysed: before + analysed, total: before + photos.length, error: errText(failure), at: new Date().toISOString() };
      else delete merged.partial;
      let labelled = 0;
      const target = await applyToJob(j, (x) => {
        for (const ph of fresh) {
          const p = x.photos.find((q) => q.id === ph.id); // by id: moving or deleting photos meanwhile cannot misplace labels
          if (!p) continue;
          // only damages with a usable box are drawn; anything else is listed in the findings panel (unplaced_damages)
          const all = (ph.damages || []).filter(isObj);
          ph.damages = all.filter((d) => boxOk(d.box));
          const loose = all.filter((d) => !boxOk(d.box));
          if (loose.length) ph.unplaced_damages = (Array.isArray(ph.unplaced_damages) ? ph.unplaced_damages : []).concat(loose);
          p.labels = (p.labels || []).filter((l) => !l.ai).concat(ph.damages.map((d) => ({
            x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h, text: d.label, ai: true, colour: d.severity === 'severe' ? '#ff3b30' : d.severity === 'moderate' ? '#ff9500' : '#ffcc00',
            detail: `${C.sideWord(d.side)} ${d.component_name} · ${d.damage_type} · ${d.severity} · accident-related: ${d.accident_related} · ${d.recommended_operation}${d.notes ? ' — ' + d.notes : ''}`.trim(),
            code: d.component_code, side: d.side, accidentRelated: d.accident_related
          })));
          p.aiLabelled = true;
          p.labelsReviewed = false;
          // an empty title / caption takes the AI's text, recorded as AI text until the assessor edits it
          if (!p.title && ph.title) { p.title = ph.title; aiTextOf(x)[photoTextPath(p, 'title')] = ph.title; }
          if (!p.caption && ph.caption) { p.caption = ph.caption; aiTextOf(x)[photoTextPath(p, 'caption')] = ph.caption; }
          p.aiTitle = ph.title; p.aiCaption = ph.caption;
          labelled++;
        }
        x.aiFindings = merged;
        logAi(x, `Photo damage labelling & repair suggestions (${labelled} photos${failure ? `; ${photos.length - analysed} more could not be analysed` : ''})`, merged.model);
        if (ui.jobId === x.id) ui.suggestSel = {}; // fresh suggestions: all ticked again
      });
      if (!target) toast(`${regOf(j)} has been deleted, so the AI findings were not saved.`, true);
      else if (failure) toast(`Analysed ${analysed} of ${photos.length} photos; the rest failed: ${errText(failure)}`, true);
      else toast(`AI labelled ${labelled} photo(s) and suggested ${merged.suggested_lines.length} estimate line(s)${target !== job ? ` for ${regOf(target)} (saved with that assessment)` : ''}.`);
    } catch (e) {
      toast(errText(e, 'The AI photo analysis failed.'), true);
    } finally {
      running.delete(key);
      if (job && job.id === j.id) renderJob();
    }
  }
  function mergeSummary(a, b) {
    if (!b) return a;
    const out = Object.assign({}, a);
    ['damage_pattern', 'consistency_with_circumstances', 'structural_notes', 'secondary_areas'].forEach((k) => { if (b[k] && b[k] !== a[k]) out[k] = [a[k], b[k]].filter(Boolean).join(' '); });
    out.structural_concern = a.structural_concern || b.structural_concern;
    ['mechanical_checks', 'adas_and_calibration', 'zones'].forEach((k) => { out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])]; });
    return out;
  }
  function aiApplySummary() {
    const s = (job.aiFindings || {}).summary; if (!s) return;
    // an empty field takes the AI's text, recorded in job.aiText so later AI calls know it is an AI draft, not the assessor's
    const fill = (path, val) => { if (val && !getPath(job, path)) { setPath(job, path, val); aiTextOf(job)[path] = String(val); } };
    fill('circumstances.impactType', s.impact_type);
    fill('circumstances.primaryArea', s.primary_area);
    fill('circumstances.secondaryArea', s.secondary_areas);
    fill('circumstances.direction', s.direction_of_contact);
    fill('inspection.condition', s.damage_pattern);
    fill('assessment.structural', s.structural_notes);
    if ((s.mechanical_checks || []).length) fill('assessment.mechanical', 'The following require inspection and testing: ' + s.mechanical_checks.join('; ') + '.');
    const known = new Set(Diagram.ZONES.map((z) => z.label.toLowerCase()));
    (s.zones || []).forEach((z) => {
      const match = Diagram.ZONES.find((x) => x.label.toLowerCase() === z.toLowerCase()) || Diagram.ZONES.find((x) => z.toLowerCase().includes(x.label.toLowerCase()));
      const name = match ? match.label : (known.has(z.toLowerCase()) ? z : null);
      if (name && !job.zones.includes(name)) job.zones.push(name);
    });
    changed(); toast('Empty fields and damage zones filled from the AI findings.');
  }
  function aiAddLines() {
    const f = job.aiFindings; if (!f) return;
    let n = 0;
    const damages = (f.photos || []).filter(isObj).flatMap((ph) => (Array.isArray(ph.damages) ? ph.damages.filter(isObj) : []));
    let byVin = 0;
    (f.suggested_lines || []).forEach((l, i) => {
      if (!isObj(l) || l.added || ui.suggestSel[i] === false) return;
      const cands = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side) : [];
      const o = autoOem(cands);
      if (l.needs_part && cands.length && !o) byVin++;
      const cls = l.cost_class === 'paint' ? 'paint' : l.cost_class === 'other' ? 'other' : 'parts';
      const op = lineOp(l.operation);
      const hz = aiLineHours(job, l);
      const fields = {
        type: LINE_TYPES.includes(l.type) ? l.type : 'Body', description: l.description, code: C.CAT[l.code] ? l.code : '', side: l.side, hours: hz.hours,
        partNo: l.needs_part && o ? o.oem : '', amount: l.needs_part && o && o.price ? o.price : 0, costClass: cls, ai: true, reviewed: false, source: l.reason,
        op: op || 'ai'
      };
      if (op) fields.aiOperation = String(l.operation); // the operation as the AI gave it
      else {
        // older findings without an operation: the operation the AI recommended for this component, when one of its photo labels names it
        const dm = l.code && l.code !== 'OTHER' ? damages.find((d) => d.component_code === l.code && (d.side || '') === (l.side || '') && d.recommended_operation && d.recommended_operation !== 'none') : null;
        if (dm) fields.aiOperation = dm.recommended_operation;
      }
      if (l.guide_hours != null && l.guide_hours !== '') fields.guideHours = num(l.guide_hours);
      if (l.hours_basis === 'guide' || l.hours_basis === 'adjusted') fields.hoursBasis = l.hours_basis;
      if (hz.pfApplied) fields.pfApplied = hz.pfApplied;
      if (Array.isArray(l.hoursSeen) && new Set(l.hoursSeen.map(num)).size > 1) fields.aiHoursSeen = l.hoursSeen.map(num);
      job.lines.push(C.newLine(fields));
      l.added = true; n++;
    });
    changed(); toast(`${n} line(s) added to the estimate.${byVin ? ` ${byVin} part line(s) have several researched numbers: choose the variant by VIN (⋯ on the line).` : ''}`); renderJob();
  }

  // ---------- DAMAGE & ASSESSMENT ----------
  function tabAssessment() {
    return `<div class="card"><h2 style="margin-top:0">Damage zones</h2>
      <div class="diagram"><div id="diagramHost">${Diagram.svg(job.zones)}</div>
        <div class="grow"><p class="hint">Click areas of the vehicle to record damage zones. They appear in the report and filter the parts picker on the Estimate tab.</p>
        <div class="zlist">${job.zones.length ? job.zones.map((z) => `<span class="badge err">${esc(z)} <button class="link" data-act="zoneDel" data-z="${esc(z)}">✕</button></span>`).join('') : '<span class="hint">No zones selected.</span>'}</div></div></div></div>
      <div class="card"><h2 style="margin-top:0">Structural, mechanical &amp; roadworthiness assessment</h2><div class="form">
      ${F('assessment.structural', 'Structural and body / panel assessment', { type: 'textarea', rows: 8, full: true })}
      ${F('assessment.mechanical', 'Mechanical assessment', { type: 'textarea', rows: 5 })}${F('assessment.wheels', 'Wheels & tyres', { type: 'textarea', rows: 5 })}
      ${F('assessment.geometry', 'Wheel alignment / geometry', { type: 'textarea', rows: 5 })}${F('assessment.diagnostics', 'Diagnostics & warning lamps', { type: 'textarea', rows: 5 })}
      ${F('assessment.roadworthiness', 'Roadworthiness', { type: 'textarea', rows: 3, full: true })}</div>
      <p class="hint">Tip: use <b>Opinion → ✦ AI draft all narrative</b> to draft these sections from your photos, estimate and figures.</p></div>`;
  }

  // ---------- ESTIMATE ----------
  function tabEstimate() {
    const t = C.totals(job);
    const ov = C.findOemVehicle(job.vehicle.oemKey);
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Add from parts catalogue</h2>
        <span class="hint">${ov ? `OEM numbers: <b>${esc(ov.make + ' ' + ov.model + ' ' + ov.generation)}</b>` : `No catalogue vehicle linked. <a href="#/job/${esc(job.id)}/vehicle">Link one on the Vehicle tab</a> to fill OEM part numbers.`}</span></div>
      ${job.zones.length || ui.zoneGroups ? `<div class="row" style="margin:10px 0 2px"><span class="hint">Damage zones:</span>${job.zones.map((z) => `<button class="btn sm${ui.zoneGroups && ui.zoneLabel === z ? ' on' : ''}" data-act="zonePick" data-z="${esc(z)}">${esc(z)}</button>`).join('')}${job.zones.length ? `<button class="btn sm${ui.zoneGroups ? '' : ' on'}" data-act="zonePick" data-z="">All</button>` : ''}
        ${ui.zoneGroups ? `<span class="zchip" title="Only parts for this damage zone are listed">Zone: <b>${esc(ui.zoneLabel)}</b><button class="link" data-act="zonePick" data-z="" title="Clear the zone filter">✕</button></span>` : ''}</div>` : ''}
      <div class="picker" style="margin-top:10px">
        <label class="fld"><span>Search part</span><input id="pickQ" value="${esc(ui.pickQ)}" placeholder="e.g. mirror, sill, bumper, door"></label>
        <label class="fld"><span>Group</span><select id="pickGroup"><option value="">All groups</option>${window.CATALOGUE_GROUPS.map((g) => `<option${g === ui.pickGroup ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <label class="fld"><span>Side</span><select id="pickSide"><option value="">—</option><option value="L"${ui.pickSide === 'L' ? ' selected' : ''}>LH</option><option value="R"${ui.pickSide === 'R' ? ' selected' : ''}>RH</option></select></label>
        <label class="fld"><span>Operation</span><select id="pickOp">${[['replace', 'Renew (remove & replace) + refinish new part'], ['repair1', 'Repair – light'], ['repair', 'Repair – medium'], ['repair3', 'Repair – heavy'], ['pdr', 'Paintless dent repair'], ['smart', 'Smart repair / polish'], ['refinish', 'Refinish (new part)'], ['refinishRep1', 'Refinish repaired part – damage <50%'], ['refinishRep2', 'Refinish repaired part – damage >50%'], ['blend', 'Blend (colour match)'], ['rr', 'Remove & refit (R&I)'], ['check', 'Inspect / test'], ['refurb', 'Refurbish'], ['operation', 'Operation / service (as listed)']].map(([k, v]) => `<option value="${k}"${k === ui.pickOp ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <button class="btn primary" data-act="pickAdd">Add line</button>
      </div>
      <label class="hint" style="display:inline-flex;gap:6px;margin-top:6px"><input type="checkbox" id="addRefinish" style="width:auto" ${ui.addRefinish ? 'checked' : ''}> When renewing or repairing a painted panel, also add its refinish line</label>
      <div class="hint">Guide times are scaled ×${C.sizeFactor(job)} for the ${esc((C.SIZE_CLASSES[job.vehicle.sizeClass || 'medium'] || ['medium'])[0])} size class, and refinish times ×${C.paintFactor(job)} for ${esc(job.vehicle.paintType || 'metallic')} paint. These are this software's guide times, not manufacturer times. Edit any line to match your own data. <button class="link" data-act="paintMaterials">Calculate paint materials</button></div>
      <div class="results" id="pickResults">${pickResults()}</div>
      <h3>Labour-only operations</h3>
      <div class="row" style="gap:6px">${Object.values(C.OPS).map((o) => `<button class="btn sm" data-act="addOp" data-code="${o.code}" title="${o.type} · ${o.hours}h">${esc(o.name)}</button>`).join('')}</div>
    </div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl" id="linesTbl"><thead><tr><th>#</th><th>Type</th><th style="min-width:260px">Description</th><th>Part no. / ref</th><th class="num">Hours</th><th class="num">Rate £/h</th><th class="num">Labour £</th><th class="num">Parts / mat. £ (ex VAT)</th><th>Cost class</th><th>Review</th><th></th></tr></thead>
      <tbody>${job.lines.map(lineRow).join('') || '<tr><td colspan="11" class="empty">No lines yet. Add parts above, or use the AI suggestions from Photos &amp; AI.</td></tr>'}</tbody></table>
      <div class="row" style="padding:10px"><button class="btn sm" data-act="addBlank">+ Blank line</button><span class="grow"></span><label class="fld" style="width:160px"><span>Discount £ (ex VAT)</span><input data-bind="discount" type="number" step="0.01" min="0" value="${esc(job.discount)}"></label></div></div>
    <div class="card"><div class="totals" id="totalsBox">${totalsBox(t)}</div></div>
    ${ratesCard()}
    <div class="card">${F('estimateNotes', 'Estimate notes', { type: 'textarea', rows: 6, full: true })}</div>`;
  }
  // The job keeps its own labour rates and VAT (copied from Settings when it was created).
  function ratesCard() {
    const S = C.settings, r = job.rates || {};
    const keys = [...new Set(Object.keys(S.rates).concat(Object.keys(r)))];
    const differ = keys.some((k) => num(r[k]) !== num(S.rates[k])) || num(C.vatPctFor(job)) !== num(S.vatPct);
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Labour rates &amp; VAT for this assessment</h2>
        ${differ ? '<span class="badge warn">differ from Settings</span>' : '<span class="badge ok">same as Settings</span>'}<button class="btn sm" data-act="useSettingsRates" ${differ ? '' : 'disabled'}>Use current Settings rates</button></div>
      <div class="form3" style="margin-top:10px">${keys.map((k) => F('rates.' + k, `${k} labour rate £/h`, { type: 'number', step: '0.01' })).join('')}${F('vatPct', 'VAT %', { type: 'number', step: '0.1' })}</div>
      <p class="hint">Copied from Settings when this assessment was created and kept with it, so a later change in Settings does not alter this report. A rate typed on an estimate line overrides these.</p></div>`;
  }
  function totalsBox(t) {
    return `<div><span>Labour hours</span><b>${hrs(t.labourHours)}</b></div><div><span>Labour (ex VAT)</span><b>${gbp(t.labour)}</b></div><div><span>Parts (ex VAT)</span><b>${gbp(t.parts)}</b></div>
      <div><span>Paint materials (ex VAT)</span><b>${gbp(t.paint)}</b></div><div><span>Other / services (ex VAT)</span><b>${gbp(t.other)}</b></div>${num(t.discount) ? `<div><span>Less discount</span><b>${gbp(-num(t.discount))}</b></div>` : ''}<div><span>Net (excl. VAT)</span><b>${gbp(t.net)}</b></div>
      <div><span>VAT @ ${num(t.vatPct)}%</span><b>${gbp(t.vat)}</b></div><div class="g"><span>Total repair cost</span><b>${gbp(t.gross)}</b></div>`;
  }
  function pickResults() {
    const q = ui.pickQ.toLowerCase().trim();
    let groups = null;
    if (ui.pickGroup) groups = [ui.pickGroup];
    if (ui.zoneGroups) groups = ui.zoneGroups;
    const rank = (p) => {
      const n = p.name.toLowerCase();
      const r = !q ? 3 : n === q ? 0 : n.startsWith(q) ? 1 : (' ' + n).includes(' ' + q) ? 2 : 3;
      return [r, p.kind === 'P' ? 0 : p.kind === 'S' ? 1 : 2, n.length];
    };
    const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    let rows = Object.values(C.CAT).filter((p) => (!groups || groups.includes(p.group)) && (!q || (p.name + ' ' + p.code + ' ' + p.group).toLowerCase().includes(q)));
    if (q) rows = rows.sort(cmp);
    rows = rows.slice(0, 80);
    if (!rows.length) return '<div class="r hint">No matching parts.</div>';
    return rows.map((p) => {
      const sides = p.sided ? (ui.pickSide ? [ui.pickSide] : ['L', 'R']) : [''];
      const oems = sides.map((s) => {
        const cands = C.oemLookup(job.vehicle.oemKey, p.code, s), c = autoOem(cands), sw = s ? C.sideWord(s) + ' ' : '';
        if (!c) return cands.length ? `<span class="oem single-source">${sw}${esc(noAutoNote(cands))}</span>` : '';
        return `<span class="oem ${c.user ? 'user' : esc(c.confidence)}" title="${esc(c.description + ' — ' + (c.user ? 'your number' : c.confidence) + (c.priceIncVat ? ' — ' + oemPrice(c) : ''))}">${sw}${esc(c.oem)}${c.price ? ' · ' + oemPrice(c, true) : ''}</span>`;
      }).filter(Boolean).join(' &nbsp; ');
      return `<div class="r${ui.pickSel === p.code ? ' sel' : ''}" data-act="pickSel" data-code="${p.code}"><code>${p.code}</code><div class="grow"><b>${esc(p.name)}</b> <span class="hint">· ${esc(p.group)}${p.sided ? ' · LH/RH' : ''}</span><div>${oems}</div></div>
        <span class="hint">${pickHint(p)}</span></div>`;
    }).join('');
  }
  function lineRow(l, i) {
    const rate = C.lineRate(job, l);
    const hasOem = l.code && C.oemLookup(job.vehicle.oemKey, l.code, l.side).length;
    return `<tr data-row="${l.id}"><td class="hint">${i + 1}</td>
      <td style="min-width:122px"><select data-lf="type" data-id="${l.id}">${LINE_TYPES.map((t) => `<option${t === l.type ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-lf="description" data-id="${l.id}" value="${esc(l.description)}">${aiLineNotes(l)}${l.source ? `<div class="hint" title="${esc(l.source)}">AI evidence: ${esc(String(l.source).slice(0, 110))}${String(l.source).length > 110 ? '…' : ''}</div>` : ''}</td>
      <td style="min-width:150px"><div class="row" style="flex-wrap:nowrap;gap:4px"><input data-lf="partNo" data-id="${l.id}" value="${esc(l.partNo)}">${hasOem ? `<button class="btn sm" data-act="oemPick" data-id="${l.id}" title="OEM options">⋯</button>` : ''}</div></td>
      <td class="num" style="width:80px"><input data-lf="hours" data-id="${l.id}" type="number" step="0.1" min="0" value="${esc(l.hours)}"></td>
      <td class="num" style="width:90px"><input data-lf="rate" data-id="${l.id}" type="number" step="0.01" min="0" value="${esc(l.rate)}" placeholder="${rate.toFixed(2)}"></td>
      <td class="num" data-lv="${l.id}">${num(l.hours) ? gbp(C.lineLabour(l.hours, rate)) : '—'}</td>
      <td class="num" style="width:100px"><input data-lf="amount" data-id="${l.id}" type="number" step="0.01" min="0" value="${esc(l.amount)}" placeholder="ex VAT" title="Ex VAT: VAT is added to the total"></td>
      <td style="min-width:128px"><select data-lf="costClass" data-id="${l.id}">${COST_CLASSES.map(([k, v]) => `<option value="${k}"${k === l.costClass ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
      <td>${l.ai ? `<label class="badge ${l.reviewed ? 'ok' : 'ai'}" style="cursor:pointer"><input type="checkbox" data-lf="reviewed" data-id="${l.id}" ${l.reviewed ? 'checked' : ''} style="width:auto;vertical-align:-2px"> AI ${l.reviewed ? 'reviewed' : 'suggested'}</label>` : ''}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-act="lmove" data-id="${l.id}" data-d="-1">↑</button><button class="btn sm" data-act="lmove" data-id="${l.id}" data-d="1">↓</button><button class="btn sm danger" data-act="ldel" data-id="${l.id}">✕</button></td></tr>`;
  }
  // ---- catalogue rules. Rows: [code, name, group, sided, replaceHrs, refinishHrs, kind, mat, repairHrs] ----
  const RAW_CAT = new Map((window.CATALOGUE || []).map((r) => [r[0], r]));
  const matOf = (p) => { const r = RAW_CAT.get(p.code); return String((r ? r[7] : p.mat) || ''); };
  // guide hours for a MEDIUM repair: 0 = renew only; null = no repair time in the row (older data), so OP001 is used
  const repairGuide = (p) => { const r = RAW_CAT.get(p.code); const v = r ? r[8] : p.repairHrs; return v == null || v === '' ? null : num(v); };
  // calibrations, scans, alignment, measuring, fluid services, consumables and sundries: added as operations, not renewed parts
  const isOperationRow = (p) => ['operation', 'consumable'].includes(matOf(p)) || ['A', 'C'].includes(p.kind) || ['ST006', 'ST007'].includes(p.code);
  const PDR_PANELS = ['RF001', 'RQ001', 'RQ002', 'SS002', 'SS003', 'SS008', 'FE012']; // structural outer skins that are dent-repairable
  const pdrAllowed = (p) => { const g = repairGuide(p); return g !== 0 && ['steel', 'aluminium'].includes(matOf(p)) && (p.kind === 'P' || PDR_PANELS.includes(p.code)); };
  function pickHint(p) {
    if (isOperationRow(p)) return `${matOf(p) === 'consumable' ? 'consumable' : 'operation'}${p.replaceHrs ? ' · ' + p.replaceHrs + 'h' : ''}`;
    const g = repairGuide(p);
    return `R&amp;R ${p.replaceHrs}h${p.refinishHrs ? ' · paint ' + p.refinishHrs + 'h' : ''}${g ? ' · repair ' + g + 'h' : g === 0 ? ' · renew only' : ''}`;
  }
  const OP_NAMES = { repair1: 'light repair', repair: 'medium repair', repair3: 'heavy repair', pdr: 'paintless dent repair', smart: 'smart repair', refinish: 'refinish', refinishRep1: 'refinish', refinishRep2: 'refinish', blend: 'blend' };
  // ---- guide times: one set of rules for the picker and for AI suggestions ----
  // The job's factors as the picker applies them: H = size factor (renew, repair, R&I, operations); P = size × paint-finish factor (refinish work).
  const scaleH = (j, h) => Math.max(0.1, Math.round(h * C.sizeFactor(j) * 10) / 10);
  const scaleP = (j, h) => Math.max(0.1, Math.round(h * C.sizeFactor(j) * C.paintFactor(j) * 10) / 10);
  const LINE_OPS = ['renew', 'repair1', 'repair', 'repair3', 'pdr', 'smart', 'refinish', 'refinishRep1', 'refinishRep2', 'blend', 'rr', 'check', 'refurb', 'operation', 'labour'];
  const PAINT_OPS = ['smart', 'refinish', 'refinishRep1', 'refinishRep2', 'blend'];
  const lineOp = (op) => { const o = String(op == null ? '' : op).trim(); return o === 'replace' ? 'renew' : LINE_OPS.includes(o) ? o : ''; };
  // The picker's guide time for operation `op` on catalogue part p, before the job's factors, and the factor it takes
  // ('H', 'P' or '' for none); null where the picker refuses the operation. Mirrors addFromCatalogue below.
  function pickerGuide(p, op) {
    const rr = num(p.replaceHrs), rf = num(p.refinishHrs), g = repairGuide(p);
    if (isOperationRow(p)) return op === 'operation' ? { base: rr, kind: rr ? 'H' : '' } : null;
    const mult = { repair1: 0.5, repair: 1, repair3: 2 }[op];
    if (mult) {
      if (g === 0 || (g == null && !['P', 'S', 'T'].includes(p.kind))) return null;
      const base = (g == null ? (C.OPS.OP001 || { hours: 1.5 }).hours : g) * mult, cap = rr + rf;
      return { base: cap > 0 ? Math.min(base, cap) : base, kind: 'H' };
    }
    if (PAINT_OPS.includes(op) && !(rf > 0)) return null;
    switch (op) {
      case 'renew': return { base: rr, kind: 'H' };
      case 'pdr': return pdrAllowed(p) ? { base: 1.0, kind: 'H' } : null;
      case 'smart': return { base: 0.8, kind: 'P' };
      case 'refinish': return { base: rf, kind: 'P' };
      case 'refinishRep1': return { base: rf * 0.7, kind: 'P' };
      case 'refinishRep2': return { base: rf * 0.9, kind: 'P' };
      case 'blend': return { base: rf * num(C.settings.blendFactor || 0.5), kind: 'P' };
      case 'rr': return { base: rr * 0.6, kind: 'H' };
      case 'check': return { base: 0.3, kind: '' };
      case 'refurb': return p.group === 'SRS / airbags' ? null : { base: 0, kind: '' };
      default: return null;
    }
  }
  // The hours the picker would give this code and operation on job j: { base, kind, hours }, or null when it has no guide.
  // Labour-only operations (OP codes) are added at their listed hours, as the labour-op buttons add them.
  function guideFor(j, code, op) {
    const c = String(code || '').trim().toUpperCase();
    if (C.OPS[c]) return op === 'labour' ? { base: num(C.OPS[c].hours), kind: '', hours: num(C.OPS[c].hours) } : null;
    const g = C.CAT[c] ? pickerGuide(C.CAT[c], op) : null;
    if (!g) return null;
    return Object.assign(g, { hours: g.kind === 'H' ? scaleH(j, g.base) : g.kind === 'P' ? scaleP(j, g.base) : g.base });
  }
  // The hours an AI suggestion is added with. A guide-based line (hours_basis 'guide') gets exactly the picker's time for this vehicle:
  // the catalogue guide with the job's size / paint factors (paint lines record pfApplied, so paint materials do not apply the factor
  // again). An adjusted line keeps the AI's own figure; for refinish, blend and smart repair that figure is base time before the
  // paint-finish factor (ai.js asks for it so), so the factor is applied here once and recorded as pfApplied.
  function aiLineHours(j, l) {
    const op = lineOp(l.operation);
    const g = op ? guideFor(j, l.code, op) : null;
    const out = { hours: Math.max(0, num(l.labour_hours)), guide: g };
    if (l.hours_basis === 'guide' && g) { out.hours = g.hours; if (g.kind === 'P') out.pfApplied = C.paintFactor(j); }
    else if (l.hours_basis === 'adjusted' && PAINT_OPS.includes(op)) {
      const pf = C.paintFactor(j);
      out.base = out.hours;
      out.hours = out.hours > 0 ? Math.max(0.1, Math.round(out.hours * pf * 10) / 10) : 0;
      out.pfApplied = pf;
    }
    return out;
  }
  const finishName = (j) => ({ solid: 'solid', metallic: 'metallic', pearl: 'pearlescent', 'three-stage': '3-stage', matt: 'matt' }[(j.vehicle && j.vehicle.paintType) || 'metallic'] || 'this');
  // "adjusted from guide 2.0h" (plus the picker's time for this vehicle when the job's factors change it); OTHER lines have no guide
  function adjustedNote(base, g) {
    if (!(base > 0) && !(g && g.hours > 0)) return 'no guide time for this line';
    return `adjusted from guide ${h1(base)}${g && Math.abs(g.hours - base) >= 0.05 ? ` (${h1(g.hours)} for this vehicle)` : ''}`;
  }
  const listH = (hs) => hs.map(h1).join(' / ');
  function suggHoursNote(l, hz) {
    const bits = [];
    if (l.hours_basis === 'guide') bits.push(Math.abs(hz.hours - num(l.labour_hours)) >= 0.05 ? `guide ${h1(l.labour_hours)}, scaled for this vehicle` : 'guide time');
    else if (l.hours_basis === 'adjusted') bits.push(adjustedNote(num(l.guide_hours), hz.guide));
    if (hz.base != null && Math.abs(hz.hours - hz.base) >= 0.05) bits.push(`AI ${h1(hz.base)} × ${num(hz.pfApplied)} for the ${finishName(job)} finish`);
    if (Array.isArray(l.hoursSeen) && new Set(l.hoursSeen.map(num)).size > 1) bits.push(`photo batches differed: ${listH(l.hoursSeen)}`);
    return bits.length ? `<div class="hint basis">${bits.map(esc).join('<br>')}</div>` : '';
  }
  // Notes under an AI line's description on the Estimate tab.
  function aiLineNotes(l) {
    if (!l.ai) return '';
    let out = '';
    if (l.hoursBasis === 'adjusted') out += `<div class="hint aiBasis">AI: ${esc(adjustedNote(num(l.guideHours), guideFor(job, l.code, l.op)))}${PAINT_OPS.includes(l.op) && num(l.pfApplied) > 0 && num(l.pfApplied) !== 1 ? esc(`; ×${num(l.pfApplied)} paint finish included`) : ''}</div>`;
    if (Array.isArray(l.aiHoursSeen) && l.aiHoursSeen.length > 1) out += `<div class="hint aiBatches">AI photo batches differed: ${esc(listH(l.aiHoursSeen))}. Check the hours.</div>`;
    return out;
  }
  function addFromCatalogue() {
    const p = C.CAT[ui.pickSel];
    if (!p) return toast('Select a part in the list first.', true);
    let sides = [''];
    if (p.sided) {
      if (!ui.pickSide) return toast('Choose LH or RH for this part.', true);
      sides = [ui.pickSide];
    }
    const op = ui.pickOp;
    const mat = matOf(p), guide = repairGuide(p), opRow = isOperationRow(p);
    const isRepair = ['repair1', 'repair', 'repair3'].includes(op);
    const isPaint = ['smart', 'refinish', 'refinishRep1', 'refinishRep2', 'blend'].includes(op);
    if (opRow && (isRepair || isPaint || op === 'pdr')) return toast(`"${p.name}" is an operation or service, so ${OP_NAMES[op]} does not apply. Choose "Operation / service" to add it.`, true);
    if (!opRow && op === 'operation') return toast(`"${p.name}" is a part: choose what is done to it (Renew, Repair, Refinish…).`, true);
    if (isRepair && guide === 0) return toast(`"${p.name}" is not repairable in the guide data: renew it instead.`, true);
    if (isRepair && guide == null && !['P', 'S', 'T'].includes(p.kind)) return toast(`"${p.name}" is not a panel or trim. Choose Renew, Remove & refit, Inspect or Refurbish.`, true);
    if (op === 'pdr' && !pdrAllowed(p)) return toast(`Paintless dent repair applies only to repairable painted steel or aluminium panels, not to "${p.name}".`, true);
    if (isPaint && !(p.refinishHrs > 0)) return toast(`"${p.name}" is not a painted part, so refinish and blend do not apply.`, true);
    if (op === 'refurb' && !opRow && p.group === 'SRS / airbags') return toast('SRS components (airbags, pretensioners, sensors) are renewed, never refurbished.', true);
    const notes = new Set();
    const pf = C.paintFactor(job);
    const H = (h) => scaleH(job, h);
    const P = (h) => scaleP(job, h); // refinish time: the paint factor is applied here, and recorded as pfApplied
    for (const side of sides) {
      const sw = side ? C.sideWord(side) + ' ' : '';
      const nm = sw + p.name.charAt(0).toLowerCase() + p.name.slice(1);
      const Nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      const typeFor = ['M', 'W'].includes(p.kind) ? 'Mechanical' : ['E', 'A'].includes(p.kind) ? 'Electrical' : 'Body';
      const cands = C.oemLookup(job.vehicle.oemKey, p.code, side), o = autoOem(cands);
      if (cands.length && !o && (opRow || op === 'replace')) notes.add(noAutoNote(cands) + ' (⋯ on the line).');
      const painted = p.refinishHrs > 0;
      const add = (fields) => job.lines.push(C.newLine(Object.assign({ code: p.code, side }, fields)));
      const paintLine = (description, h, lineOp) => add({ type: 'Painting', description, hours: P(h), costClass: 'paint', op: lineOp, pfApplied: pf });
      if (opRow) { // the operation itself: no "– renew", labour as listed (0 h allowed)
        add({ type: 'Auxiliary', description: Nm, hours: p.replaceHrs ? H(p.replaceHrs) : 0, partNo: o ? o.oem : '', amount: o && o.price ? o.price : 0, costClass: p.kind === 'C' || mat === 'consumable' ? 'other' : 'parts', op: 'operation' });
        continue;
      }
      const repairLine = (lvl, mult, lineOp) => {
        const base = (guide == null ? C.OPS.OP001.hours : guide) * mult; // the part's own repair time × 0.5 / 1 / 2
        const cap = num(p.replaceHrs) + num(p.refinishHrs);
        if (cap > 0 && base > cap) notes.add(`Repair time capped at the renew + refinish guide (${cap}h): renewing may be more economical.`);
        const how = mat === 'plastic' ? `plastic repair (${lvl})` : mat === 'composite' ? `composite repair (${lvl})` : ['steel', 'aluminium', ''].includes(mat) ? `repair (${lvl}) / metal finish` : `repair (${lvl})`;
        add({ type: 'Body', description: `${Nm} – ${how}`, hours: H(cap > 0 ? Math.min(base, cap) : base), partNo: 'Existing panel', costClass: 'parts', op: lineOp });
        if (painted && ui.addRefinish) paintLine(`${Nm} – refinish repaired part (${mult > 1.2 ? 'damage >50%' : 'damage <50%'})`, p.refinishHrs * (mult > 1.2 ? 0.9 : 0.7), mult > 1.2 ? 'refinishRep2' : 'refinishRep1');
      };
      switch (op) {
        case 'replace':
          add({ type: typeFor, description: `${Nm} – renew`, hours: H(p.replaceHrs), partNo: o ? o.oem : '', amount: o && o.price ? o.price : 0, costClass: 'parts', op: 'renew' });
          if (painted && ui.addRefinish) paintLine(`${Nm} – refinish new part`, p.refinishHrs, 'refinish');
          break;
        case 'repair1': repairLine('light', 0.5, 'repair1'); break;
        case 'repair': repairLine('medium', 1.0, 'repair'); break;
        case 'repair3': repairLine('heavy', 2.0, 'repair3'); break;
        case 'pdr': add({ type: 'Body', description: `${Nm} – paintless dent repair`, hours: H(1.0), partNo: 'Existing panel', costClass: 'parts', op: 'pdr' }); break;
        case 'smart': paintLine(`${Nm} – smart repair / polish`, 0.8, 'smart'); break;
        case 'refinish': paintLine(`${Nm} – refinish new part`, p.refinishHrs || 1.0, 'refinish'); break;
        case 'refinishRep1': paintLine(`${Nm} – refinish repaired part (damage <50%)`, (p.refinishHrs || 1.0) * 0.7, 'refinishRep1'); break;
        case 'refinishRep2': paintLine(`${Nm} – refinish repaired part (damage >50%)`, (p.refinishHrs || 1.0) * 0.9, 'refinishRep2'); break;
        case 'blend': paintLine(`${Nm} – blend (colour match)`, (p.refinishHrs || 1.0) * num(C.settings.blendFactor || 0.5), 'blend'); break;
        case 'rr':
          add({ type: 'Auxiliary', description: `${Nm} – remove & refit`, hours: H(p.replaceHrs * 0.6), costClass: 'parts', op: 'rr' });
          break;
        case 'check':
          add({ type: typeFor === 'Body' ? 'Auxiliary' : typeFor, description: `${Nm} – inspect / test`, hours: 0.3, costClass: 'parts', op: 'check' });
          break;
        case 'refurb':
          add({ type: 'Other', description: `${Nm} – refurbishment`, hours: 0, amount: 0, costClass: 'other', op: 'refurb' });
          break;
      }
    }
    changed(); renderJob();
    toast([opRow ? 'Added as an operation.' : 'Line added.', ...notes].join(' '));
  }
  function paintMaterials() {
    const rate = num(C.settings.paintMaterialsPerHour);
    const pf = C.paintFactor(job);
    const painting = job.lines.filter((l) => l.type === 'Painting');
    if (!painting.reduce((a, l) => a + num(l.hours), 0)) return toast('No painting hours on this estimate.', true);
    if (!rate) return toast('Set a paint materials rate (£ per paint hour) in Settings → Rates & thresholds first.', true);
    // the paint-finish factor is applied once: picker lines already carry it in their hours (pfApplied)
    const eff = painting.reduce((a, l) => a + num(l.hours) * (num(l.pfApplied) > 0 ? pf / num(l.pfApplied) : pf), 0);
    const amount = C.round2(eff * rate);
    // materials already priced on another paint line (e.g. "Masking, colour matching … £350"): do not charge them twice
    const priced = job.lines.filter((x) => x.auto !== 'paintMaterials' && x.costClass === 'paint' && num(x.amount) > 0);
    if (priced.length) {
      const sum = priced.reduce((a, x) => a + num(x.amount), 0);
      return toast(`Paint materials are already priced on line${priced.length > 1 ? 's' : ''} ${priced.map((x) => job.lines.indexOf(x) + 1).join(', ')} (${gbp(sum)}), so no second materials charge was added. The calculation gives ${gbp(amount)}; clear the existing amount first to use it.`, true);
    }
    let l = job.lines.find((x) => x.auto === 'paintMaterials');
    if (!l) { l = C.newLine({ type: 'Materials', description: '', hours: 0, costClass: 'paint', auto: 'paintMaterials', op: 'operation' }); job.lines.push(l); }
    l.description = `Paint materials – ${hrs(eff)} paint hrs × £${rate.toFixed(2)}${pf !== 1 ? ` (${job.vehicle.paintType || 'metallic'} finish ×${pf} included)` : ''}`;
    l.amount = amount;
    changed(); renderJob(); toast('Paint materials: ' + gbp(amount));
  }
  function oemPicker(lineId) {
    const j = job;
    const l = j.lines.find((x) => x.id === lineId); if (!l) return;
    const cands = C.oemLookup(j.vehicle.oemKey, l.code, l.side);
    const b = openModal('OEM part numbers — ' + l.description, `<p class="hint">Researched numbers for this vehicle. Confirm against the VIN with a dealer parts counter before ordering. Versions often differ by facelift, trim and options. "Use" fills the price excluding VAT.</p>
      <table class="tbl"><thead><tr><th>Part number</th><th>Description</th><th>Confidence</th><th class="num">Price</th><th>Notes</th><th></th></tr></thead><tbody>
      ${cands.map((c, i) => `<tr><td><b>${esc(c.oem)}</b></td><td>${esc(c.description)}</td><td>${confBadge(c)} ${oemBadges(c)}</td><td class="num">${oemPrice(c) || '—'}</td>
        <td class="hint" style="max-width:380px">${esc(c.notes)}${httpUrl(c.source) ? `<br><a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : c.source ? `<br>${esc(c.source)}` : ''}</td><td><button class="btn sm primary" data-use="${i}">Use</button></td></tr>`).join('')}</tbody></table>`);
    if (!b) return;
    b.addEventListener('click', async (e) => {
      const u = e.target.closest('[data-use]'); if (!u) return;
      const c = cands[+u.dataset.use];
      closeModal();
      try { await applyToJob(j, (x) => { const t = x.lines.find((y) => y.id === lineId); if (t) { t.partNo = c.oem; if (c.price) t.amount = c.price; } }); } catch (err) { toast(errText(err), true); }
    });
  }

  // ---------- VALUATION ----------
  function tabValuation() {
    const t = C.totals(job);
    const v = job.valuation;
    return `<div class="card"><h2 style="margin-top:0">Valuation</h2><div class="form">
      ${F('valuation.claimType', 'Claim type (sets the valuation standard)', { type: 'select', options: CLAIM_TYPES, hint: "Own-insurer total loss: the Financial Ombudsman's approach (start from the highest trade guide). Third-party or court: the cost of a like-for-like replacement, with your reasoned opinion. The AI valuation applies the standard for the type chosen." })}<div></div>
      ${F('valuation.date', 'Valuation date / date assessed', { ph: 'e.g. September 2026' })}${F('valuation.mileage', 'Mileage used for valuation', { type: 'number', hint: job.vehicle.mileage && !v.mileage ? `<button class="link" data-act="valMileage">Use inspection mileage (${esc(job.vehicle.mileage)})</button>` : '' })}
      ${F('valuation.costNew', 'Cost at new')}${F('valuation.condition', 'Pre-accident condition', { type: 'select', options: ['EXCELLENT', 'GOOD', 'SATISFACTORY', 'FAIR', 'POOR'] })}</div>
      <h3>Valuation evidence</h3>
      <table class="tbl"><thead><tr><th>Source</th><th class="num">Amount £</th><th></th></tr></thead><tbody>
        ${v.sources.map((s, i) => `<tr><td><input data-vs="name" data-i="${i}" value="${esc(s.name)}" list="valsrc"></td><td class="num" style="width:160px"><input type="number" step="1" min="0" data-vs="amount" data-i="${i}" value="${esc(s.amount)}"></td><td><button class="btn sm danger" data-act="vsDel" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table><datalist id="valsrc"><option value="Glass's Guide"><option value="CAP HPI"><option value="AutoTrader"><option value="Percayso Vehicle Intelligence"><option value="Like-for-like advert"><option value="Dealer retail advert"></datalist>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="vsAdd">+ Source</button><span class="grow"></span>
        <span class="row" id="valRange">${valRange(t)}</span></div>
      <div class="form3" style="margin-top:14px">${F('valuation.adopted', 'Assessed pre-accident value £', { type: 'number' })}${F('valuation.salvagePct', 'Salvage % of PAV', { type: 'number', hint: `<span id="salvageHint">= ${gbp(C.round2(t.pav * num(v.salvagePct) / 100))}</span>` })}${F('valuation.salvageOverride', 'Salvage value override £ (e.g. actual bid)', { type: 'number' })}</div>
      <div class="form" style="margin-top:12px">${F('valuation.belowHighestReason', 'Reason for adopting a value below the highest guide', { type: 'textarea', rows: 2, full: true, hint: 'Printed in the report. The ombudsman\'s starting point is the highest retail guide, so explain any lower figure with evidence about this vehicle.' })}</div>
      <h3>Like-for-like adverts</h3>
      <table class="tbl"><thead><tr><th>Description (derivative)</th><th>Year</th><th class="num">Mileage</th><th class="num">Price £</th><th>Source / URL</th><th></th></tr></thead><tbody>
        ${(v.adverts || []).map((a, i) => `<tr><td><input data-adv="description" data-i="${i}" value="${esc(a.description)}"></td><td style="width:80px"><input data-adv="year" data-i="${i}" value="${esc(a.year)}"></td><td class="num" style="width:110px"><input type="number" min="0" data-adv="mileage" data-i="${i}" value="${esc(a.mileage)}"></td><td class="num" style="width:110px"><input type="number" min="0" data-adv="price" data-i="${i}" value="${esc(a.price)}"></td><td><input data-adv="url" data-i="${i}" value="${esc(a.url)}" placeholder="AutoTrader / dealer URL">${a.aiUnverified ? `<div class="hint advUnverified" style="word-break:break-all">AI comparable, not verified${a.claimedUrl ? `: the AI gave ${esc(a.claimedUrl)}` : ''}. Check the advert, then enter its URL. The report lists it separately as found by AI search until you tick Verified.</div><label class="hint advVerify" style="display:inline-flex;gap:5px;align-items:center"><input type="checkbox" data-adv-verify="${i}" style="width:auto"> Verified: I have checked this advert</label>` : ''}</td><td><button class="btn sm danger" data-act="advDel" data-i="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="hint">No adverts. Add your own, or let the AI search for comparables.</td></tr>'}
      </tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="advAdd">+ Advert</button></div>
      <div class="form" style="margin-top:12px">${F('valuation.historyNotes', 'History notes (previous write-off category, finance, plate changes, imports)', { type: 'textarea', rows: 2 })}${F('valuation.optionsNotes', 'Condition, options & service history notes', { type: 'textarea', rows: 2 })}</div></div>
    ${valuationAiPanel()}
    <div class="card"><h2 style="margin-top:0">Economic repair &amp; outcome</h2>
      <div id="econBox">${econBox(t)}</div>
      <div class="form">${F('outcome.decision', 'Economic repair / total-loss assessment', { type: 'select', options: DECISIONS })}
        ${F('outcome.category', 'Salvage category (ABI Code of Practice)', { type: 'select', options: [['', 'Not assessed'], ['A', 'Category A — Scrap'], ['B', 'Category B — Break'], ['S', 'Category S — Structural'], ['N', 'Category N — Non-Structural']], hint: 'A/B: break or crush only — the vehicle must not return to the road. S: structural frame or chassis damaged. N: no structural damage.' })}
        ${F('report.headline', 'Cover headline (optional override)', { ph: 'Auto: e.g. TOTAL LOSS RECOMMENDED' })}${F('report.subHeadline', 'Cover sub-headline (optional override)', { ph: 'Auto: e.g. CATEGORY N - RECOMMENDATION' })}
        ${F('valuation.comments', 'Valuation comments', { type: 'textarea', rows: 8, full: true, hint: '<button class="link" data-act="genValComments">Write from the figures</button> · use **bold** for emphasis' })}</div></div>`;
  }
  function valRange(t) {
    return t.valMax ? `<span class="hint">Range ${gbp(t.valMin)} – ${gbp(t.valMax)} · average ${gbp(t.valAvg)}</span>
        <button class="btn sm" data-act="adopt" data-w="max">Adopt highest</button><button class="btn sm" data-act="adopt" data-w="avg">Adopt average</button><button class="btn sm" data-act="adopt" data-w="min">Adopt lowest</button>` : '';
  }
  function econBox(t) {
    const basis = esc(t.berBasis), thr = esc(t.berThresholdPct);
    return `<div class="totals"><div><span>Net repair</span><b>${gbp(t.net)}</b></div><div><span>Gross repair</span><b>${gbp(t.gross)}</b></div><div><span>PAV</span><b>${t.pav ? gbp(t.pav) : '—'}</b></div>
        <div><span>Repair / PAV (net)</span><b>${t.pctNet.toFixed(2)}%</b></div><div><span>Repair / PAV (gross)</span><b>${t.pctGross.toFixed(2)}%</b></div><div><span>Salvage</span><b>${gbp(t.salvage)}</b></div></div>
      <p>${t.pav ? (t.berSuggested ? `<span class="badge err">Over threshold</span> Repair cost is at or above your ${thr}% (${basis}) economic-repair threshold. Consider a total loss.` : `<span class="badge ok">Within threshold</span> Repair cost is below your ${thr}% (${basis}) threshold.`) : '<span class="hint">Enter a PAV to see the economic repair position.</span>'}</p>`;
  }
  // A comparable's link is shown (and offered for the adverts) only when ai.js matched it to this run's web search results or an
  // advert the engineer entered. Anything else, including older results that were never checked, is shown as text only.
  const verifiedComparable = (c) => isObj(c) && c.verified === true && httpUrl(c.url);
  function valFooter(r) {
    const bits = [r.model || ''];
    if (r.searched) {
      const n = num(r.searches);
      bits.push(`web search: ${r.searches != null ? `${n} search${n === 1 ? '' : 'es'}` : 'used'}${r.search_domains_restricted === true ? ', UK listing sites only' : r.search_domains_restricted === false ? ', not limited to UK listing sites (your organisation\'s search policy rejected the site list)' : ''}`);
    } else if ('searched' in r) bits.push('no web search');
    if ('claim_type' in r) bits.push(`claim type: ${claimLabel(r.claim_type)}`);
    if ('valuation_date' in r) bits.push(r.valuation_date ? `valued at ${C.ukDate(r.valuation_date)}` : 'no valuation date recorded');
    return bits.filter(Boolean).join(' · ');
  }
  function valuationAiPanel() {
    const r = job.valuation.ai;
    const dol = isoDate(job.instruction.dateOfLoss);
    const claimNow = claimKey(job.valuation.claimType);
    return `<div class="card aiPanel"><div class="row"><div class="grow"><h2 style="margin:0">✦ AI valuation assistant</h2><div class="hint">Values the vehicle at the date of loss to the standard for the claim type: for an own-insurer claim the ombudsman's approach (start from the highest guide, adjust only on evidence about this vehicle); for third-party and court claims the cost of a like-for-like replacement. Mileage is checked against the MOT history.</div></div>
      <label class="hint"><input type="checkbox" id="valSearch" style="width:auto" ${ui.valSearch !== false ? 'checked' : ''}> search the web for comparable UK adverts</label>
      <button class="btn ai" data-act="aiValuation" ${desktop && !busy('val') ? '' : 'disabled'}>${busy('val') ? '<span class="spinner"></span>Valuing…' : '✦ AI valuation'}</button></div>
      <p class="hint valSent" style="margin:6px 0 0">Sent with the request: claim type <b>${esc(claimLabel(claimNow))}</b> · valuation date <b>${dol ? esc(C.ukDate(dol)) + ' (date of loss)' : 'none'}</b>${dol ? '' : ': no date of loss is recorded on the Claim tab, so the AI values as at today and flags it'}.</p>
      ${r ? `<div class="totals" style="margin-top:12px"><div class="g"><span>Recommended PAV</span><b>${gbp(r.recommended_pav)}</b></div><div><span>Range</span><b>${gbp(r.range_low)} – ${gbp(r.range_high)}</b></div><div><span>Basis</span><b style="font-size:13px">${esc(r.basis)}</b></div></div>
        <p><b>Guides:</b> ${esc(r.guide_assessment)}</p><p><b>Mileage:</b> ${esc(r.mileage_assessment)}</p>
        ${(r.adjustments || []).length ? `<table class="tbl"><thead><tr><th>Adjustment</th><th class="num">£</th><th>Reason</th></tr></thead><tbody>${r.adjustments.map((a) => `<tr><td>${esc(a.item)}</td><td class="num">${gbp(a.amount)}</td><td class="hint">${esc(a.reason)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${(r.comparables || []).length ? `<h3>Comparables</h3><table class="tbl comps"><thead><tr><th>Vehicle</th><th>Year</th><th class="num">Miles</th><th class="num">Price</th><th>Like-for-like</th><th>Source</th></tr></thead><tbody>${r.comparables.map((c, i) => {
          const ok = verifiedComparable(c);
          const claimed = ok ? '' : String(c.claimed_url || c.url || '').trim();
          return `<tr data-comp="${i}"><td>${esc(c.description)}<div class="hint">${esc(c.notes)}</div></td><td>${esc(c.year)}</td><td class="num">${num(c.mileage).toLocaleString('en-GB')}</td><td class="num">${gbp(c.price)}</td><td>${c.like_for_like ? '<span class="badge ok">yes</span>' : '<span class="badge warn">partial</span>'}</td>
            <td>${ok ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source || 'link')}</a> <span class="badge ok" title="The link matched a page found by this run's web search, or one of your own adverts">verified</span>`
              : `${esc(c.source || '')} <span class="badge warn" title="Not matched to this run's web search results or your own adverts: the advert may not exist at this price">unverified</span>${claimed ? `<div class="hint claimedUrl" style="word-break:break-all">Link given by the AI (not verified, not a link): ${esc(claimed)}</div>` : ''}`}
            <button class="btn sm" data-act="advFromAi" data-i="${i}" title="${ok ? 'Add to adverts' : 'Add to adverts (asks first: not verified)'}">+</button></td></tr>`;
        }).join('')}</tbody></table>` : ''}
        ${flagBox('Check:', (r.flags || []).map((f) => String(f == null ? '' : f)).filter((f) => f.trim()))}
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="aiValApply">Adopt ${gbp(r.recommended_pav)} and use these comments</button><span class="hint valFooter">${esc(valFooter(r))}</span>${'claim_type' in r && claimKey(r.claim_type) !== claimNow ? ' <span class="badge warn">claim type changed since this valuation: run it again</span>' : ''}</div>` : ''}
    </div>`;
  }
  async function aiValuation() {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    const j = job;
    const key = 'val:' + j.id;
    if (running.has(key)) return;
    const ai = C.settings.ai || {};
    running.add(key); renderJob();
    try {
      // the claim type sets the valuation standard; the valuation date is the date of loss (valuation.date is free text, shown as a note)
      const res = await desktop.ai.valuation({ job: slimJob(j), motHistory: j.vehicle.motHistory || [], searchWeb: ui.valSearch !== false, claimType: claimKey(j.valuation.claimType), valuationDate: isoDate(j.instruction.dateOfLoss), model: ai.model, effort: ai.effort });
      if (!res || !res.ok) throw new Error((res && res.error) || 'The AI valuation failed.');
      const target = await applyToJob(j, (x) => { x.valuation.ai = res.result; logAi(x, 'Valuation assistant' + (res.result.searched ? ' (with web search)' : ''), res.result.model); });
      if (!target) toast(`${regOf(j)} has been deleted, so the AI valuation was not saved.`, true);
      else toast(target === job ? 'AI valuation ready. Review the workings before adopting.' : `AI valuation for ${regOf(target)} is ready and saved with that assessment.`);
    } catch (e) { toast(e.message, true); } finally { running.delete(key); if (job && job.id === j.id) renderJob(); }
  }
  function genValComments() {
    const t = C.totals(job);
    const v = job.valuation;
    const unit = job.vehicle.mileageUnit || 'miles';
    const mil = num(v.mileage || job.vehicle.mileage);
    const parts = [];
    if (mil) parts.push(`The vehicle has been valued at **${mil.toLocaleString('en-GB')} ${unit}**.`);
    if (t.valMax) parts.push(`Available valuation evidence ranges from **${C.gbp0(t.valMin)} to ${C.gbp0(t.valMax)}**, and an assessed pre-accident value of **${C.gbp0(t.pav)}** has been adopted.`);
    parts.push(`The provisional salvage allowance of **${gbp(t.salvage)}** is used for assessment purposes only and may be replaced by an actual salvage quotation.`);
    if (/total|ber|beyond/i.test(job.outcome.decision)) parts.push('Having regard to the extent of repair, vehicle age, market value and the reasonably anticipated risk of supplementary repair costs, repair is considered economically disproportionate.\n\nThe vehicle is therefore assessed as:');
    else if (job.outcome.decision === 'Repair') parts.push(`The presently quantified repair cost of ${gbp(t.net)} excluding VAT represents ${t.pctNet.toFixed(2)}% of the pre-accident value, and repair is considered economically viable.`);
    job.valuation.comments = parts.join('\n\n');
    changed(); renderJob();
  }

  // ---------- OPINION ----------
  function tabOpinion() {
    const pd = isObj(job.aiDraftPending) ? job.aiDraftPending : null;
    return `<div class="card"><div class="row"><div class="grow"><h2 style="margin:0">Report narrative</h2><div class="hint">The AI writes every narrative section from your photos, findings, estimate and figures. You review each section before applying it.</div></div>
      <button class="btn ai" data-act="aiDraft" ${!desktop || busy('draft') ? 'disabled' : ''}>${busy('draft') ? '<span class="spinner"></span>Drafting…' : '✦ AI draft all narrative'}</button></div>
      ${pd ? `<div class="row pendingDraft" style="margin-top:10px"><span class="badge ai">AI draft ready</span><button class="btn sm" data-act="reviewPendingDraft">Review the AI draft</button><button class="btn sm danger" data-act="discardDraft">Discard it</button><span class="hint">Drafted ${esc(fmtWhen(pd.at))}. Nothing is changed until you apply sections; the draft is kept with this assessment until then.</span></div>` : ''}</div>
      ${aiFlagsCard()}
      <div class="card"><div class="form">
      ${F('report.summary', 'Section 01 — headline summary (use **bold** for key findings)', { type: 'textarea', rows: 6, full: true })}
      ${F('opinion', "Report comments / engineer's opinion", { type: 'textarea', rows: 18, full: true })}</div></div>`;
  }
  // The "check before signing" flags of applied AI drafts, kept on the job until the assessor dismisses them.
  function aiFlagsCard() {
    const fl = Array.isArray(job.aiFlags) ? job.aiFlags.filter(isObj) : [];
    if (!fl.length) return '';
    return `<div class="card aiFlags" style="border-color:#f0c36d;background:#fffaf0"><div class="row"><b class="grow">AI draft: check before signing (${fl.length})</b><button class="btn sm" data-act="aiFlagDismissAll">Dismiss all</button></div>
      <ul>${fl.map((f, i) => `<li><span class="flagText">${esc(f.text)}</span> <span class="hint">${esc(f.section || '')}${stampOk(f.at) ? ' · ' + esc(fmtWhen(f.at)) : ''}</span> <button class="btn sm" data-act="aiFlagDismiss" data-i="${i}" title="I have dealt with this">Dismiss</button></li>`).join('')}</ul>
      <p class="hint" style="margin:0">The pre-issue checks list each flag until it is dismissed.</p></div>`;
  }
  async function aiDraft() {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    const j = job;
    const key = 'draft:' + j.id;
    if (running.has(key)) return;
    const ai = C.settings.ai || {};
    running.add(key); renderJob();
    try {
      const res = await desktop.ai.draftNarrative({ job: slimJob(j), totals: C.totals(j), settings: { berThresholdPct: C.settings.berThresholdPct, berBasis: C.settings.berBasis }, model: ai.model, effort: ai.effort });
      if (!res || !res.ok) throw new Error((res && res.error) || 'The AI draft failed.');
      // the paid draft is kept with the job until it is applied or discarded, so a reload or restart cannot lose it
      const target = await applyToJob(j, (x) => { logAi(x, 'Narrative drafting', res.result.model); x.aiDraftPending = { at: new Date().toISOString(), model: String(res.result.model || ''), draft: res.result }; });
      if (!target) return toast(`${regOf(j)} has been deleted, so the AI draft was discarded.`, true);
      // a draft never replaces an open window (labeler, signature pad): it waits behind the "AI draft ready – Review" button
      if (target === job && !modalOpen()) reviewDraft(res.result, j.id);
      else if (target === job) toast('AI draft ready – Review it with the button at the top of the page when you are ready. Nothing has been changed.');
      else toast(`The AI draft for ${regOf(target)} is ready. Open that assessment and click "AI draft ready – Review".`);
    } catch (e) { toast(errText(e), true); } finally { running.delete(key); if (job && job.id === j.id && tab === 'opinion') renderJob(); }
  }
  const DRAFT_MAP = [
    ['summary', 'report.summary', 'Section 01 summary'], ['inspection_condition', 'inspection.condition', 'Vehicle condition at inspection'],
    ['structural', 'assessment.structural', 'Structural & body assessment'], ['mechanical', 'assessment.mechanical', 'Mechanical assessment'],
    ['wheels', 'assessment.wheels', 'Wheels & tyres'], ['geometry', 'assessment.geometry', 'Geometry'], ['diagnostics', 'assessment.diagnostics', 'Diagnostics & warning lamps'],
    ['roadworthiness', 'assessment.roadworthiness', 'Roadworthiness'], ['estimate_notes', 'estimateNotes', 'Estimate notes'], ['valuation_comments', 'valuation.comments', 'Valuation comments'],
    ['opinion', 'opinion', "Engineer's opinion"], ['decision', 'outcome.decision', 'Decision'], ['category', 'outcome.category', 'Salvage category']
  ];
  function reviewDraft(d, jid) {
    const map = DRAFT_MAP;
    const flags = (Array.isArray(d.review_flags) ? d.review_flags : []).map((f) => String(f == null ? '' : f)).filter((f) => f.trim());
    const html = `${flags.length ? `<div class="card" style="border-color:#f0c36d;background:#fffaf0"><b>Check before signing:</b><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><p class="hint" style="margin:0">These stay on the Opinion tab, and in the pre-issue checks, until you dismiss them.</p></div>` : ''}
      <div class="cmp" style="font-weight:700"><span></span><span>Current</span><span>AI draft</span></div>
      ${map.map(([k, path, label], i) => { const cur = getPath(job, path) || ''; const nu = d[k] == null ? '' : String(d[k]); if (!nu) return ''; return `<div class="cmp"><input type="checkbox" data-apply="${i}" ${cur ? '' : 'checked'} style="width:auto"><div><b>${esc(label)}</b><div class="old">${esc(cur) || '<i>empty</i>'}</div></div><div class="new">${esc(nu)}</div></div>`; }).join('')}
      <div class="row" style="margin-top:14px"><button class="btn" data-sel="all">Select all</button><button class="btn danger" data-discard="1">Discard the draft</button><span class="grow"></span><button class="btn primary" data-go="1">Apply selected sections</button></div>`;
    const b = openModal('✦ AI draft — review before applying', html);
    if (!b) return toast('AI draft ready – Review it with the button at the top of the page once the open window is closed.');
    b.addEventListener('click', async (e) => {
      if (e.target.closest('[data-sel]')) $$('input[data-apply]', b).forEach((c) => { c.checked = true; });
      if (e.target.closest('[data-discard]')) {
        if (!confirm('Discard this AI draft? It cannot be recovered (the AI log keeps the entry).')) return;
        closeModal();
        try { await applyToJob({ id: jid }, (x) => { delete x.aiDraftPending; }); toast('AI draft discarded.'); } catch (err) { toast(errText(err), true); }
        return;
      }
      if (e.target.closest('[data-go]')) {
        const picks = $$('input[data-apply]', b).filter((c) => c.checked).map((c) => map[+c.dataset.apply]);
        if (!picks.length) return toast('Tick the sections to apply, or close this window to keep the draft for later.', true);
        closeModal();
        const at = new Date().toISOString();
        try {
          // each applied section is recorded in job.aiText, so later AI calls treat it as an AI draft until the assessor edits it;
          // the draft's "check before signing" flags are kept on the job (aiFlags) until dismissed
          const target = await applyToJob({ id: jid }, (x) => {
            picks.forEach(([k, path]) => { setPath(x, path, d[k]); aiTextOf(x)[path] = String(d[k] == null ? '' : d[k]); });
            const have = new Set((Array.isArray(x.aiFlags) ? x.aiFlags : []).filter(isObj).map((f) => f.text));
            const add = flags.filter((f) => !have.has(f)).map((text) => ({ section: 'AI narrative draft', text, at }));
            if (add.length) x.aiFlags = (Array.isArray(x.aiFlags) ? x.aiFlags.filter(isObj) : []).concat(add);
            delete x.aiDraftPending;
          });
          if (!target) return toast('That assessment has been deleted, so the draft was not applied.', true);
          toast(`${picks.length} section(s) applied${target !== job ? ' to ' + regOf(target) : ''}. Review them in the report preview.${flags.length ? ' Its "check before signing" points are listed on the Opinion tab.' : ''}`);
        } catch (err) { toast(errText(err), true); }
      }
    });
  }

  function tabCustomer() {
    return `<div class="card"><div class="form">
      ${F('customer.name', 'Customer / client full name')}${F('customer.company', 'Company name, if applicable')}
      ${F('customer.representative', 'Business representative, if applicable')}${F('customer.relationship', 'Relationship to vehicle', { list: 'rels' })}
      ${F('customer.address', 'Postal address', { full: true })}${F('customer.town', 'Town / county')}${F('customer.postcode', 'Postcode / country')}
      ${F('customer.telephone', 'Telephone')}${F('customer.mobile', 'Mobile')}${F('customer.email', 'Email address', { type: 'email' })}${F('customer.vat', 'VAT status, if relevant')}
      ${F('customer.notes', 'Customer notes', { type: 'textarea', rows: 3, full: true })}</div>
      <datalist id="rels"><option value="Owner"><option value="Registered keeper"><option value="Driver"><option value="Lease / finance customer"><option value="Fleet manager"></datalist></div>`;
  }

  // The signature the report prints today: this report's own, or the default one from Settings when ticked.
  const liveSignature = (j) => j.assessor.signature || (j.assessor.useDefaultSignature ? C.settings.assessor.signature : '') || '';
  function tabSignoff() {
    const iss = job.issued;
    const sig = iss ? iss.signature : liveSignature(job);
    return `<div class="card ${iss ? 'issued' : ''}"><div class="row"><h2 class="grow" style="margin:0">${iss ? 'Report finalised' : 'Finalise the report'}</h2>
        ${iss ? `<span class="badge ok">finalised ${esc(fmtWhen(iss.at))}</span>` : '<button class="btn primary" data-act="finaliseReport">Finalise report</button>'}</div>
      <p class="hint" style="margin-bottom:0">${iss ? 'The report is locked for editing. The company details, logo, declaration, signature, qualifications, AQP ID, labour rates and VAT printed in it are frozen as they were when it was finalised, so later changes in Settings do not alter it. Re-open it to edit or to use the current Settings.' : 'Finalising locks the report for editing and freezes the company details, logo, declaration, signature, qualifications, AQP ID, labour rates and VAT printed in it, so later changes cannot alter an issued report. You can re-open it later.'}</p></div>
      <div class="card"><div class="form">
      ${F('assessor.name', 'Assessor name')}${F('assessor.title', 'Professional role / title')}
      ${F('assessor.qualifications', 'Qualifications (e.g. MIAEA, IMI VDA accreditation no.)')}${F('assessor.aqpId', 'AQP ID (ABI salvage categorisation)')}
      ${F('assessor.dateSigned', 'Date signed', { type: 'date', hint: '<button class="link" data-act="signToday">Sign today</button>' })}<div></div>
      ${F('report.conflicts', 'Conflict of interest declaration', { full: true })}
      ${F('report.materialsRelied', 'Material relied on (literature, guides and data)', { type: 'textarea', rows: 4, full: true, ph: "e.g. Glass's Guide and CAP HPI retail values; three like-for-like advertisements; DVSA MOT History; ABI Code of Practice for the Categorisation of Motor Vehicle Salvage", hint: `${job.report.cpr35 ? '<b>Required in a CPR 35 report</b>: printed' : 'Printed in a CPR 35 report'} as "Material relied on" (PD 35 para 3.2(2)). <button class="link" data-act="suggestMaterials">Suggest from this assessment</button>` })}</div>
      <label class="row" style="margin-top:10px"><input type="checkbox" data-bind-check="report.cpr35" ${job.report.cpr35 ? 'checked' : ''} style="width:auto"> <b>Court-compliant expert report (CPR Part 35 / PD 35)</b>: adds the expert's duty statement, the statement of truth, the material relied on, and the PD 35 checks</label>
      ${(job.aiLog || []).length ? `<h3>AI and data-use log</h3><table class="tbl"><thead><tr><th>When</th><th>Action</th><th>Model / source</th></tr></thead><tbody>${job.aiLog.map((a) => `<tr><td class="hint">${esc(fmtWhen(a.at))}</td><td><span class="badge ${a.ai ? 'ai' : ''}">${a.ai ? 'AI' : 'data'}</span> ${esc(a.action)}</td><td class="hint">${esc(a.model || '')}</td></tr>`).join('')}</tbody></table><p class="hint">The report's "Use of AI and data tools" statement lists these. The assessor remains responsible for every opinion.</p>` : ''}
      ${isObj(job.copiedFrom) ? `<p class="hint">This assessment was copied from ${esc(job.copiedFrom.ref || 'another assessment')}; the AI and data-use log of the original stays with it.</p>` : ''}
      <h3>Signature</h3>
      ${sig ? `<img src="${esc(sig)}" style="max-height:80px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:4px">` : '<p class="hint">No signature.</p>'}
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="sigDraw" data-target="job">Draw signature</button><button class="btn sm" data-act="sigUpload" data-target="job">Upload image</button>
        ${job.assessor.signature ? '<button class="btn sm danger" data-act="sigClear">Remove this report\'s signature</button>' : ''}
        <label class="hint"><input type="checkbox" data-bind-check="assessor.useDefaultSignature" ${job.assessor.useDefaultSignature ? 'checked' : ''} style="width:auto"> use my default signature from Settings</label></div>
      ${iss && sig ? '<p class="hint">This is the signature frozen when the report was finalised.</p>' : ''}
      <h3>Declaration</h3><p class="hint" style="white-space:pre-wrap">${esc(iss ? iss.declaration : C.settings.assessor.declaration)}</p><p class="hint">${iss ? 'The declaration as it was when the report was finalised.' : 'Edit the declaration in Settings → Assessor defaults.'}</p></div>`;
  }

  function tabReport() {
    const qa = C.qaChecks(job);
    const tabName = (k) => (TABS.find((t) => t[0] === k) || [k, k])[1];
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Pre-issue checks</h2>
        <button class="btn" data-act="exportJson">Export job file</button>
        <button class="btn primary" data-act="exportPdf">${desktop ? 'Export PDF report' : 'Print / save as PDF'}</button></div>
      ${qa.length ? `<ul class="qa" style="margin-top:12px">${qa.map((q) => `<li class="${q.level}"><span class="badge ${q.level === 'error' ? 'err' : q.level === 'warn' ? 'warn' : ''}">${q.level}</span><span class="grow">${esc(q.msg)}</span><a href="#/job/${job.id}/${q.tab}">${esc(tabName(q.tab))} →</a></li>`).join('')}</ul>` : '<p><span class="badge ok">All checks passed</span></p>'}</div>
      <iframe class="preview" id="preview" title="Report preview"></iframe>`;
  }

  // Fields still holding AI text the assessor has not edited, by core.js's rule (the one the report and the checks use).
  function unreviewedAiText(j) {
    try { return (C.unreviewedAiText(j) || []).filter(isObj); } catch (e) { return []; }
  }
  async function exportPdf() {
    // everything AI-made that has not been reviewed: estimate lines, damage labels on printed photos, and unedited AI text
    const un = job.lines.filter((l) => l.ai && !l.reviewed).length;
    const photos = job.photos.filter((p) => isObj(p) && !p.exclude && !p.labelsReviewed && (p.labels || []).some((x) => x && x.ai && !x.hidden)).length;
    const texts = unreviewedAiText(job);
    const open = [];
    if (un) open.push(`${un} AI-suggested estimate line${un === 1 ? ' has' : 's have'} not been marked as reviewed`);
    if (photos) open.push(`the AI damage labels on ${photos} photo${photos === 1 ? '' : 's'} in the report have not been reviewed`);
    if (texts.length) open.push(`${texts.length} field${texts.length === 1 ? ' still holds' : 's still hold'} AI text you have not edited (${texts.slice(0, 4).map((x) => x.label || x.path).join(', ')}${texts.length > 4 ? ', …' : ''})`);
    if (open.length && !confirm(`Not reviewed yet:\n• ${open.join('\n• ')}\n\nThe report will say so. Export anyway?`)) return;
    const html = Report.render(job, { mode: desktop ? 'pdf' : 'print' });
    const name = (job.report.ref || job.vehicle.reg || 'engineering-report').replace(/[^\w.-]+/g, '_');
    if (desktop) {
      const tpl = Report.pdfTemplates(job) || {};
      // the page margins come from report.js when it gives them (main.js otherwise uses its own copy of the report's @page margins)
      const r = await desktop.exportPdf(Object.assign({ html, header: tpl.header, footer: tpl.footer, fileName: name }, isObj(tpl.marginsMm) ? { marginsMm: tpl.marginsMm } : {}));
      if (r && r.ok) toast('PDF saved: ' + r.filePath); else if (!(r && r.canceled)) toast('PDF export failed: ' + ((r && r.error) || 'no reply from the app.'), true);
    } else {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      f.srcdoc = html;
      f.onload = () => { f.contentWindow.print(); setTimeout(() => f.remove(), 2000); };
    }
  }
  async function saveText(content, fileName, ext) {
    if (desktop) {
      const r = await desktop.saveFile({ content, fileName, kind: ext });
      if (r && r.ok) toast('Saved ' + r.filePath); else if (!(r && r.canceled)) toast((r && r.error) || 'The file could not be saved.', true);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = fileName; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function pickFile(accept) {
    return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });
  }

  // Logos must be inline PNG / JPEG / GIF / WebP for the report (Report.safeImage). SVG, and anything wider than 900 px,
  // is rasterised to PNG on a canvas (transparency kept); smaller raster logos are kept as they are.
  async function logoDataUrl(file) {
    const raw = await C.readFileAsDataURL(file);
    const svg = /svg/i.test(file.type) || /^data:image\/svg/i.test(raw);
    const img = await C.loadImage(raw);
    const w = img.naturalWidth || (svg ? 900 : 0), h = img.naturalHeight || (svg ? 300 : 0);
    if (!w || !h) return '';
    if (!svg && w <= 900 && Report.safeImage(raw)) return raw;
    const scale = svg ? Math.min(900 / w, 900 / h) : 900 / w; // vector art is drawn at full logo size; raster is only reduced
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return Report.safeImage(c.toDataURL('image/png'));
  }

  // ---------- signature pad ----------
  function signaturePad(onDone) {
    let drawing = false, last = null, inked = false;
    const b = openModal('Draw signature', `<canvas class="sigpad" width="640" height="200" style="width:100%;max-width:640px"></canvas><div class="row" style="margin-top:10px"><button class="btn" data-clr>Clear</button><span class="grow"></span><button class="btn primary" data-ok>Use signature</button></div>`, { isDirty: () => inked });
    if (!b) return;
    const cv = $('canvas', b); const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.strokeStyle = '#13233a';
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    cv.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; inked = true; });
    cv.addEventListener('pointerup', () => { drawing = false; });
    b.addEventListener('click', (e) => {
      if (e.target.dataset.clr != null) { ctx.clearRect(0, 0, cv.width, cv.height); inked = false; }
      if (e.target.dataset.ok != null) {
        if (!inked) return toast('Draw a signature first.', true);
        const url = cv.toDataURL('image/png');
        closeModal();
        Promise.resolve().then(() => onDone(url)).catch((err) => toast(errText(err), true));
      }
    });
  }

  // ---------- SETTINGS ----------
  let dataStatus = { dvla: false, mot: false };
  async function renderSettings() {
    const seq = routeSeq;
    if (desktop) {
      aiStatus = await readStatus(() => desktop.ai.status());
      dataStatus = await readStatus(() => desktop.data.status());
      if (!appInfo) appInfo = await readAppInfo();
      paintAiState();
    }
    if (seq !== routeSeq) return;
    const s = C.settings;
    const aiErr = desktop ? statusError(aiStatus) : '', dataErr = desktop ? statusError(dataStatus) : '';
    // while the saved credentials cannot be read, main refuses every change except "remove all"
    const locked = !!dataStatus.unreadable;
    const off = locked ? ' disabled title="The saved credentials cannot be read: remove them first (above)"' : '';
    main.innerHTML = `<div class="wrap"><h1>Settings</h1><div class="sub">Company details, rates and AI. These apply to every report.</div>
      <div class="card"><h2 style="margin-top:0">Company &amp; report branding</h2><div class="form">
        ${S('company.name', 'Company name')}${S('company.tradingName', 'Trading name / site')}${S('company.address', 'Address', { full: true })}
        ${S('company.companyNo', 'Company number')}${S('company.phone', 'Telephone')}${S('company.email', 'Email')}<div></div>
        ${S('company.coverTitle', 'Cover title')}${S('company.coverSubtitle', 'Cover subtitle')}${S('company.reportTitle', 'Page header title')}<div></div>
        ${S('company.navy', 'Heading colour', { type: 'color' })}${S('company.accent', 'Accent colour', { type: 'color' })}</div>
        <h3>Logo</h3><div class="row">${s.company.logo ? `<img src="${esc(s.company.logo)}" style="max-height:70px;background:#fff;border:1px solid var(--line);padding:4px;border-radius:6px">` : '<span class="hint">No logo uploaded.</span>'}
        <button class="btn sm" data-act="logoUpload">Upload logo</button>${s.company.logo ? '<button class="btn sm danger" data-act="logoClear">Remove</button>' : ''}</div></div>
      <div class="card"><h2 style="margin-top:0">Rates &amp; thresholds</h2><div class="form3">
        ${Object.keys(s.rates).map((k) => S('rates.' + k, `${k} labour rate £/h`, { type: 'number', step: '0.01' })).join('')}
        ${S('vatPct', 'VAT %', { type: 'number' })}${S('salvagePct', 'Default salvage % of PAV', { type: 'number' })}
        ${S('paintMaterialsPerHour', 'Paint materials £ per paint hour', { type: 'number', step: '0.01', hint: 'Used by "Calculate paint materials".' })}${S('blendFactor', 'Blend time as fraction of refinish', { type: 'number', step: '0.05' })}
        ${S('berThresholdPct', 'Economic repair threshold %', { type: 'number', hint: 'Repair cost as % of PAV at which a total loss is flagged.' })}${S('berBasis', 'Threshold based on', { type: 'select', options: [['net', 'Net (excl. VAT)'], ['gross', 'Gross (incl. VAT)']] })}</div>
        <p class="hint">Labour rates and VAT are copied into each new assessment. Existing assessments keep their own; use Estimate → "Use current Settings rates" to update one.</p></div>
      <div class="card"><h2 style="margin-top:0">Data connections</h2>
        ${desktop ? `${dataErr ? errBox(locked ? 'The saved credentials cannot be read.' : 'Data connections:', dataErr, locked ? '<div class="row" style="margin-top:8px"><button class="btn danger" data-act="clearAllData">Remove all saved credentials</button><button class="btn" data-act="recheckData">Check again</button><span class="hint">Nothing can be saved until they are removed, unless the file can be read again.</span></div>' : '') : ''}
        <p>DVLA: ${dataStatus.dvla ? '<span class="badge ok">key saved</span>' : '<span class="badge warn">not set</span>'} · MOT History: ${dataStatus.mot ? '<span class="badge ok">credentials saved</span>' : '<span class="badge warn">not set</span>'}</p>
        <h3>DVLA Vehicle Enquiry Service</h3>
        <div class="form"><label class="fld"><span>DVLA API key (x-api-key)</span><input type="password" id="kDvla" autocomplete="off" placeholder="${dataStatus.dvla ? '•••••• saved, paste a new key to replace' : 'paste the key from your DVLA email'}"></label>
          ${S('dvlaEnv', 'DVLA service', { type: 'select', options: [['live', 'Live'], ['test', 'Test (UAT): test keys only, test registrations']], hint: 'DVLA test keys only work on the test service (test registrations such as AA19AAA).' })}
          <div class="row" style="align-items:end"><button class="btn primary" data-act="saveDvla"${off}>Save DVLA key</button>${dataStatus.dvla ? `<button class="btn danger" data-act="clearDvla"${off}>Remove</button>` : ''}</div></div>
        <h3>DVSA MOT History API</h3>
        <p class="hint">Copy each value from the DVSA "Here are your credentials" email.</p>
        <div class="form"><label class="fld"><span>Client ID</span><input type="password" id="kMotId" autocomplete="off"></label><label class="fld"><span>Client secret</span><input type="password" id="kMotSecret" autocomplete="off"></label>
          <label class="fld"><span>API key</span><input type="password" id="kMotKey" autocomplete="off"></label><label class="fld"><span>Token URL (https://login.microsoftonline.com/…/oauth2/v2.0/token) or tenant ID</span><input type="password" id="kMotTokenUrl" autocomplete="off"></label>
          <label class="fld"><span>Scope URL</span><input id="kMotScope" autocomplete="off" placeholder="https://tapi.dvsa.gov.uk/.default"></label>
          <div class="row" style="align-items:end"><button class="btn primary" data-act="saveMot"${off}>Save MOT credentials</button>${dataStatus.mot ? `<button class="btn danger" data-act="clearMot"${off}>Remove</button>` : ''}</div></div>
        <h3>Test the connections</h3>
        <div class="row"><input id="testReg" placeholder="Registration, e.g. ${C.settings.dvlaEnv === 'test' ? 'AA19AAA' : 'AB12 CDE'}" style="width:220px"><button class="btn" data-act="testDvla" ${dataStatus.dvla ? '' : 'disabled'}>Test DVLA</button><button class="btn" data-act="testMot" ${dataStatus.mot ? '' : 'disabled'}>Test MOT History</button></div>
        <p class="hint dataStorage">${storageNote(dataStatus, false)} If a DVSA client secret expires (every 2 years) or an API key is unused for 90 days, request new ones from DVSA.</p>` : '<p class="hint">Data connections work in the desktop app.</p>'}</div>
      <div class="card aiPanel"><h2>✦ AI assessor</h2>
        ${desktop ? `${aiErr ? errBox('The AI features cannot run:', aiErr) : ''}<p>Status: ${aiStatus.hasKey ? '<span class="badge ok">API key set</span>' : '<span class="badge warn">No API key</span>'} <span class="hint aiStorage">${storageNote(aiStatus, true)}</span></p>
        <div class="form"><label class="fld"><span>Anthropic API key</span><input type="password" id="aiKey" placeholder="${aiStatus.hasKey ? '•••••••••• (saved, enter a new key to replace)' : 'sk-ant-…'}"></label>
          <div class="row" style="align-items:end"><button class="btn primary" data-act="aiSaveKey">Save key</button><button class="btn" data-act="aiTest">Test connection</button>${aiStatus.hasKey ? '<button class="btn danger" data-act="aiClearKey">Remove key</button>' : ''}</div>
          ${S('ai.model', 'Model', { hint: 'Default: claude-opus-5-5 (Anthropic\'s current Opus model, with vision).' })}${S('ai.effort', 'Thoroughness (effort)', { type: 'select', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High (recommended)'], ['xhigh', 'Extra high'], ['max', 'Maximum (slowest)']] })}</div>
        <p class="hint">Get a key at console.anthropic.com. Photos and claim details are sent to Anthropic's API for analysis when you press an AI button, and only then. Check this fits your data-protection notices to clients.</p>`
        : '<p class="hint">AI features run in the desktop app (Windows .exe). In a browser the rest of the software works, but AI buttons are disabled.</p>'}</div>
      <div class="card"><h2 style="margin-top:0">Assessor defaults</h2><div class="form">
        ${S('assessor.name', 'Default assessor name')}${S('assessor.title', 'Default professional title')}
        ${S('assessor.qualifications', 'Qualifications (e.g. MIAEA, IMI VDA)')}${S('assessor.aqpId', 'AQP ID (ABI salvage categorisation)')}
        ${S('assessor.accreditationExpiry', 'Accreditation expiry date', { type: 'date', hint: 'You will be warned when it has passed.' })}<div></div>
        ${S('assessor.declaration', 'Assessor declaration', { type: 'textarea', rows: 8, full: true })}</div>
        <h3>Default signature</h3><div class="row">${s.assessor.signature ? `<img src="${esc(s.assessor.signature)}" style="max-height:70px;background:#fff;border:1px solid var(--line);padding:4px">` : '<span class="hint">None.</span>'}
        <button class="btn sm" data-act="sigDraw" data-target="default">Draw</button><button class="btn sm" data-act="sigUpload" data-target="default">Upload</button></div></div>
      <div class="card"><h2 style="margin-top:0">Data</h2><p class="hint">Assessments are stored on this computer. Back up regularly: a backup file (.ersbackup) holds every assessment with its photos, these settings and your own part numbers. API keys and data-connection credentials are never included.${appInfo && appInfo.dataFolder ? ` Data folder: <code class="dataFolder">${esc(appInfo.dataFolder)}</code>` : ''}</p>
        <div class="row"><button class="btn" data-act="backup">Export full backup</button><button class="btn" data-act="restore">Restore backup</button><span class="hint" id="dataProgress" role="status"></span></div></div></div>`;
  }
  let appInfo = null;
  // where the app keeps its data (desktop app only); null when the bridge cannot say
  async function readAppInfo() {
    if (!(desktop && desktop.app && typeof desktop.app.info === 'function')) return null;
    const r = await readStatus(() => desktop.app.info());
    return r && r.ok !== false && typeof r.dataFolder === 'string' && r.dataFolder ? r : null;
  }

  // ---------- CATALOGUE ----------
  function renderCatalogue() {
    const vs = C.oemVehicles();
    const sel = ui.catVeh || (vs[0] && vs[0].key) || '';
    const v = C.findOemVehicle(sel);
    const q = (ui.catQ || '').toLowerCase();
    const rows = Object.values(C.CAT).filter((p) => !q || (p.name + ' ' + p.code + ' ' + p.group).toLowerCase().includes(q) || (v && ['', 'L', 'R'].some((s) => (v.parts[p.code + '|' + s] || []).some((c) => String(c.oem).toLowerCase().includes(q)))));
    const own = userOemRows();
    const total = vs.reduce((n, x) => n + Object.values(x.parts).flat().length, 0) - own.length;
    main.innerHTML = `<div class="wrap"><h1>Parts catalogue</h1>
      <div class="sub">${Object.keys(C.CAT).length} master parts with this software's own codes and guide times, plus ${total} researched OEM part numbers across ${vs.length} vehicles${own.length ? ` and ${own.length} of your own` : ''}. Add your own numbers as you use them.</div>
      <div class="card"><div class="row">
        <label class="fld" style="width:340px"><span>Vehicle</span><select id="catVeh">${vs.map((x) => `<option value="${esc(x.key)}"${x.key === sel ? ' selected' : ''}>${esc(x.make + ' ' + x.model + ' ' + x.generation + ' (' + x.years + ')')} — ${Object.values(x.parts).flat().length} nos.</option>`).join('')}</select></label>
        <label class="fld grow"><span>Search parts or part numbers</span><input id="catQ" value="${esc(ui.catQ || '')}" placeholder="e.g. mirror, FW001, 96301"></label>
        <button class="btn" data-act="catAddVeh">+ Vehicle</button><button class="btn" data-act="catAddNo">+ Part number</button><button class="btn" data-act="catImport" title="CSV columns: code, side (LH/RH), oem, description, price (£ ex VAT). A header row is optional; quoted fields may contain commas.">Import CSV</button></div>
        ${v && v.notes ? `<p class="hint">${esc(v.notes)}</p>` : ''}
        <p class="hint"><span class="oem confirmed">■ confirmed</span> = 2+ independent sources or official listing · <span class="oem single-source">■ single-source</span> = verify before use · <span class="oem user">■ your number</span> = added by you. Always confirm by VIN before ordering.</p></div>
      ${userOemCard(own, q)}
      <div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Code</th><th>Part</th><th>Group</th><th class="num">Replace h</th><th class="num">Refinish h</th><th>OEM numbers (${v ? esc(v.make + ' ' + v.model) : '—'})</th></tr></thead><tbody>
      ${rows.map((p) => { const cells = v ? ['', 'L', 'R'].map((s) => (v.parts[p.code + '|' + s] || []).map((c) => `<div class="oem ${c.user ? 'user' : esc(c.confidence)}" title="${esc(c.description + ' · ' + (c.user ? 'your number' : c.notes || ''))}">${s ? C.sideWord(s) + ': ' : ''}<b>${esc(c.oem)}</b>${oemPrice(c) ? ' · ' + oemPrice(c) : ''}${c.user ? ' <span class="hint">your number</span>' : ''}${httpUrl(c.source) ? ` <a href="${esc(c.source)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`).join('')).join('') : ''; return `<tr><td><code>${p.code}</code></td><td>${esc(p.name)}${p.sided ? ' <span class="hint">LH/RH</span>' : ''}</td><td class="hint">${esc(p.group)}</td><td class="num">${p.replaceHrs}</td><td class="num">${p.refinishHrs || '—'}</td><td>${cells || '<span class="hint">—</span>'}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }

  // ---- the assessor's own part numbers (C.customOem: [{ key, make, model, generation, years, parts: { 'CODE|SIDE': [entry] } }]) ----
  // Every entry is confidence 'user' ("your number"); it fills an estimate line only when autoFill is true (ticked by the user).
  async function saveCustomOem(list) { await withTimeout(Promise.resolve(C.Store.set('customOem', list)), SAVE_TIMEOUT, 'storage did not respond within 20 seconds'); C.setCustomOem(list); }
  function userOemRows() {
    const out = [];
    for (const cv of C.customOem) {
      if (!isObj(cv) || !isObj(cv.parts)) continue;
      for (const [pk, arr] of Object.entries(cv.parts)) (Array.isArray(arr) ? arr : []).forEach((c, n) => { if (isObj(c)) out.push({ cv, pk, n, c }); });
    }
    return out;
  }
  function userOemCard(rows, q) {
    const vehName = (cv) => [cv.make, cv.model, cv.generation].filter(Boolean).join(' ');
    const shown = rows.filter(({ cv, pk, c }) => !q || [vehName(cv), pk, (C.CAT[pk.split('|')[0]] || {}).name, c.oem, c.description, c.notes].some((x) => String(x || '').toLowerCase().includes(q)));
    const attrs = ({ cv, pk, n }) => `data-vk="${esc(cv.key)}" data-pk="${esc(pk)}" data-n="${n}"`;
    return `<div class="card userOem"><div class="row"><h2 class="grow" style="margin:0">Your part numbers (${rows.length})</h2><span class="hint">Numbers you added or imported. One fills new estimate lines only when its auto-fill box is ticked.</span></div>
      ${rows.length ? `<div style="overflow:auto;margin-top:8px"><table class="tbl"><thead><tr><th>Vehicle</th><th>Part</th><th>Side</th><th>Part number</th><th>Description</th><th class="num">Price ex VAT</th><th>Auto-fill</th><th>Notes</th><th></th></tr></thead><tbody>
      ${shown.slice(0, 400).map((r) => { const [code, side] = r.pk.split('|'); const p = C.CAT[code]; return `<tr class="uoem">
        <td>${esc(vehName(r.cv))}</td><td><code>${esc(code)}</code> ${esc(p ? p.name : '')}</td><td>${esc(C.sideWord(side) || '—')}</td>
        <td><b>${esc(r.c.oem)}</b></td><td>${esc(r.c.description)}</td><td class="num">${num(r.c.price) ? gbp(r.c.price) : '—'}</td>
        <td><input type="checkbox" data-oem-af ${attrs(r)} ${r.c.autoFill === true ? 'checked' : ''} style="width:auto" title="Fill new estimate lines for this part with this number"></td>
        <td class="hint">${esc(r.c.notes)}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-act="oemEdit" ${attrs(r)}>Edit</button><button class="btn sm danger" data-act="oemDel" ${attrs(r)}>Delete</button></td></tr>`; }).join('')}
      </tbody></table></div>${shown.length > 400 ? `<p class="hint">Showing 400 of ${shown.length}: search to narrow the list.</p>` : !shown.length ? '<p class="hint">None match the search.</p>' : ''}` : '<p class="hint" style="margin-bottom:0">None yet. Use "+ Part number" or "Import CSV" above.</p>'}</div>`;
  }
  const userOemAt = (list, vk, pk, n) => { const cv = list.find((x) => isObj(x) && x.key === vk); const arr = cv && isObj(cv.parts) && Array.isArray(cv.parts[pk]) ? cv.parts[pk] : null; return arr && isObj(arr[n]) ? arr[n] : null; };
  function removeUserOem(list, vk, pk, n) {
    const cv = list.find((x) => isObj(x) && x.key === vk); if (!cv || !isObj(cv.parts) || !Array.isArray(cv.parts[pk])) return;
    cv.parts[pk].splice(n, 1);
    if (!cv.parts[pk].length) delete cv.parts[pk];
  }
  // Adds one entry for vehicle `key` and part 'CODE|SIDE'; the same number (case, spaces, dots and dashes ignored) is never there
  // twice: an existing one is updated instead ('updated'; keepAutoFill keeps its auto-fill choice). Returns 'added' or 'updated'.
  function addUserOem(list, key, base, pk, entry, keepAutoFill) {
    let cv = list.find((x) => isObj(x) && x.key === key);
    if (!cv) { cv = { key, make: base.make, model: base.model, generation: base.generation || '', years: base.years || '', parts: {} }; list.push(cv); }
    if (!isObj(cv.parts)) cv.parts = {};
    const arr = cv.parts[pk] = Array.isArray(cv.parts[pk]) ? cv.parts[pk] : [];
    const hit = arr.find((c) => isObj(c) && normPn(c.oem) === normPn(entry.oem));
    if (hit) { Object.assign(hit, entry, keepAutoFill ? { autoFill: hit.autoFill === true } : {}); return 'updated'; }
    arr.unshift(entry);
    return 'added';
  }
  const userEntry = (fields) => Object.assign({ oem: '', description: '', notes: '', price: null, priceIncVat: null, source: '', confidence: 'user', user: true, autoFill: false, role: 'primary', market: 'UK', addedAt: new Date().toISOString() }, fields);
  // The stored list brought up to date (on load and for a backup's list): every entry is the user's own ('user'); entries saved
  // by older versions as 'confirmed' with auto-fill on stop auto-filling (it was never the user's choice); repeated numbers dropped.
  function migrateCustomOem(raw) {
    let changed = !Array.isArray(raw), autoOff = 0;
    const list = (Array.isArray(raw) ? raw : []).filter((cv) => isObj(cv) && cv.key);
    if (Array.isArray(raw) && list.length !== raw.length) changed = true;
    for (const cv of list) {
      if (!isObj(cv.parts)) { cv.parts = {}; changed = true; }
      for (const [pk, arr] of Object.entries(cv.parts)) {
        const seen = new Set(), out = [];
        for (const c of Array.isArray(arr) ? arr : []) {
          if (!isObj(c) || !String(c.oem == null ? '' : c.oem).trim()) { changed = true; continue; }
          const k = normPn(c.oem);
          if (seen.has(k)) { changed = true; continue; }
          seen.add(k);
          if (c.confidence !== 'user') { if (c.autoFill !== false) autoOff++; c.confidence = 'user'; c.autoFill = false; changed = true; }
          if (c.user !== true) { c.user = true; changed = true; }
          if (typeof c.autoFill !== 'boolean') { c.autoFill = false; changed = true; }
          out.push(c);
        }
        if (!Array.isArray(arr) || out.length !== arr.length) changed = true;
        if (out.length) cv.parts[pk] = out; else delete cv.parts[pk];
      }
    }
    return { list, changed, autoOff };
  }
  // A backup's own part numbers added to the current ones: nothing is replaced or removed, duplicates are skipped.
  function mergeCustomOem(current, incoming) {
    const list = C.clone(current);
    let added = 0;
    for (const cv of migrateCustomOem(C.clone(incoming)).list) {
      let tgt = list.find((x) => isObj(x) && x.key === cv.key);
      if (!tgt) { tgt = Object.assign({}, cv, { parts: {} }); list.push(tgt); }
      if (!isObj(tgt.parts)) tgt.parts = {};
      for (const [pk, arr] of Object.entries(cv.parts)) {
        const have = tgt.parts[pk] = Array.isArray(tgt.parts[pk]) ? tgt.parts[pk] : [];
        const keys = new Set(have.filter(isObj).map((c) => normPn(c.oem)));
        for (const c of arr) { const k = normPn(c.oem); if (keys.has(k)) continue; keys.add(k); have.push(c); added++; }
      }
    }
    return { list, added };
  }
  async function loadCustomOem() {
    const m = migrateCustomOem((await C.Store.get('customOem')) || []);
    C.setCustomOem(m.list);
    if (!m.changed) return;
    try { await saveCustomOem(m.list); } catch (e) { /* kept in memory: stored with the next change */ }
    const one = m.autoOff === 1;
    if (m.autoOff) setTimeout(() => toast(`${m.autoOff} of your own part number${one ? ' is' : 's are'} now marked "your number" and no longer fill${one ? 's' : ''} estimate lines by ${one ? 'itself' : 'themselves'}. Tick auto-fill for the ones you want (Parts catalogue → Your part numbers).`), 800);
  }
  // + Part number, and Edit on one of your numbers: the same form
  function oemForm(edit) {
    const vs = C.oemVehicles();
    const cur = edit ? edit.c : {};
    const [eCode, eSide] = edit ? edit.pk.split('|') : ['', ''];
    const vehKey = edit ? edit.vk : ui.catVeh || (vs[0] && vs[0].key) || '';
    const b = openModal(edit ? 'Edit your part number' : 'Add OEM part number', `<div class="form">
      <label class="fld"><span>Vehicle</span><select id="nVeh">${vs.map((x) => `<option value="${esc(x.key)}"${x.key === vehKey ? ' selected' : ''}>${esc(x.make + ' ' + x.model + ' ' + x.generation)}</option>`).join('')}</select></label>
      <label class="fld"><span>Catalogue part</span><select id="nCode">${Object.values(C.CAT).map((p) => `<option value="${p.code}"${p.code === eCode ? ' selected' : ''}>${p.code} — ${esc(p.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Side</span><select id="nSide"><option value="">— (not sided)</option><option value="L"${eSide === 'L' ? ' selected' : ''}>LH</option><option value="R"${eSide === 'R' ? ' selected' : ''}>RH</option></select></label>
      <label class="fld"><span>OEM part number</span><input id="nOem" value="${esc(cur.oem || '')}"></label>
      <label class="fld"><span>Description</span><input id="nDesc" value="${esc(cur.description || '')}"></label><label class="fld"><span>Price £ ex VAT (optional)</span><input id="nPrice" type="number" step="0.01" min="0" value="${esc(cur.price == null ? '' : cur.price)}"></label>
      <label class="fld full"><span>Notes / source</span><input id="nNotes" value="${esc(cur.notes || '')}" placeholder="e.g. Confirmed by dealer for VIN …"></label>
      <label class="hint full" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="nAuto" style="width:auto"${cur.autoFill === true ? ' checked' : ''}> <b>Auto-fill</b>: fill new estimate lines for this part with this number (otherwise you choose it with ⋯ on the line)</label></div>
      <div class="row" style="margin-top:12px"><span class="grow"></span><button class="btn primary" data-ok>${edit ? 'Save' : 'Add'}</button></div>`);
    if (!b) return;
    let saving = false;
    b.addEventListener('click', async (e) => {
      if (e.target.dataset.ok == null || saving) return;
      const oem = $('#nOem', b).value.trim(); if (!oem) return toast('Enter a part number.', true);
      const key = $('#nVeh', b).value; const base = C.findOemVehicle(key);
      if (!base) return toast('Choose a vehicle.', true);
      const code = $('#nCode', b).value, pk = code + '|' + $('#nSide', b).value;
      const entry = userEntry({ oem, description: $('#nDesc', b).value.trim() || (C.CAT[code] || {}).name || '', notes: $('#nNotes', b).value.trim(), price: num($('#nPrice', b).value) || null, autoFill: $('#nAuto', b).checked });
      if (edit && cur.addedAt) entry.addedAt = cur.addedAt;
      saving = true;
      try {
        const list = C.clone(C.customOem);
        if (edit) removeUserOem(list, edit.vk, edit.pk, edit.n);
        const res = addUserOem(list, key, base, pk, entry, false);
        await saveCustomOem(list);
        closeModal(); ui.catVeh = key; renderCatalogue();
        toast(edit ? 'Part number saved.' : res === 'updated' ? 'That number was already in your list for this part, so it was updated instead of added again.' : 'Part number added.');
      } catch (err) { toast('The part number could not be saved: ' + errText(err), true); } finally { saving = false; }
    });
  }
  const catAddNo = () => oemForm(null);
  function catAddVeh() {
    const b = openModal('Add catalogue vehicle', `<div class="form"><label class="fld"><span>Make</span><input id="vMake"></label><label class="fld"><span>Model</span><input id="vModel"></label>
      <label class="fld"><span>Generation / chassis code</span><input id="vGen" placeholder="e.g. Mk8, F15, J11"></label><label class="fld"><span>Years</span><input id="vYears" placeholder="2017-2023"></label></div>
      <div class="row" style="margin-top:12px"><span class="grow"></span><button class="btn primary" data-ok>Add</button></div>`);
    if (!b) return;
    let saving = false;
    b.addEventListener('click', async (e) => {
      if (e.target.dataset.ok == null || saving) return;
      const make = $('#vMake', b).value.trim(), model = $('#vModel', b).value.trim();
      if (!make || !model) return toast('Make and model are required.', true);
      const gen = $('#vGen', b).value.trim();
      const key = 'user-' + (make + '-' + model + '-' + gen).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const list = C.clone(C.customOem);
      if (!list.find((x) => x.key === key)) list.push({ key, make, model, generation: gen, years: $('#vYears', b).value.trim(), parts: {} });
      saving = true;
      try { await saveCustomOem(list); ui.catVeh = key; closeModal(); renderCatalogue(); } catch (err) { toast('The vehicle could not be saved: ' + errText(err), true); } finally { saving = false; }
    });
  }
  // RFC 4180 CSV: quoted fields may hold commas, line breaks and doubled quotes ("").
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      } else if (ch === '"' && f.trim() === '') { q = true; f = ''; }
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
  }
  // Imported numbers are your own ("your number"), without auto-fill; a number already in your list for the same vehicle, part and
  // side is updated, not added twice (so importing a corrected file again does not double anything).
  async function catImport() {
    const f = await pickFile('.csv,text/csv'); if (!f) return;
    const rows = parseCsv(await f.text());
    const key = ui.catVeh || (C.oemVehicles()[0] || {}).key; const base = C.findOemVehicle(key);
    if (!base) return toast('Choose a vehicle first.', true);
    const list = C.clone(C.customOem);
    // the first row is a header only when it says "code" or does not start with a catalogue code
    let start = 0, headerNote = '';
    if (rows.length) { const c0 = rows[0][0] || ''; if (/^code$/i.test(c0)) start = 1; else if (!C.CAT[c0.toUpperCase()]) { start = 1; headerNote = ` The first row ("${c0.slice(0, 30)}") was read as a header.`; } }
    let n = 0, upd = 0, bad = 0;
    for (const c of rows.slice(start)) {
      const code = (c[0] || '').toUpperCase(), oem = c[2] || '';
      if (!C.CAT[code] || !oem) { bad++; continue; }
      const sd = (c[1] || '').toUpperCase().replace(/\s+/g, '');
      const side = /^(L|LH|LEFT|NS|N\/S|NEARSIDE)$/.test(sd) ? 'L' : /^(R|RH|RIGHT|OS|O\/S|OFFSIDE)$/.test(sd) ? 'R' : '';
      const price = num(String(c[4] || '').replace(/[£,\s]/g, ''));
      const res = addUserOem(list, key, base, code + '|' + side, userEntry({ oem, description: c[3] || C.CAT[code].name, notes: 'Imported from CSV', price: price || null }), true);
      if (res === 'added') n++; else upd++;
    }
    await saveCustomOem(list); renderCatalogue();
    toast(`Imported ${n} part number(s)${upd ? `, updated ${upd} already in your list` : ''}${bad ? `, skipped ${bad} row(s) with an unknown code or no part number` : ''}.${headerNote} They are your own numbers: tick auto-fill (Your part numbers) for any that should fill estimate lines. CSV columns: code,side,oem,description,price (£ ex VAT)`, !n && !upd && (bad > 0 || !rows.length));
  }

  // ---------- BACKUP / RESTORE ----------
  // Backup format 2 (.ersbackup) is JSON Lines: a header, the settings, your own part numbers, one line per assessment, and an end
  // line that shows the file is complete. The backup is never held as one string, so it works at any size. Format 1 (one JSON
  // object, .json) from earlier versions can still be restored.
  const BACKUP_KIND = 'engineer-report-studio-backup';
  const CHUNK = 8 * 1024 * 1024; // characters per write (about 8 MB)
  const V1_MAX = 500 * 1024 * 1024; // a format-1 backup is read as one string, so it can never be larger than this
  const progress = (txt) => { const el = $('#dataProgress'); if (el) el.textContent = txt; };
  // Where the backup goes. Desktop app: main writes it to disk chunk by chunk (desktop.backup). Browser: one Blob of many parts.
  function backupSink(fileName) {
    const B = desktop && desktop.backup;
    if (B) {
      let id = null, buf = [], size = 0;
      const fail = (r, what) => new Error((r && r.error) || what);
      const flush = async () => {
        if (!buf.length) return;
        const s = buf.length === 1 ? buf[0] : buf.join('');
        buf = []; size = 0;
        for (let i = 0; i < s.length;) {
          let end = Math.min(s.length, i + CHUNK);
          if (end < s.length) { const c = s.charCodeAt(end - 1); if (c >= 0xD800 && c <= 0xDBFF) end--; } // never split a surrogate pair
          const r = await B.write(id, s.slice(i, end));
          if (!r || !r.ok) throw fail(r, 'The backup could not be written.');
          i = end;
        }
      };
      return {
        async open() { const r = await B.begin({ fileName }); if (r && r.ok && r.id != null) { id = r.id; return true; } if (r && r.canceled) return false; throw fail(r, 'The backup file could not be created.'); },
        async push(line) { buf.push(line); size += line.length; if (size >= CHUNK) await flush(); },
        async close() { await flush(); const r = await B.end(id); if (!r || !r.ok) throw fail(r, 'The backup file could not be finished.'); id = null; return r.filePath || ''; },
        async abort() { if (id == null) return; const k = id; id = null; buf = []; try { await B.abort(k); } catch (e) { /* main also deletes an unfinished file when the window closes */ } }
      };
    }
    const blobs = []; // each line becomes a Blob straight away, so the browser can keep the data out of the page's memory
    return {
      async open() { return true; },
      async push(line) { blobs.push(new Blob([line])); },
      async close() {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(blobs, { type: 'application/x-ndjson' }));
        a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        return '';
      },
      async abort() { blobs.length = 0; }
    };
  }
  async function backupAll() {
    await Promise.race([flushSave(), delay(ROUTE_SAVE_WAIT)]);
    const ids = (await C.Store.listJobIds()).filter((id) => id != null);
    const sink = backupSink(`backup-${today()}.ersbackup`);
    if (!(await sink.open())) return; // the save dialog was cancelled
    let written = 0;
    try {
      await sink.push(JSON.stringify({ kind: BACKUP_KIND, format: 2, at: new Date().toISOString(), jobs: ids.length }) + '\n');
      await sink.push(JSON.stringify({ type: 'settings', data: C.settings }) + '\n');
      await sink.push(JSON.stringify({ type: 'customOem', data: C.customOem }) + '\n');
      for (let k = 0; k < ids.length; k++) {
        progress(`Backing up ${k + 1} of ${ids.length}…`);
        // changes that could not be stored (storage full) are backed up from memory, so a backup can rescue them
        const mem = loaded.get(ids[k]);
        const j = mem && mem.job && (pending.has(ids[k]) || failed.has(ids[k])) ? mem.job : await C.Store.getJob(ids[k]);
        if (!isObj(j)) continue; // deleted meanwhile
        let line;
        try { line = JSON.stringify({ type: 'job', data: j }); } catch (err) { throw new Error(`${regOf(j)} could not be written to the backup (${errText(err)}).`); }
        await sink.push(line + '\n');
        written++;
      }
      await sink.push(JSON.stringify({ type: 'end', jobs: written }) + '\n');
      const where = await sink.close();
      toast(`Backup saved: ${written} assessment${written === 1 ? '' : 's'}${where ? ` to ${where}` : ''}.`);
    } catch (err) {
      await sink.abort();
      toast('The backup failed, so no backup file was kept: ' + errText(err), true);
    } finally { progress(''); }
  }

  // The lines of a text file, read as a stream (never as one string).
  async function* readLines(file) {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    let parts = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let from = 0, nl;
        while ((nl = value.indexOf('\n', from)) !== -1) {
          parts.push(value.slice(from, nl));
          const line = parts.length === 1 ? parts[0] : parts.join('');
          parts = [];
          from = nl + 1;
          yield line.endsWith('\r') ? line.slice(0, -1) : line;
        }
        if (from < value.length) parts.push(from ? value.slice(from) : value);
      }
      if (parts.length) yield parts.join('');
    } finally { try { await reader.cancel(); } catch (e) { /* already finished */ } }
  }
  // What a restore does, in the confirmation: exactly what happens to assessments, settings and your own part numbers.
  function restoreQuestion(n, at, withSettings) {
    return `Restore ${n} assessment${n === 1 ? '' : 's'} from this backup${stampOk(at) ? ` (made ${fmtWhen(at)})` : ''}?\n\n`
      + '• Assessments: each one in the backup replaces the assessment here with the same ID. Assessments that are only on this computer are kept.\n'
      + (withSettings ? "• Settings: replaced by the backup's settings (company details and logo, rates and thresholds, AI model, assessor defaults and default signature). Saved API keys and data-connection credentials are not changed.\n" : '• Settings: not changed (the backup has none).\n')
      + "• Your own part numbers: the backup's are added to the ones here. None are removed or replaced.";
  }
  async function restoreSettings(data) {
    // stored as they are and read again, so the current defaults fill anything an older version did not write (e.g. the AI model)
    await withTimeout(Promise.resolve(C.Store.set('settings', data)), SAVE_TIMEOUT, 'storage did not respond within 20 seconds');
    await C.loadSettings();
    settingsPending = false; failed.delete('settings');
  }
  async function restoreOem(list) { const m = mergeCustomOem(C.customOem, list); await saveCustomOem(m.list); return m.added; }
  // One assessment from a backup: 'ok', 'bad' (unreadable), or the storage error that stops the restore.
  async function restoreJob(j) {
    if (!isObj(j)) return 'bad';
    try { if (typeof j.id !== 'string' || !j.id) j.id = C.uid(); migrate(j); } catch (e) { return 'bad'; }
    try { await withTimeout(C.Store.saveJob(j, { overwrite: true }), SAVE_TIMEOUT, 'storage did not respond within 20 seconds'); } catch (err) { return err; }
    forgetJob(j.id); // a copy loaded earlier is out of date now
    return 'ok';
  }
  const restoreSummary = (n, bad, added) => `${n} restored, ${bad} unreadable${added ? `; ${added} of your own part number${added === 1 ? '' : 's'} added` : ''}`;
  function restoreDone(msg, stopped, incomplete, bad) {
    if (stopped) toast(`The restore stopped: ${msg}. Storage is full or unavailable — ${reasonOf(stopped)}. Free disk space, then restore again.`, true);
    else if (incomplete) toast(`The backup file is incomplete: ${msg}. It may have been cut short when it was saved or copied; restore an earlier complete backup if you have one.`, true);
    else toast(`Backup restored: ${msg}.`, bad > 0);
    showBanners();
    if (/^#\/settings/.test(location.hash)) renderSettings();
  }
  async function restoreBackup() {
    const f = await pickFile('.ersbackup,.json'); if (!f) return;
    const lines = readLines(f);
    let first = '';
    try { const r = await lines.next(); first = r.done ? '' : r.value; } catch (err) { return toast('That file could not be read: ' + errText(err), true); }
    let head = null;
    try { head = JSON.parse(first); } catch (e) { /* not JSON on one line: an older backup written over several lines, or not a backup */ }
    if (isObj(head) && head.kind === BACKUP_KIND && head.format === 2) return restoreV2(head, lines);
    try { await lines.return(); } catch (e) { /* reading stopped */ }
    if (isObj(head) && head.kind === BACKUP_KIND && num(head.format) > 2) return toast('This backup was made by a newer version of the app. Update the app, then restore it.', true);
    let d = isObj(head) && head.kind === BACKUP_KIND ? head : null; // format 1 written on one line
    if (!d) {
      if (f.size > V1_MAX) return toast('That is not a backup file.', true);
      try { d = JSON.parse(await f.text()); } catch (err) { d = null; }
    }
    if (!isObj(d) || d.kind !== BACKUP_KIND) return toast('That is not a backup file.', true);
    return restoreV1(d);
  }
  async function restoreV2(head, lines) {
    if (!confirm(restoreQuestion(num(head.jobs), head.at, true))) { try { await lines.return(); } catch (e) { /* reading stopped */ } return; }
    let n = 0, bad = 0, seen = 0, added = 0, end = null, stopped = null;
    try {
      for await (const raw of lines) {
        if (!raw.trim()) continue;
        let rec = null;
        try { rec = JSON.parse(raw); } catch (e) { /* an unreadable line */ }
        if (!isObj(rec)) { bad++; continue; }
        if (rec.type === 'end') { end = rec; break; }
        if (rec.type === 'settings') { if (isObj(rec.data)) await restoreSettings(rec.data); else bad++; continue; }
        if (rec.type === 'customOem') { if (Array.isArray(rec.data)) added += await restoreOem(rec.data); else bad++; continue; }
        if (rec.type !== 'job') { bad++; continue; }
        seen++;
        progress(`Restoring ${seen} of ${num(head.jobs)}…`);
        const r = await restoreJob(rec.data);
        if (r === 'ok') n++; else if (r === 'bad') bad++; else { stopped = r; break; }
      }
    } catch (err) { stopped = err; } finally { progress(''); }
    restoreDone(restoreSummary(n, bad, added), stopped, !end || num(end.jobs) !== seen, bad);
  }
  async function restoreV1(d) {
    const jobs = Array.isArray(d.jobs) ? d.jobs : [];
    if (!confirm(restoreQuestion(jobs.length, d.at, isObj(d.settings)))) return;
    let n = 0, bad = 0, added = 0, stopped = null;
    try {
      // settings first, so restored assessments without rates of their own take the restored ones
      if (isObj(d.settings)) await restoreSettings(d.settings);
      if (Array.isArray(d.customOem)) added = await restoreOem(d.customOem);
      for (let k = 0; k < jobs.length; k++) {
        progress(`Restoring ${k + 1} of ${jobs.length}…`);
        const r = await restoreJob(jobs[k]);
        if (r === 'ok') n++; else if (r === 'bad') bad++; else { stopped = r; break; }
      }
    } catch (err) { stopped = err; } finally { progress(''); }
    restoreDone(restoreSummary(n, bad, added), stopped, false, bad);
  }

  // A starting list for "Material relied on" (CPR 35, PD 35 para 3.2(2)) from what this assessment used; the assessor edits it.
  function materialsSuggestion(j) {
    const out = [];
    const guides = [...new Set((j.valuation.sources || []).filter((s) => isObj(s) && String(s.name || '').trim() && num(s.amount) > 0).map((s) => String(s.name).trim()))];
    if (guides.length) out.push(`Valuation guides: ${guides.join(', ')}.`);
    const ads = (j.valuation.adverts || []).filter((a) => isObj(a) && (a.description || a.price));
    if (ads.length) out.push(`${ads.length} advertisement${ads.length === 1 ? '' : 's'} for comparable vehicles, listed in the valuation section.`);
    const log = (j.aiLog || []).filter(isObj);
    if (log.some((a) => !a.ai && /DVLA/i.test(a.action))) out.push('DVLA Vehicle Enquiry Service record for the vehicle.');
    if (log.some((a) => !a.ai && /MOT/i.test(a.action)) || (j.vehicle.motHistory || []).length) out.push('DVSA MOT History record (test dates, results and recorded mileages).');
    if (String(j.inspection.diagnostic || '').trim()) out.push('Diagnostic scan results, as recorded in the inspection section.');
    if (j.lines.length) out.push("Repair times: this software's own guide labour times, adjusted by the assessor where stated (not manufacturer or Thatcham times unless a line says so); part prices as listed in the estimate.");
    if (j.outcome.category) out.push('ABI Code of Practice for the Categorisation of Motor Vehicle Salvage.');
    const shown = j.photos.filter((p) => isObj(p) && !p.exclude).length;
    if (shown) out.push(`${shown} photograph${shown === 1 ? '' : 's'} of the vehicle, reproduced in this report.`);
    if (log.some((a) => a.ai)) out.push('AI-assisted analysis, as described in the "Use of AI and data tools" statement.');
    return out.join('\n');
  }

  // ---------- events ----------
  function afterRender() {
    if (tab === 'photos' && job) {
      const drop = $('#drop'), inp = $('#photoInput');
      if (drop) {
        drop.onclick = () => inp.click();
        inp.onchange = () => addPhotos(inp.files);
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
        drop.ondragleave = () => drop.classList.remove('over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addPhotos(e.dataTransfer.files); };
      }
      ensureThumbs(job).catch(() => { /* the full image stays on the card */ });
    }
    if (tab === 'report' && job) {
      const f = $('#preview');
      if (f) { try { f.srcdoc = Report.render(job, { mode: 'preview' }); } catch (err) { f.srcdoc = `<p style="font:14px sans-serif;padding:20px;color:#c0392b">The report preview could not be built: ${esc(err.message || err)}</p>`; } }
    }
  }

  main.addEventListener('input', (e) => {
    const t = e.target;
    if (job && job.issued && t.closest('#tabBody')) return; // a finalised report is read-only (its inputs are disabled anyway)
    if (t.dataset.bind && job) {
      const path = t.dataset.bind;
      setPath(job, path, t.type === 'number' ? (t.value === '' ? '' : num(t.value)) : t.value);
      if (path === 'vehicle.firstReg') { job.vehicle.firstRegPrecision = t.value ? 'day' : ''; const h = t.parentElement.querySelector('.hint'); if (h) h.textContent = ''; }
      const ah = t.parentElement.querySelector('.aiTextHint'); if (ah && !(isObj(job.aiText) && sameText(job.aiText[path], t.value))) ah.remove(); // edited: no longer AI text
      changed(); // also refreshes the totals, labour values and valuation hints shown beside the field (discount, rates, PAV, salvage)
      if (path === 'vehicle.vin') {
        const h = t.parentElement.querySelector('.hint'); if (h) h.innerHTML = vinHint(C.decodeVin(t.value));
        const mb = $('[data-act="motByVin"]'); if (mb && !busy('motvin')) mb.disabled = !(desktop && t.value.trim());
      }
      return;
    }
    if (t.dataset.sbind) {
      const bad = t.dataset.sbind === 'berThresholdPct' && !(num(t.value) > 0);
      setPath(C.settings, t.dataset.sbind, bad ? C.DEFAULT_SETTINGS.berThresholdPct : t.type === 'number' ? num(t.value) : t.value);
      settingsPending = true; saveSettingsSoon();
      return;
    }
    if (t.dataset.pf && job) {
      const p = job.photos.find((x) => String(x.id) === t.dataset.pid); if (!p) return;
      if (t.dataset.pf === 'include') { p.exclude = !t.checked; refreshPhotoNumbers(); }
      else if (t.dataset.pf === 'takenAt') { const d = t.value ? new Date(t.value) : null; p.takenAt = d && !isNaN(d) ? d.toISOString() : ''; }
      else p[t.dataset.pf] = t.value;
      changed(); return;
    }
    if (t.dataset.lf && job) {
      const l = job.lines.find((x) => x.id === t.dataset.id); if (!l) return;
      const f = t.dataset.lf;
      if (f === 'reviewed') l.reviewed = t.checked;
      else if (['hours', 'amount'].includes(f)) l[f] = num(t.value);
      else if (f === 'rate') l.rate = t.value === '' ? '' : num(t.value);
      else l[f] = t.value;
      changed(); // updates this line's labour value and the totals
      if (f === 'reviewed' || f === 'type') renderJob();
      return;
    }
    if (t.dataset.adv && job) {
      const a = job.valuation.adverts[+t.dataset.i]; if (!isObj(a)) return;
      a[t.dataset.adv] = ['mileage', 'price'].includes(t.dataset.adv) ? (t.value === '' ? '' : num(t.value)) : t.value;
      changed(); return;
    }
    if (t.dataset.vs && job) {
      const s = job.valuation.sources[+t.dataset.i]; if (!isObj(s)) return;
      s[t.dataset.vs] = t.dataset.vs === 'amount' ? (t.value === '' ? '' : num(t.value)) : t.value;
      changed(); return;
    }
    if (t.id === 'pickQ') { ui.pickQ = t.value; ui.zoneGroups = null; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'catQ') { ui.catQ = t.value; const pos = t.selectionStart; renderCatalogue(); const n = $('#catQ'); n.focus(); n.setSelectionRange(pos, pos); return; }
  });
  main.addEventListener('change', (e) => {
    const t = e.target;
    if (job && job.issued && t.closest('#tabBody') && !t.dataset.vp) return; // a finalised report is read-only
    if (t.dataset.bindCheck && job) { setPath(job, t.dataset.bindCheck, t.checked); changed(); renderJob(); return; }
    // "Verified" on an advert the AI found: the assessor has checked it, so it is no longer reported as unverified
    if (t.dataset.advVerify != null && job) {
      const a = job.valuation.adverts[+t.dataset.advVerify];
      if (isObj(a) && t.checked) { delete a.aiUnverified; changed(); renderJob(); toast('Advert marked as verified by you.'); }
      return;
    }
    // auto-fill on one of your own part numbers
    if (t.dataset.oemAf != null) {
      const list = C.clone(C.customOem), c = userOemAt(list, t.dataset.vk, t.dataset.pk, +t.dataset.n);
      if (!c) { renderCatalogue(); return; }
      c.autoFill = t.checked;
      saveCustomOem(list).then(() => toast(t.checked ? `${c.oem} will fill new estimate lines for this part.` : `${c.oem} will no longer fill estimate lines by itself.`))
        .catch((err) => { toast('The change could not be saved: ' + errText(err), true); renderCatalogue(); });
      return;
    }
    if (t.dataset.vp && job) {
      ui.vp = ui.vp || {};
      ui.vp[t.dataset.vp] = t.value;
      if (t.dataset.vp === 'make') { ui.vp.model = ''; ui.vp.engine = ''; ui.vp.trim = ''; ui.vp.body = ''; ui.vp.trans = ''; }
      if (t.dataset.vp === 'model') { ui.vp.engine = ''; ui.vp.trim = ''; ui.vp.body = ''; ui.vp.trans = ''; }
      renderJob(); return;
    }
    if (t.dataset.sbind === 'berThresholdPct' && !(num(t.value) > 0)) {
      t.value = C.DEFAULT_SETTINGS.berThresholdPct;
      return toast(`The economic repair threshold must be above 0%, so it has been reset to ${C.DEFAULT_SETTINGS.berThresholdPct}%.`, true);
    }
    if (t.id === 'valSearch') { ui.valSearch = t.checked; return; }
    if (t.id === 'pickGroup') { ui.pickGroup = t.value; ui.zoneGroups = null; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'pickSide') { ui.pickSide = t.value; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'pickOp') { ui.pickOp = t.value; return; }
    if (t.id === 'addRefinish') { ui.addRefinish = t.checked; return; }
    if (t.id === 'catVeh') { ui.catVeh = t.value; renderCatalogue(); return; }
    if (t.dataset.sugg != null) { ui.suggestSel[+t.dataset.sugg] = t.checked; return; }
    if (t.dataset.act === 'suggAll') { $$('input[data-sugg]').forEach((c) => { if (!c.disabled) { c.checked = t.checked; ui.suggestSel[+c.dataset.sugg] = t.checked; } }); return; }
    if (t.dataset.bind && job && (t.tagName === 'SELECT' || t.type === 'date')) {
      if (['vehicle.oemKey', 'outcome.decision', 'outcome.category', 'vehicle.sizeClass', 'vehicle.paintType', 'valuation.claimType'].includes(t.dataset.bind)) renderJob();
    }
  });
  const saveSettingsSoon = C.debounce(() => { settingsPending = false; saveSettingsNow(); }, 400);

  // A label's identity when comparing the labels a photo had when the editor opened with those it has when the editor is saved.
  const labelKey = (l) => (isObj(l) ? JSON.stringify([l.x, l.y, l.w, l.h, String(l.text == null ? '' : l.text), !!l.ai, l.code || '', l.side || '']) : '');
  const inFlight = new Set(); // async actions still running, by action and target: a double click never runs one twice
  const ACT_GROUP = { backup: 'data', restore: 'data' }; // a backup and a restore never run together
  main.addEventListener('click', async (e) => {
    const zone = e.target.closest('[data-zone]');
    if (zone && job) {
      if (job.issued) return toast(LOCKED, true);
      const z = zone.dataset.zone;
      job.zones = job.zones.includes(z) ? job.zones.filter((x) => x !== z) : job.zones.concat(z);
      changed(); renderJob(); return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (job && job.issued && el.closest('#tabBody') && !LOCK_FREE.has(a)) { e.preventDefault(); return toast(LOCKED, true); }
    const A = {
      loadSample: async () => { const j = Sample.sampleJob(); migrate(j); await C.Store.saveJob(j); remember(j); location.hash = `#/job/${j.id}/report`; toast('Sample job loaded. Its personal details are anonymised.'); },
      importJob: async () => {
        const f = await pickFile('.json,application/json'); if (!f) return;
        let j;
        try { j = JSON.parse(await f.text()); if (!isObj(j) || !isObj(j.vehicle) || !Array.isArray(j.lines)) throw new Error(); j.id = C.uid(); delete j.rev; migrate(j); } catch (err) { return toast('That file is not a job file.', true); }
        await C.Store.saveJob(j, { overwrite: true }); // saved in the current shape, so the Jobs list can always read it
        remember(j);
        location.hash = `#/job/${j.id}/claim`;
      },
      // A copy is a new, unsigned draft: the original's signature, dates, status, version, finalised snapshot and AI / data-use log
      // stay with the original (the copy notes where it came from).
      dupJob: async () => {
        const mem = loaded.get(el.dataset.id);
        const src = (mem && mem.job) || await C.Store.getJob(el.dataset.id); if (!src) return renderJobs();
        const j = C.clone(src); migrate(j);
        const from = j.report.ref || j.vehicle.reg || 'the original assessment';
        j.id = C.uid(); j.report.ref = (j.report.ref || '') + '-COPY'; j.createdAt = new Date().toISOString();
        ['issued', 'rev', 'aiDraftPending'].forEach((k) => { delete j[k]; });
        j.assessor.signature = ''; j.assessor.dateSigned = '';
        j.report.status = 'Draft'; j.report.date = today(); j.report.version = '1.0';
        j.aiLog = [];
        j.copiedFrom = { id: src.id, ref: from, at: new Date().toISOString() };
        await C.Store.saveJob(j); renderJobs(); toast(`Copy made: ${j.report.ref || 'new draft'} (unsigned, version 1.0).`);
      },
      delJob: async () => { if (!confirm('Delete this assessment permanently?')) return; await C.Store.deleteJob(el.dataset.id); forgetJob(el.dataset.id); showBanners(); renderJobs(); },
      genRef: () => { const r = (job.vehicle.reg || 'REG').replace(/\s/g, '').toUpperCase(); const d = (job.report.date || today()).split('-'); job.report.ref = `${(C.settings.company.name || 'ER').replace(/[^A-Z]/gi, '').slice(0, 2).toUpperCase()}-${r}-${d[2]}${d[1]}${d[0].slice(2)}`; changed(); renderJob(); },
      useOem: () => { job.vehicle.oemKey = el.dataset.key; changed(); renderJob(); },
      // The editor works on a copy. On save, AI labels that a photo analysis added while it was open are kept (and the photo is
      // then not "reviewed"); the AI labels that analysis replaced are dropped from the copy.
      label: () => {
        const j = job, ph = j.photos.find((p) => String(p.id) === el.dataset.pid); if (!ph) return;
        const before = new Set((ph.labels || []).map(labelKey));
        let arrived = 0;
        Labeler.open(ph, (labels, origins) => applyToJob(j, (x) => {
          const p = x.photos.find((q) => q.id === ph.id); if (!p) return;
          const cur = Array.isArray(p.labels) ? p.labels : [];
          const curKeys = new Set(cur.map(labelKey));
          const kept = labels.filter((l, k) => { const o = origins && origins[k]; return !(o && o.ai && !curKeys.has(labelKey(o))); });
          const added = cur.filter((l) => !before.has(labelKey(l)));
          arrived = added.filter((l) => l && l.ai).length;
          p.labels = kept.concat(added);
          p.labelsReviewed = !arrived;
        }).then((target) => {
          if (!target) toast(`${regOf(j)} has been deleted, so the labels were not saved.`, true);
          else if (arrived) toast(`${arrived} new AI label${arrived === 1 ? '' : 's'} arrived for this photo while you were editing. ${arrived === 1 ? 'It was' : 'They were'} kept: open the labels again to review ${arrived === 1 ? 'it' : 'them'}.`);
        }).catch((err) => toast(errText(err), true)), openModal, closeModal);
      },
      // a photo is moved or removed in place: only its card changes, the grid is not rebuilt
      pmove: () => {
        const i = job.photos.findIndex((p) => String(p.id) === el.dataset.pid), d = +el.dataset.d, k = i + d;
        if (i < 0 || k < 0 || k >= job.photos.length) return;
        const [p] = job.photos.splice(i, 1); job.photos.splice(k, 0, p);
        const card = el.closest('.pcard'), other = card && (d < 0 ? card.previousElementSibling : card.nextElementSibling);
        if (card && other) { if (d < 0) other.before(card); else other.after(card); refreshPhotoNumbers(); } else renderJob();
        changed();
      },
      pdel: () => {
        if (!confirm('Remove this photo?')) return;
        const i = job.photos.findIndex((p) => String(p.id) === el.dataset.pid); if (i < 0) return;
        job.photos.splice(i, 1);
        const card = el.closest('.pcard');
        if (card) { card.remove(); refreshPhotoNumbers(); paintTabCounts(); } else renderJob();
        changed();
      },
      aiAnalyseRest: () => aiAnalyse({ remaining: true }),
      aiAnalyse, aiApplySummary, aiAddLines, aiDraft,
      zoneDel: () => { job.zones = job.zones.filter((x) => x !== el.dataset.z); changed(); renderJob(); },
      zonePick: () => { const z = Diagram.byLabel(el.dataset.z); ui.zoneGroups = z ? z.groups : null; ui.zoneLabel = z ? z.label : ''; ui.pickGroup = ''; if (z) ui.pickQ = ''; if (z && z.side) ui.pickSide = z.side; renderJob(); },
      pickSel: () => {
        ui.pickSel = el.dataset.code;
        $$('#pickResults .r').forEach((r) => r.classList.toggle('sel', r.dataset.code === ui.pickSel));
        // operation / service rows default to "Operation / service"; a part never keeps that choice
        const p = C.CAT[ui.pickSel];
        if (p) { const want = isOperationRow(p) ? 'operation' : ui.pickOp === 'operation' ? 'replace' : ui.pickOp; if (want !== ui.pickOp) { ui.pickOp = want; const sel = $('#pickOp'); if (sel) sel.value = want; } }
        if (e.detail === 2) addFromCatalogue();
      },
      pickAdd: addFromCatalogue,
      addOp: () => { const o = C.OPS[el.dataset.code]; const cls = o.type === 'Painting' ? 'paint' : 'parts'; job.lines.push(C.newLine({ type: o.type, description: o.name, hours: o.hours, costClass: cls, op: 'labour' })); changed(); renderJob(); },
      addBlank: () => { job.lines.push(C.newLine({ op: 'manual' })); changed(); renderJob(); },
      lmove: () => { const i = job.lines.findIndex((x) => x.id === el.dataset.id), j2 = i + +el.dataset.d; if (j2 < 0 || j2 >= job.lines.length) return; const l = job.lines.splice(i, 1)[0]; job.lines.splice(j2, 0, l); changed(); renderJob(); },
      ldel: () => { job.lines = job.lines.filter((x) => x.id !== el.dataset.id); changed(); renderJob(); },
      oemPick: () => oemPicker(el.dataset.id),
      vsAdd: () => { job.valuation.sources.push({ name: '', amount: '' }); changed(); renderJob(); },
      vsDel: () => { job.valuation.sources.splice(+el.dataset.i, 1); changed(); renderJob(); },
      adopt: () => { const t = C.totals(job); job.valuation.adopted = { max: t.valMax, min: t.valMin, avg: Math.round(t.valAvg) }[el.dataset.w]; changed(); renderJob(); },
      valMileage: () => { job.valuation.mileage = job.vehicle.mileage; changed(); renderJob(); },
      genValComments,
      signToday: () => { job.assessor.dateSigned = today(); changed(); renderJob(); },
      sigDraw: () => { const j = job; signaturePad(async (url) => { if (el.dataset.target === 'default') { C.settings.assessor.signature = url; await C.saveSettings(); renderSettings(); } else await applyToJob(j, (x) => { x.assessor.signature = url; }); }); },
      sigUpload: async () => {
        const j = job; const f = await pickFile('image/*'); if (!f) return;
        let r; try { r = await C.resizeDataURL(await C.readFileAsDataURL(f), 600, 0.92); } catch (e) { return toast(IMAGE_UNREADABLE, true); }
        if (el.dataset.target === 'default') { C.settings.assessor.signature = r.dataUrl; await C.saveSettings(); renderSettings(); } else await applyToJob(j, (x) => { x.assessor.signature = r.dataUrl; });
      },
      sigClear: () => { job.assessor.signature = ''; changed(); renderJob(); },
      exportPdf, exportJson: () => saveText(JSON.stringify(job, null, 1), (job.report.ref || job.vehicle.reg || 'job').replace(/[^\w.-]+/g, '_') + '.json', 'json'),
      logoUpload: async () => {
        const f = await pickFile('image/*'); if (!f) return;
        let url; try { url = await logoDataUrl(f); } catch (e) { url = ''; }
        if (!url) return toast('That image could not be used as a logo. Use a PNG, JPEG, GIF, WebP or SVG file (HEIC photos from an iPhone are not supported: export them as JPG or PNG first).', true);
        C.settings.company.logo = url; await C.saveSettings(); renderSettings();
      },
      logoClear: async () => { C.settings.company.logo = ''; await C.saveSettings(); renderSettings(); },
      // key changes report what the main process says: it can refuse (bad key, unreadable file, settings folder not writable)
      aiSaveKey: async () => {
        const k = $('#aiKey').value.trim(); if (!k) return toast('Paste your API key first.', true);
        const r = await desktop.ai.setKey(k);
        if (!r || !r.ok) return toast((r && r.error) || 'The API key could not be saved.', true);
        toast(protectionOf(r) === 'none' || protectionOf(r) === 'weak' ? 'API key saved, but without proper encryption on this PC (see Settings → AI assessor).' : 'API key saved.', protectionOf(r) === 'none' || protectionOf(r) === 'weak');
        refreshAiState(); renderSettings();
      },
      aiClearKey: async () => {
        const r = await desktop.ai.setKey('');
        if (!r || !r.ok) return toast((r && r.error) || 'The API key could not be removed.', true);
        toast('API key removed.'); refreshAiState(); renderSettings();
      },
      aiTest: async () => {
        el.disabled = true; el.innerHTML = '<span class="spinner" style="border-color:#999;border-top-color:#333"></span>Testing…';
        let r; try { r = await desktop.ai.test({ model: (C.settings.ai || {}).model }); } finally { el.disabled = false; el.textContent = 'Test connection'; }
        if (r && r.ok) toast('Connected: ' + ((r.result && r.result.model) || 'OK')); else toast((r && r.error) || 'The AI connection test failed.', true);
      },
      backup: backupAll,
      restore: restoreBackup,
      catAddNo, catAddVeh, catImport,
      oemEdit: () => {
        const c = userOemAt(C.customOem, el.dataset.vk, el.dataset.pk, +el.dataset.n);
        if (!c) return renderCatalogue();
        oemForm({ vk: el.dataset.vk, pk: el.dataset.pk, n: +el.dataset.n, c });
      },
      oemDel: async () => {
        const list = C.clone(C.customOem), c = userOemAt(list, el.dataset.vk, el.dataset.pk, +el.dataset.n);
        if (!c) return renderCatalogue();
        if (!confirm(`Delete your part number ${c.oem}? Estimate lines that already use it keep it.`)) return;
        removeUserOem(list, el.dataset.vk, el.dataset.pk, +el.dataset.n);
        await saveCustomOem(list); renderCatalogue(); toast('Part number deleted.');
      },
      discardDraft: async () => {
        if (!confirm('Discard the AI draft that is waiting for review? It cannot be recovered (the AI log keeps the entry).')) return;
        await applyToJob(job, (x) => { delete x.aiDraftPending; }); toast('AI draft discarded.');
      },
      aiFlagDismiss: () => { const i = +el.dataset.i; if (Array.isArray(job.aiFlags) && job.aiFlags[i]) { job.aiFlags.splice(i, 1); changed(); renderJob(); } },
      aiFlagDismissAll: () => { if (!confirm('Dismiss every AI "check before signing" point? Only do this once you have dealt with them.')) return; job.aiFlags = []; changed(); renderJob(); },
      suggestMaterials: () => {
        const s = materialsSuggestion(job);
        if (String(job.report.materialsRelied || '').trim() && !confirm('Replace the current "material relied on" text with a list made from this assessment?')) return;
        job.report.materialsRelied = s; changed(); renderJob(); toast('Suggested from this assessment: check it and add anything else you relied on.');
      },
      bootRetry: () => location.reload(),
      lookupVehicle, motByVin, applyVariant, paintMaterials, aiValuation,
      advAdd: () => { (job.valuation.adverts = job.valuation.adverts || []).push({ description: '', year: '', mileage: '', price: '', url: '' }); changed(); renderJob(); },
      advDel: () => { job.valuation.adverts.splice(+el.dataset.i, 1); changed(); renderJob(); },
      advFromAi: () => {
        const c = (((job.valuation.ai || {}).comparables) || [])[+el.dataset.i]; if (!isObj(c)) return;
        const ok = verifiedComparable(c);
        // an unverified comparable is added only after confirmation, and WITHOUT its link: a link stored as one of the engineer's
        // adverts would count as verified the next time the AI runs
        if (!ok && !confirm(`"${c.description || 'This comparable'}" could not be matched to the AI's web search results or your own adverts, so the advert may not exist at this price.\n\nAdd it to the adverts anyway? It is added without a link: check the advert and enter its URL yourself.`)) return;
        const claimed = String(c.claimed_url || c.url || '').trim();
        (job.valuation.adverts = job.valuation.adverts || []).push(Object.assign({ description: c.description, year: c.year, mileage: c.mileage, price: c.price, url: ok ? c.url : '', source: c.source }, ok ? {} : { aiUnverified: true, claimedUrl: claimed }));
        changed(); renderJob(); toast(ok ? 'Added to adverts.' : 'Added to adverts without a link. Check the advert before relying on it.');
      },
      inspByAssessor: () => { job.inspection.by = job.assessor.name; if (!job.inspection.byQualifications) job.inspection.byQualifications = job.assessor.qualifications || C.settings.assessor.qualifications || ''; changed(); renderJob(); },
      useSettingsRates: () => {
        if (job.issued && !confirm('This report has been finalised. Taking the current Settings rates changes its figures. Continue?')) return;
        job.rates = C.clone(C.settings.rates); job.vatPct = C.settings.vatPct; changed(); renderJob(); toast('Labour rates and VAT updated from Settings.');
      },
      // Finalising locks the report and freezes what Settings would otherwise change in it, including the labour rates and VAT
      finaliseReport: () => {
        if (callRunning(job.id)) return toast('A lookup or AI call is still running for this assessment. Finalise it once that has finished.', true);
        const errs = C.qaChecks(job).filter((q) => q.level === 'error').length;
        if (!confirm(`${errs ? `The pre-issue checks still show ${errs} error${errs === 1 ? '' : 's'}.\n\n` : ''}Finalise this report? It is locked for editing, and the company details, declaration, signature, qualifications, AQP ID, labour rates and VAT are frozen in it as they are now. You can re-open it to edit.`)) return;
        const S = C.settings, a = job.assessor;
        // the labour rate for every standard type and every line type in use, and the VAT %: totals() then uses these
        const snap = C.rateSnapshot(job);
        job.issued = Object.assign({ at: new Date().toISOString(), company: C.clone(S.company), declaration: S.assessor.declaration, signature: liveSignature(job), qualifications: a.qualifications || S.assessor.qualifications || '', aqpId: a.aqpId || S.assessor.aqpId || '' }, snap);
        changed(); renderJob(); toast('Report finalised and locked.');
      },
      reopenReport: () => {
        if (!confirm('Re-open this report for editing? Until it is finalised again it uses the current Settings (company details, declaration and signature), and its figures can be changed.')) return;
        delete job.issued; changed(); renderJob(); toast('Report re-opened for editing.');
      },
      reviewPendingDraft: () => { const d = job.aiDraftPending; if (isObj(d) && isObj(d.draft)) reviewDraft(d.draft, job.id); },
      aiValApply: () => {
        const r = job.valuation.ai; if (!r) return;
        job.valuation.adopted = Math.round(num(r.recommended_pav));
        if (r.comments) { job.valuation.comments = r.comments; aiTextOf(job)['valuation.comments'] = String(r.comments); } // AI text until the assessor edits it
        changed(); renderJob(); toast('PAV and comments applied. Edit as needed.');
      },
      saveDvla: async () => {
        const k = $('#kDvla').value.trim(); if (!k) return toast('Paste the DVLA key first.', true);
        const r = await desktop.data.setKeys({ dvla: k });
        if (!r || !r.ok) return toast((r && r.error) || 'The DVLA key could not be saved.', true);
        toast('DVLA key saved.'); renderSettings();
      },
      clearDvla: async () => {
        if (!confirm('Remove the saved DVLA key?')) return;
        const r = await desktop.data.setKeys({ dvla: null });
        if (!r || !r.ok) return toast((r && r.error) || 'The DVLA key could not be removed.', true);
        toast('DVLA key removed.'); renderSettings();
      },
      // the way out when the saved credentials file cannot be read: remove everything, then enter the credentials again
      clearAllData: async () => {
        if (!confirm('Remove ALL saved DVLA and MOT History credentials from this PC? You will need to enter them again.')) return;
        const r = await desktop.data.clearKeys();
        if (!r || !r.ok) return toast((r && r.error) || 'The saved credentials could not be removed.', true);
        toast('All saved data-connection credentials were removed. Enter them again to use the lookups.'); renderSettings();
      },
      recheckData: () => renderSettings(),
      saveMot: async () => {
        const tok = $('#kMotTokenUrl').value.trim();
        const patch = { motClientId: $('#kMotId').value.trim(), motClientSecret: $('#kMotSecret').value.trim(), motApiKey: $('#kMotKey').value.trim(), motScope: $('#kMotScope').value.trim() };
        if (tok) { if (/^https:\/\//i.test(tok)) patch.motTokenUrl = tok; else patch.motTenantId = tok; }
        Object.keys(patch).forEach((k) => { if (!patch[k]) delete patch[k]; });
        if (!Object.keys(patch).length) return toast('Enter the MOT credentials first.', true);
        if (patch.motTokenUrl && !/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/i.test(patch.motTokenUrl)) return toast('The token URL should look like https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token (copy it from the DVSA email).', true);
        const r = await desktop.data.setKeys(patch);
        if (!r || !r.ok) return toast((r && r.error) || 'The MOT History credentials could not be saved.', true);
        toast('MOT History credentials saved.'); renderSettings();
      },
      clearMot: async () => {
        if (!confirm('Remove the saved MOT History credentials?')) return;
        const r = await desktop.data.setKeys({ motClientId: null, motClientSecret: null, motApiKey: null, motTokenUrl: null, motTenantId: null, motScope: null });
        if (!r || !r.ok) return toast((r && r.error) || 'The MOT History credentials could not be removed.', true);
        toast('MOT History credentials removed.'); renderSettings();
      },
      testDvla: async () => { const reg = $('#testReg').value.trim(); if (!reg) return toast('Enter a registration to test with.', true); const r = await desktop.data.dvla(reg, C.settings.dvlaEnv || 'live'); r.ok ? toast(`DVLA OK: ${r.result.make} ${r.result.colour} ${r.result.fuelType}${r.result.firstRegistration ? ', first registered ' + C.ukDate(r.result.firstRegistration) : ''}`) : toast(r.error, true); },
      testMot: async () => { const reg = $('#testReg').value.trim(); if (!reg) return toast('Enter a registration to test with.', true); const r = await desktop.data.mot(reg, 'registration'); r.ok ? toast(`MOT History OK: ${r.result.make} ${r.result.model}, ${r.result.tests.length} test(s)${r.result.tests[0] && r.result.tests[0].odometer ? ', latest ' + r.result.tests[0].odometer.toLocaleString('en-GB') + ' ' + r.result.tests[0].unit : ''}`) : toast(r.error, true); },
    };
    if (!A[a]) return;
    e.preventDefault();
    // an action that runs asynchronously is marked busy until it settles: a double click (or a second click meanwhile) on the same
    // action and target is ignored, so it never shows two save dialogs or makes two copies
    const key = (ACT_GROUP[a] || a) + '|' + (el.dataset.id || el.dataset.pid || el.dataset.i || el.dataset.vk || el.dataset.target || '');
    if (inFlight.has(key)) return;
    let r;
    try { r = A[a](); } catch (err) { return toast(errText(err), true); }
    if (!r || typeof r.then !== 'function') return;
    inFlight.add(key); el.classList.add('isBusy'); el.setAttribute('aria-busy', 'true');
    try { await r; } catch (err) { toast(errText(err), true); } finally { inFlight.delete(key); el.classList.remove('isBusy'); el.removeAttribute('aria-busy'); }
  });

  async function refreshAiState() {
    if (desktop) aiStatus = await readStatus(() => desktop.ai.status());
    paintAiState();
  }
  // Sidebar AI state. An error from the main process (the parts catalogue or the AI module could not be loaded, or the saved key
  // file cannot be read) is shown here as well as in Settings.
  function paintAiState() {
    const el = $('#aiState'); if (!el) return;
    if (!desktop) { el.innerHTML = '<span class="dot"></span>AI: desktop app only'; return; }
    const err = statusError(aiStatus);
    el.innerHTML = err
      ? `<span class="dot" style="background:var(--err)"></span>AI assessor unavailable<div class="aiErr" title="${esc(err)}" style="margin-top:4px;font-size:11px;line-height:1.35;opacity:.85;white-space:normal">${esc(err.length > 160 ? err.slice(0, 157) + '…' : err)} <a href="#/settings" style="color:#fff">Settings</a></div>`
      : `<span class="dot ${aiStatus.hasKey ? 'on' : 'off'}"></span>AI assessor ${aiStatus.hasKey ? 'ready' : '— add your key in Settings → AI assessor'}`;
  }

  // ---------- boot ----------
  // Storage that cannot be opened (a locked or damaged database, a full disk, site data blocked in a browser) gets an error card
  // with Retry and, in the desktop app, the data folder, instead of an empty window.
  async function bootFailed(err) {
    const info = await readAppInfo();
    const name = err && err.name;
    // an older copy of the app still open elsewhere blocks the upgrade; data written by a newer version cannot be read here
    const what = name === 'BlockedError'
      ? ['Close the other window or tab first', 'An older version of this app has the saved assessments open in another window or browser tab, so their storage cannot be brought up to date. Close that window or tab, then click Retry.']
      : name === 'VersionError'
        ? ['This copy of the app is older than your data', 'The saved assessments were written by a newer version of Engineer Report Studio, so this older copy cannot open them. Install the latest version and open them with that. Nothing has been changed.']
        : ['Your saved assessments cannot be opened', 'Nothing has been deleted. This usually means that another copy of the app (or a browser tab with it) still has the data open, that antivirus or backup software is locking the files, that the disk is full, or, in a browser, that site data is blocked. Close other copies, free some disk space, then click Retry.'];
    main.innerHTML = `<div class="wrap"><div class="card errBox bootErr" role="alert" style="border-color:#f0b5ad;background:#fff6f5;max-width:780px">
      <h2 style="margin-top:0;color:var(--err)">${esc(what[0])}</h2>
      <p>The app's storage could not be opened: <b>${esc(errText(err, 'unknown error'))}</b></p>
      <p class="hint">${esc(what[1])}</p>
      ${info ? `<p class="hint">The data is kept in <code class="dataFolder">${esc(info.dataFolder)}</code>. Copy that folder somewhere safe before trying anything else.</p>` : ''}
      <div class="row"><button class="btn primary" data-act="bootRetry">Retry</button></div></div></div>`;
  }
  (async function boot() {
    try {
      await C.loadSettings();
      await loadCustomOem();
    } catch (err) { bootFailed(err); return; }
    refreshAiState();
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', () => { flushSave(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
    if (!location.hash) location.hash = '#/jobs';
    route();
  })();
})();
