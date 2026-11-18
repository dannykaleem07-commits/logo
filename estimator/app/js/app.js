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
  const pendingDrafts = new Map(); // jobId → AI narrative draft waiting for review
  const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  const httpUrl = (u) => /^https?:\/\//i.test(String(u || '').trim());
  // OEM candidates: only the first one marked for auto-fill may pre-fill a line; line amounts always use the EX-VAT price
  const autoOem = (cands) => (cands || []).find((c) => c && c.autoFill !== false) || null;
  const oemPrice = (c, short) => (!c ? '' : c.price ? (short || !c.priceIncVat ? `${gbp(c.price)} ex VAT` : `${gbp(c.price)} ex VAT (${gbp(c.priceIncVat)} inc VAT)`) : c.priceIncVat ? `${gbp(c.priceIncVat)} inc VAT` : '');
  const MARKETS = { US: 'US listing', 'EU-LHD': 'LHD listing', unknown: 'market unknown' };
  const oemBadges = (c) => [c.role === 'variant' ? 'variant' : '', c.autoFill === false ? 'choose by VIN' : '', !c.user && MARKETS[c.market] ? MARKETS[c.market] : '']
    .filter(Boolean).map((b) => `<span class="badge warn">${b}</span>`).join(' ');
  const chooseByVin = (n) => `${n} researched number${n === 1 ? '' : 's'}: choose the variant by VIN`;

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
  function freshModalBody() { const old = $('#modalBody'); const b = old.cloneNode(false); old.replaceWith(b); return b; }
  function openModal(title, content) {
    $('#modalTitle').textContent = title;
    const b = freshModalBody();
    if (typeof content === 'string') b.innerHTML = content; else b.appendChild(content);
    $('#modal').classList.remove('hidden');
    return b;
  }
  function closeModal() { $('#modal').classList.add('hidden'); freshModalBody(); }
  // the backdrop closes the modal only when the press also started on it (not a drag that ends outside the card)
  let pressOnBackdrop = false;
  $('#modal').addEventListener('pointerdown', (e) => { pressOnBackdrop = e.target.id === 'modal'; });
  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || (e.target.id === 'modal' && pressOnBackdrop)) closeModal();
    pressOnBackdrop = false;
  });

  // ---------- saving ----------
  // changed() remembers WHICH job has unsaved edits, so leaving it within the debounce cannot lose them.
  let pendingSave = null;
  let settingsPending = false;
  async function flushSave() {
    if (settingsPending) { settingsPending = false; C.saveSettings(); }
    const j = pendingSave;
    if (!j) return;
    pendingSave = null;
    try { await C.Store.saveJob(j); } catch (err) { if (!pendingSave) pendingSave = j; toast('Could not save the assessment: ' + (err.message || err), true); return; }
    if (j === job) { const s = $('#savedState'); if (s) s.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB'); }
  }
  const saveSoon = C.debounce(flushSave, 500);
  function changed() {
    if (!job) return;
    pendingSave = job;
    const s = $('#savedState'); if (s) s.textContent = 'Saving…';
    saveSoon(); updateHeader(); refreshLive();
  }

  // ---------- form helpers ----------
  function F(path, label, o) {
    o = o || {};
    const v = getPath(job, path);
    const val = v == null ? '' : v;
    let input;
    if (o.type === 'textarea') input = `<textarea data-bind="${path}" rows="${o.rows || 4}" placeholder="${esc(o.ph || '')}">${esc(val)}</textarea>`;
    else if (o.type === 'select') input = `<select data-bind="${path}">${o.options.map((x) => { const [k, t] = Array.isArray(x) ? x : [x, x || '—']; return `<option value="${esc(k)}"${String(k) === String(val) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else input = `<input data-bind="${path}" type="${o.type || 'text'}" value="${esc(val)}" placeholder="${esc(o.ph || '')}"${o.list ? ` list="${o.list}"` : ''}${o.step ? ` step="${o.step}"` : ''}>`;
    return `<label class="fld ${o.full ? 'full' : ''}"><span>${esc(label)}</span>${input}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</label>`;
  }
  function S(path, label, o) { // settings field
    o = o || {};
    const v = getPath(C.settings, path);
    const val = v == null ? '' : v;
    let input;
    if (o.type === 'textarea') input = `<textarea data-sbind="${path}" rows="${o.rows || 4}">${esc(val)}</textarea>`;
    else if (o.type === 'select') input = `<select data-sbind="${path}">${o.options.map((x) => { const [k, t] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(k)}"${String(k) === String(val) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else input = `<input data-sbind="${path}" type="${o.type || 'text'}" value="${esc(val)}" ${o.step ? `step="${o.step}"` : ''}>`;
    return `<label class="fld ${o.full ? 'full' : ''}"><span>${esc(label)}</span>${input}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</label>`;
  }

  // ---------- routing ----------
  let routeSeq = 0; // a newer navigation supersedes one still waiting on storage
  async function route() {
    const seq = ++routeSeq;
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    $$('.side nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] === 'job' ? 'jobs' : parts[0] || 'jobs')));
    if (job && !(parts[0] === 'job' && parts[1] === job.id)) closeModal(); // a modal belongs to the job it was opened on
    await flushSave();
    if (seq !== routeSeq) return;
    if (parts[0] === 'new') {
      const j = C.newJob();
      migrate(j);
      await C.Store.saveJob(j);
      if (seq === routeSeq) location.replace(`#/job/${j.id}/claim`); // keep #/new out of the history, so Back does not create another job
      return;
    }
    if (parts[0] === 'job' && parts[1]) {
      try {
        if (!job || job.id !== parts[1]) {
          const j = await C.Store.getJob(parts[1]);
          if (seq !== routeSeq) return;
          if (!j) { job = null; location.replace('#/jobs'); return; }
          if (migrate(j)) await C.Store.saveJob(j);
          if (seq !== routeSeq) return;
          resetJobUi(j.id);
          job = j;
        }
        tab = parts[2] || 'claim';
        renderJob();
      } catch (err) {
        job = null;
        main.innerHTML = `<div class="wrap"><div class="card"><h2 style="margin-top:0">This assessment could not be opened</h2><p class="hint">${esc(err.message || err)}</p><a class="btn" href="#/jobs">← Jobs</a></div></div>`;
        toast('This assessment could not be opened: ' + (err.message || err), true);
      }
      return;
    }
    job = null;
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
    }
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
    return ch;
  }

  // ---------- JOBS LIST ----------
  // One row per stored job. Each row is migrated (in memory only) and rendered on its own, so one bad record shows an error row instead of blanking the list.
  function jobRow(j) {
    try {
      migrate(j);
      const t = C.totals(j);
      const dec = String(j.outcome.decision || '');
      return `<tr>
          <td><a href="#/job/${esc(j.id)}/claim"><span class="plate">${esc(j.vehicle.reg || 'NEW')}</span></a></td>
          <td>${esc([j.vehicle.make, j.vehicle.model, j.vehicle.derivative].filter(Boolean).join(' '))}</td>
          <td>${esc(j.report.ref)}${j.issued ? ' <span class="badge ok">finalised</span>' : ''}</td><td>${esc(j.instruction.instructingParty)}</td><td>${esc(C.ukDate(j.instruction.dateOfLoss))}</td>
          <td>${dec ? `<span class="badge ${/total|ber|beyond/i.test(dec) ? 'err' : 'ok'}">${esc(dec.split('/')[0])}${j.outcome.category ? ' · Cat ' + esc(j.outcome.category) : ''}</span>` : ''}</td>
          <td class="num">${gbp(t.net)}</td><td class="num">${t.pav ? gbp(t.pav) : '—'}</td>
          <td class="hint">${j.updatedAt ? new Date(j.updatedAt).toLocaleString('en-GB') : ''}</td>
          <td class="row" style="flex-wrap:nowrap"><a class="btn sm" href="#/job/${esc(j.id)}/claim">Open</a><button class="btn sm" data-act="dupJob" data-id="${esc(j.id)}">Duplicate</button><button class="btn sm danger" data-act="delJob" data-id="${esc(j.id)}">Delete</button></td></tr>`;
    } catch (err) {
      const reg = isObj(j) && isObj(j.vehicle) ? j.vehicle.reg : '';
      const id = isObj(j) ? esc(j.id) : '';
      return `<tr class="bad"><td><span class="plate">${esc(reg || '?')}</span></td>
          <td colspan="8"><span class="badge err">This record could not be read</span> <span class="hint">${esc(err.message || err)}</span></td>
          <td class="row" style="flex-wrap:nowrap"><a class="btn sm" href="#/job/${id}/claim">Open</a><button class="btn sm danger" data-act="delJob" data-id="${id}">Delete</button></td></tr>`;
    }
  }
  async function renderJobs() {
    const seq = routeSeq;
    let jobs = [];
    try { jobs = await C.Store.listJobs(); } catch (err) { toast('Could not read the saved assessments: ' + (err.message || err), true); }
    if (seq !== routeSeq) return;
    const when = (j) => String((isObj(j) && j.updatedAt) || '');
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
  function renderJob() {
    const counts = { photos: job.photos.length, estimate: job.lines.length, report: C.qaChecks(job).filter((q) => q.level !== 'info').length };
    main.innerHTML = `<div class="jobhead"><div class="top">
        <a href="#/jobs" class="link">← Jobs</a><span class="plate">${esc(job.vehicle.reg || 'NEW')}</span>
        <b id="hdVeh">${esc([job.vehicle.make, job.vehicle.model, job.vehicle.derivative].filter(Boolean).join(' ') || 'New assessment')}</b>
        <span class="saved" id="savedState"></span>
        <div class="chips" id="chips"></div>
      </div>
      <div class="tabs">${TABS.map(([k, t]) => `<a href="#/job/${job.id}/${k}" class="${k === tab ? 'active' : ''}">${t}${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ''}</a>`).join('')}</div></div>
      <div class="wrap" id="tabBody"></div>`;
    updateHeader();
    const body = $('#tabBody');
    const r = { claim: tabClaim, vehicle: tabVehicle, inspection: tabInspection, circumstances: tabCircumstances, photos: tabPhotos, assessment: tabAssessment, estimate: tabEstimate, valuation: tabValuation, opinion: tabOpinion, customer: tabCustomer, signoff: tabSignoff, report: tabReport }[tab] || tabClaim;
    body.innerHTML = r();
    afterRender();
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
      ${F('report.status', 'Report status', { full: true, ph: 'e.g. Final Engineering Assessment — Repair' })}</div></div>
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
      ${dv ? `<div class="hint"><b>DVLA</b>${dv.lookedUpAt ? ' (' + esc(C.ukDate(String(dv.lookedUpAt).slice(0, 10))) + ')' : ''}: tax <b>${esc(dv.taxStatus || '—')}</b>${dv.taxDueDate ? ' (due ' + esc(C.ukDate(dv.taxDueDate)) + ')' : ''} · MOT <b>${esc(dv.motStatus || '—')}</b>${dv.motExpiry ? ' (expires ' + esc(C.ukDate(dv.motExpiry)) + ')' : ''}${dv.euroStatus ? ' · ' + esc(dv.euroStatus) : ''}${dv.co2Emissions !== '' && dv.co2Emissions != null ? ' · CO₂ ' + esc(dv.co2Emissions) + ' g/km' : ''}${dv.wheelPlan ? ' · ' + esc(dv.wheelPlan) : ''}${dv.dateOfLastV5CIssued ? ' · last V5C ' + esc(C.ukDate(dv.dateOfLastV5CIssued)) : ''}
        ${dv.markedForExport ? ' · <b style="color:var(--err)">marked for export</b>' : ''}${dv.markedAsScrapped ? ' · <b style="color:var(--err)">marked as scrapped</b>' : ''}${dv.importedOrReRegistered ? ` · <b style="color:var(--warn)">first registered ${esc(C.ukDate(dv.firstRegistration))} but with DVLA ${esc(C.ukDate(dv.firstRegistrationWithDvla))} (import / re-registration)</b>` : ''}</div>` : ''}
      ${ms ? `<div class="hint"><b>MOT History</b>${ms.lookedUpAt ? ' (' + esc(C.ukDate(String(ms.lookedUpAt).slice(0, 10))) + ')' : ''}: ${esc(ms.make)} ${esc(ms.model)} · ${esc(ms.fuelType)} · ${esc(ms.primaryColour)}${ms.engineSize ? ' · ' + esc(ms.engineSize) + 'cc' : ''} · recall: <b>${esc(ms.recall || 'Unknown')}</b>${ms.motTestDueDate ? ' · first MOT due ' + esc(C.ukDate(ms.motTestDueDate)) : ''}</div>` : ''}
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
  function variantPicker() {
    const V = window.VARIANTS || [];
    if (!V.length) return '';
    const vp = ui.vp || (ui.vp = {});
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
    v.variantKey = [mdl.make, mdl.model, mdl.generation, e && e.badge, tr, b, g].join('|');
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
  // The live object for job j: the open job when it is still open (even if it was reloaded), otherwise the stored copy.
  async function jobFor(j) {
    if (job && job.id === j.id) return job;
    const stored = await C.Store.getJob(j.id);
    if (stored) migrate(stored);
    return stored || null;
  }
  // Apply results to the job they were requested for, even if the user has left it or reopened it meanwhile.
  // Returns the job that was changed, or null if it no longer exists.
  async function applyToJob(j, fn) {
    const cur = await jobFor(j);
    if (!cur) return null;
    fn(cur);
    if (cur === job) { changed(); renderJob(); } else await C.Store.saveJob(cur);
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
    const st = await desktop.data.status();
    if (!st.dvla && !st.mot) return toast('No data connections set up. Add your DVLA key and/or MOT History credentials in Settings → Data connections.', true);
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
      ${!aiReady ? '<p class="hint">AI tools are available in the desktop app (they need your API key in Settings).</p>' : ''}
      <div class="drop" id="drop" style="margin-top:12px">Drop photos here or <b>click to choose</b> (JPG / PNG / HEIC exported as JPG)</div>
      <input type="file" id="photoInput" accept="image/*" multiple hidden>
      <div class="pgrid">${job.photos.map((p, i) => photoCard(p, i, nums.get(p.id))).join('')}</div>
    </div>
    ${f ? aiFindingsPanel(f) : ''}`;
  }
  const figLabel = (n) => (n ? 'IMAGE ' + String(n).padStart(2, '0') : 'not in report');
  // ISO date-time ↔ the local "YYYY-MM-DDTHH:MM" a datetime-local input shows
  const localDT = (iso) => { const d = iso ? new Date(iso) : null; if (!d || isNaN(d)) return ''; const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  function photoCard(p, i, n) {
    return `<div class="pcard ${p.exclude ? 'excluded' : ''}" data-pid="${esc(p.id)}">
      <div class="pimg" data-act="label" data-i="${i}" title="Click to edit labels"><div class="pin"><img src="${esc(p.dataUrl)}" alt="">${Labeler.overlay(p.labels)}</div></div>
      <div class="pbody">
        <div class="row"><b class="pnum${n ? '' : ' out'}">${figLabel(n)}</b>${p.aiLabelled ? `<span class="badge ${p.labelsReviewed ? 'ok' : 'ai'}" title="${p.labelsReviewed ? 'Labels saved by the assessor' : 'Open the labels and save them once checked'}">AI labelled${p.labelsReviewed ? ' · reviewed' : ''}</span>` : ''}<span class="grow"></span>
          <button class="btn sm" data-act="pmove" data-i="${i}" data-d="-1" title="Move earlier">↑</button><button class="btn sm" data-act="pmove" data-i="${i}" data-d="1" title="Move later">↓</button>
          <button class="btn sm danger" data-act="pdel" data-i="${i}" title="Remove">✕</button></div>
        <input data-pf="title" data-i="${i}" value="${esc(p.title)}" placeholder="Title, e.g. RH front door - surface damage">
        <textarea data-pf="caption" data-i="${i}" placeholder="Caption">${esc(p.caption)}</textarea>
        <div class="row"><input data-pf="source" data-i="${i}" value="${esc(p.source)}" placeholder="Source" class="grow" style="width:auto">
          <label class="hint"><input type="checkbox" data-pf="include" data-i="${i}" ${p.exclude ? '' : 'checked'} style="width:auto"> in report</label></div>
        <label class="hint row" style="gap:6px;flex-wrap:nowrap" title="When the photo was taken: read from the photo's EXIF data or the file date. Correct it if it is wrong.">Taken<input type="datetime-local" data-pf="takenAt" data-i="${i}" value="${localDT(p.takenAt)}" style="width:auto;flex:1"></label>
        <button class="btn sm" data-act="label" data-i="${i}">✎ Edit labels (${(p.labels || []).length})</button>
      </div></div>`;
  }
  // after a photo is included / excluded: update every card's figure number and dimming in place
  function refreshPhotoNumbers() {
    const nums = C.photoNumbers(job);
    $$('.pcard[data-pid]').forEach((card) => {
      const p = job.photos.find((x) => String(x.id) === card.dataset.pid); if (!p) return;
      const n = nums.get(p.id);
      card.classList.toggle('excluded', !!p.exclude);
      const b = card.querySelector('.pnum'); if (b) { b.textContent = figLabel(n); b.classList.toggle('out', !n); }
    });
    const ab = $('[data-act="aiAnalyse"]'); if (ab && !busy('photos')) ab.disabled = !desktop || !nums.size;
  }
  function aiFindingsPanel(f) {
    const s = f.summary || {};
    const lines = f.suggested_lines || [];
    return `<div class="card aiPanel"><div class="row"><h2 class="grow">✦ AI assessor findings</h2><span class="hint">${esc(f.model || '')} · ${f.at ? new Date(f.at).toLocaleString('en-GB') : ''}</span></div>
      <p class="hint">Suggestions only. Check every item against the vehicle and photos before it goes in the report.</p>
      <div class="form">
        <div><b>Impact type:</b> ${esc(s.impact_type)}<br><b>Primary area:</b> ${esc(s.primary_area)}<br><b>Secondary:</b> ${esc(s.secondary_areas)}<br><b>Direction:</b> ${esc(s.direction_of_contact)}</div>
        <div><b>Structural concern:</b> ${s.structural_concern ? '<span class="badge err">Possible</span>' : '<span class="badge ok">None seen</span>'} ${esc(s.structural_notes)}</div>
        <div class="full"><b>Damage pattern:</b> ${esc(s.damage_pattern)}</div>
        <div class="full"><b>Consistency with circumstances:</b> ${esc(s.consistency_with_circumstances)}</div>
        ${(s.mechanical_checks || []).length ? `<div><b>Mechanical checks:</b><ul>${s.mechanical_checks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${(s.adas_and_calibration || []).length ? `<div><b>ADAS / calibration:</b><ul>${s.adas_and_calibration.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="row" style="margin:8px 0 14px"><button class="btn" data-act="aiApplySummary">Fill empty circumstances / assessment fields &amp; damage zones from these findings</button></div>
      <h3>Recommended estimate lines (${lines.length})</h3>
      <table class="tbl sugg"><thead><tr><th><input type="checkbox" data-act="suggAll" style="width:auto" checked></th><th>Type</th><th>Line</th><th>Part no. (catalogue)</th><th class="num">Hours</th><th>Evidence</th><th>Conf.</th></tr></thead><tbody>
      ${lines.map((l, i) => { const cands = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side) : []; const o = autoOem(cands); const added = l.added; return `<tr${added ? ' style="opacity:.5"' : ''}>
        <td><input type="checkbox" data-sugg="${i}" style="width:auto" ${ui.suggestSel[i] === false || added ? '' : 'checked'} ${added ? 'disabled' : ''}></td>
        <td>${esc(l.type)}</td><td><b>${esc(l.description)}</b>${l.code && l.code !== 'OTHER' ? ` <code class="hint">${esc(l.code)}${l.side ? '-' + l.side : ''}</code>` : ''}${added ? ' <span class="badge ok">added</span>' : ''}</td>
        <td>${o ? `<span class="oem ${esc(o.confidence)}">${esc(o.oem)}</span>` : cands.length ? `<span class="hint">${cands.length} numbers: choose by VIN</span>` : (l.needs_part ? '<span class="hint">price needed</span>' : '')}</td>
        <td class="num">${hrs(l.labour_hours)}</td><td class="reason">${esc(l.reason)}</td>
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
    toast(`Adding ${list.length} photo(s)…`);
    const added = [];
    for (const f of list) {
      try {
        const raw = await C.readFileAsDataURL(f);
        const r = await C.resizeDataURL(raw, 1800, 0.86);
        const takenAt = (await exifTakenAt(f)) || (f.lastModified ? new Date(f.lastModified).toISOString() : '');
        added.push({ id: C.uid(), dataUrl: r.dataUrl, w: r.width, h: r.height, title: '', caption: '', source: C.settings.company.name ? C.settings.company.name.replace(/ LTD$/i, '') : '', labels: [], fileName: f.name, takenAt });
      } catch (e) { toast('Could not read ' + f.name, true); }
    }
    if (added.length && !(await applyToJob(j, (x) => { x.photos.push(...added); }))) toast(`${regOf(j)} has been deleted, so the photos were not added.`, true);
  }

  // Job data for the AI: no images or signatures, and only the photos that are in the report, in figure order,
  // so "Image N" in prompts and drafts matches the printed figure numbers.
  function slimJob(src) {
    const nums = C.photoNumbers(src);
    const j = C.clone(Object.assign({}, src, { photos: [], issued: undefined }));
    if (j.assessor) delete j.assessor.signature;
    j.photos = src.photos.filter((p) => nums.has(p.id)).sort((a, b) => nums.get(a.id) - nums.get(b.id))
      .map((p) => ({ index: nums.get(p.id), title: p.title, caption: p.caption, labels: (p.labels || []).map((l) => ({ text: l.text })) }));
    return j;
  }

  async function aiAnalyse() {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    const j = job;
    const key = 'photos:' + j.id;
    if (running.has(key)) return;
    // only photos in the report are sent, numbered as their printed figures; results come back by that number and are mapped to the photo id
    const nums = C.photoNumbers(j);
    const photos = j.photos.filter((p) => nums.has(p.id)).sort((a, b) => nums.get(a.id) - nums.get(b.id));
    if (!photos.length) return toast('Add photos (ticked "in report") first.', true);
    const slim = slimJob(j);
    const ai = C.settings.ai || {};
    running.add(key); renderJob();
    try {
      const batches = [];
      for (let k = 0; k < photos.length; k += 10) batches.push(photos.slice(k, k + 10));
      const merged = { photos: [], summary: null, suggested_lines: [], model: '', at: new Date().toISOString() };
      const idByIndex = new Map();
      for (let b = 0; b < batches.length; b++) {
        if (batches.length > 1) toast(`AI analysing batch ${b + 1} of ${batches.length}…`);
        const payload = [];
        for (const p of batches[b]) {
          const r = await C.resizeDataURL(p.dataUrl, 1568, 0.85);
          idByIndex.set(nums.get(p.id), p.id);
          payload.push({ index: nums.get(p.id), mediaType: 'image/jpeg', base64: r.dataUrl.split(',')[1], title: p.title, caption: p.caption });
        }
        const res = await desktop.ai.analysePhotos({ job: slim, photos: payload, model: ai.model, effort: ai.effort });
        if (!res.ok) throw new Error(res.error);
        const d = res.result;
        merged.model = d.model;
        merged.photos.push(...(d.photos || []));
        merged.summary = merged.summary ? mergeSummary(merged.summary, d.summary) : d.summary;
        for (const l of d.suggested_lines || []) {
          const dup = merged.suggested_lines.find((x) => x.code === l.code && x.side === l.side && x.type === l.type && x.code !== 'OTHER');
          if (dup) dup.labour_hours = Math.max(dup.labour_hours, l.labour_hours); else merged.suggested_lines.push(l);
        }
      }
      let labelled = 0;
      const target = await applyToJob(j, (x) => {
        for (const ph of merged.photos) {
          const p = x.photos.find((q) => q.id === idByIndex.get(ph.index)); // by id: moving or deleting photos meanwhile cannot misplace labels
          if (!p) continue;
          p.labels = (p.labels || []).filter((l) => !l.ai).concat((ph.damages || []).map((d) => ({
            x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h, text: d.label, ai: true, colour: d.severity === 'severe' ? '#ff3b30' : d.severity === 'moderate' ? '#ff9500' : '#ffcc00',
            detail: `${C.sideWord(d.side)} ${d.component_name} · ${d.damage_type} · ${d.severity} · accident-related: ${d.accident_related} · ${d.recommended_operation}${d.notes ? ' — ' + d.notes : ''}`.trim(),
            code: d.component_code, side: d.side, accidentRelated: d.accident_related
          })));
          p.aiLabelled = true;
          p.labelsReviewed = false;
          if (!p.title) p.title = ph.title;
          if (!p.caption) p.caption = ph.caption;
          p.aiTitle = ph.title; p.aiCaption = ph.caption;
          labelled++;
        }
        x.aiFindings = merged;
        logAi(x, `Photo damage labelling & repair suggestions (${labelled} photos)`, merged.model);
        if (ui.jobId === x.id) ui.suggestSel = {}; // fresh suggestions: all ticked again
      });
      if (!target) toast(`${regOf(j)} has been deleted, so the AI findings were not saved.`, true);
      else toast(`AI labelled ${labelled} photo(s) and suggested ${merged.suggested_lines.length} estimate line(s)${target !== job ? ` for ${regOf(target)} (saved with that assessment)` : ''}.`);
    } catch (e) {
      toast(e.message, true);
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
    const fill = (path, val) => { if (val && !getPath(job, path)) setPath(job, path, val); };
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
    const damages = (f.photos || []).flatMap((ph) => ph.damages || []);
    let byVin = 0;
    (f.suggested_lines || []).forEach((l, i) => {
      if (l.added || ui.suggestSel[i] === false) return;
      const cands = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side) : [];
      const o = autoOem(cands);
      if (l.needs_part && cands.length && !o) byVin++;
      const cls = l.cost_class === 'paint' ? 'paint' : l.cost_class === 'other' ? 'other' : 'parts';
      // the operation the AI recommended for this component, when one of its photo labels names it
      const dm = l.code && l.code !== 'OTHER' ? damages.find((d) => d.component_code === l.code && (d.side || '') === (l.side || '') && d.recommended_operation && d.recommended_operation !== 'none') : null;
      job.lines.push(C.newLine(Object.assign({
        type: l.type, description: l.description, code: C.CAT[l.code] ? l.code : '', side: l.side, hours: l.labour_hours,
        partNo: l.needs_part && o ? o.oem : '', amount: l.needs_part && o && o.price ? o.price : 0, costClass: cls, ai: true, reviewed: false, source: l.reason, op: 'ai'
      }, dm ? { aiOperation: dm.recommended_operation } : {})));
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
        <span class="hint">${ov ? `OEM numbers: <b>${esc(ov.make + ' ' + ov.model + ' ' + ov.generation)}</b>` : `No catalogue vehicle linked. <a href="#/job/${job.id}/vehicle">Link one on the Vehicle tab</a> to fill OEM part numbers.`}</span></div>
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
    <div class="card" style="padding:0;overflow:auto"><table class="tbl" id="linesTbl"><thead><tr><th>#</th><th>Type</th><th style="min-width:260px">Description</th><th>Part no. / ref</th><th class="num">Hours</th><th class="num">Rate £/h</th><th class="num">Labour £</th><th class="num">Parts / mat. £</th><th>Cost class</th><th>Review</th><th></th></tr></thead>
      <tbody>${job.lines.map(lineRow).join('') || '<tr><td colspan="11" class="empty">No lines yet. Add parts above, or use the AI suggestions from Photos &amp; AI.</td></tr>'}</tbody></table>
      <div class="row" style="padding:10px"><button class="btn sm" data-act="addBlank">+ Blank line</button><span class="grow"></span><label class="fld" style="width:160px"><span>Discount £</span><input data-bind="discount" type="number" step="0.01" value="${esc(job.discount)}"></label></div></div>
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
    return `<div><span>Labour hours</span><b>${hrs(t.labourHours)}</b></div><div><span>Labour</span><b>${gbp(t.labour)}</b></div><div><span>Parts</span><b>${gbp(t.parts)}</b></div>
      <div><span>Paint materials</span><b>${gbp(t.paint)}</b></div><div><span>Other / services</span><b>${gbp(t.other)}</b></div>${num(t.discount) ? `<div><span>Less discount</span><b>${gbp(-num(t.discount))}</b></div>` : ''}<div><span>Net (excl. VAT)</span><b>${gbp(t.net)}</b></div>
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
        if (!c) return cands.length ? `<span class="oem single-source">${sw}${cands.length} numbers: choose by VIN</span>` : '';
        return `<span class="oem ${esc(c.confidence)}" title="${esc(c.description + ' — ' + c.confidence + (c.priceIncVat ? ' — ' + oemPrice(c) : ''))}">${sw}${esc(c.oem)}${c.price ? ' · ' + oemPrice(c, true) : ''}</span>`;
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
      <td><input data-lf="description" data-id="${l.id}" value="${esc(l.description)}">${l.source ? `<div class="hint" title="${esc(l.source)}">AI evidence: ${esc(l.source.slice(0, 110))}${l.source.length > 110 ? '…' : ''}</div>` : ''}</td>
      <td style="min-width:150px"><div class="row" style="flex-wrap:nowrap;gap:4px"><input data-lf="partNo" data-id="${l.id}" value="${esc(l.partNo)}">${hasOem ? `<button class="btn sm" data-act="oemPick" data-id="${l.id}" title="OEM options">⋯</button>` : ''}</div></td>
      <td class="num" style="width:80px"><input data-lf="hours" data-id="${l.id}" type="number" step="0.1" value="${esc(l.hours)}"></td>
      <td class="num" style="width:90px"><input data-lf="rate" data-id="${l.id}" type="number" step="0.01" value="${esc(l.rate)}" placeholder="${rate.toFixed(2)}"></td>
      <td class="num" data-lv="${l.id}">${num(l.hours) ? gbp(C.lineLabour(l.hours, rate)) : '—'}</td>
      <td class="num" style="width:100px"><input data-lf="amount" data-id="${l.id}" type="number" step="0.01" value="${esc(l.amount)}"></td>
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
    const sf = C.sizeFactor(job), pf = C.paintFactor(job);
    const H = (h) => Math.max(0.1, Math.round(h * sf * 10) / 10);
    const P = (h) => Math.max(0.1, Math.round(h * sf * pf * 10) / 10); // refinish time: the paint factor is applied here, and recorded as pfApplied
    for (const side of sides) {
      const sw = side ? C.sideWord(side) + ' ' : '';
      const nm = sw + p.name.charAt(0).toLowerCase() + p.name.slice(1);
      const Nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      const typeFor = ['M', 'W'].includes(p.kind) ? 'Mechanical' : ['E', 'A'].includes(p.kind) ? 'Electrical' : 'Body';
      const cands = C.oemLookup(job.vehicle.oemKey, p.code, side), o = autoOem(cands);
      if (cands.length && !o && (opRow || op === 'replace')) notes.add(chooseByVin(cands.length) + ' (⋯ on the line).');
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
    if (!rate) return toast('Set a paint materials rate (£ per paint hour) in Settings → Rates first.', true);
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
      ${cands.map((c, i) => `<tr><td><b>${esc(c.oem)}</b></td><td>${esc(c.description)}</td><td><span class="badge ${c.confidence === 'confirmed' ? 'ok' : 'warn'}">${esc(c.confidence)}</span> ${oemBadges(c)}</td><td class="num">${oemPrice(c) || '—'}</td>
        <td class="hint" style="max-width:380px">${esc(c.notes)}${httpUrl(c.source) ? `<br><a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : c.source ? `<br>${esc(c.source)}` : ''}</td><td><button class="btn sm primary" data-use="${i}">Use</button></td></tr>`).join('')}</tbody></table>`);
    b.addEventListener('click', async (e) => {
      const u = e.target.closest('[data-use]'); if (!u) return;
      const c = cands[+u.dataset.use];
      closeModal();
      await applyToJob(j, (x) => { const t = x.lines.find((y) => y.id === lineId); if (t) { t.partNo = c.oem; if (c.price) t.amount = c.price; } });
    });
  }

  // ---------- VALUATION ----------
  function tabValuation() {
    const t = C.totals(job);
    const v = job.valuation;
    return `<div class="card"><h2 style="margin-top:0">Valuation</h2><div class="form">
      ${F('valuation.date', 'Valuation date / date assessed', { ph: 'e.g. September 2026' })}${F('valuation.mileage', 'Mileage used for valuation', { type: 'number', hint: job.vehicle.mileage && !v.mileage ? `<button class="link" data-act="valMileage">Use inspection mileage (${esc(job.vehicle.mileage)})</button>` : '' })}
      ${F('valuation.costNew', 'Cost at new')}${F('valuation.condition', 'Pre-accident condition', { type: 'select', options: ['EXCELLENT', 'GOOD', 'SATISFACTORY', 'FAIR', 'POOR'] })}</div>
      <h3>Valuation evidence</h3>
      <table class="tbl"><thead><tr><th>Source</th><th class="num">Amount £</th><th></th></tr></thead><tbody>
        ${v.sources.map((s, i) => `<tr><td><input data-vs="name" data-i="${i}" value="${esc(s.name)}" list="valsrc"></td><td class="num" style="width:160px"><input type="number" step="1" data-vs="amount" data-i="${i}" value="${esc(s.amount)}"></td><td><button class="btn sm danger" data-act="vsDel" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table><datalist id="valsrc"><option value="Glass's Guide"><option value="CAP HPI"><option value="AutoTrader"><option value="Percayso Vehicle Intelligence"><option value="Like-for-like advert"><option value="Dealer retail advert"></datalist>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="vsAdd">+ Source</button><span class="grow"></span>
        <span class="row" id="valRange">${valRange(t)}</span></div>
      <div class="form3" style="margin-top:14px">${F('valuation.adopted', 'Assessed pre-accident value £', { type: 'number' })}${F('valuation.salvagePct', 'Salvage % of PAV', { type: 'number', hint: `<span id="salvageHint">= ${gbp(C.round2(t.pav * num(v.salvagePct) / 100))}</span>` })}${F('valuation.salvageOverride', 'Salvage value override £ (e.g. actual bid)', { type: 'number' })}</div>
      <div class="form" style="margin-top:12px">${F('valuation.belowHighestReason', 'Reason for adopting a value below the highest guide', { type: 'textarea', rows: 2, full: true, hint: 'Printed in the report. The ombudsman\'s starting point is the highest retail guide, so explain any lower figure with evidence about this vehicle.' })}</div>
      <h3>Like-for-like adverts</h3>
      <table class="tbl"><thead><tr><th>Description (derivative)</th><th>Year</th><th class="num">Mileage</th><th class="num">Price £</th><th>Source / URL</th><th></th></tr></thead><tbody>
        ${(v.adverts || []).map((a, i) => `<tr><td><input data-adv="description" data-i="${i}" value="${esc(a.description)}"></td><td style="width:80px"><input data-adv="year" data-i="${i}" value="${esc(a.year)}"></td><td class="num" style="width:110px"><input type="number" data-adv="mileage" data-i="${i}" value="${esc(a.mileage)}"></td><td class="num" style="width:110px"><input type="number" data-adv="price" data-i="${i}" value="${esc(a.price)}"></td><td><input data-adv="url" data-i="${i}" value="${esc(a.url)}" placeholder="AutoTrader / dealer URL"></td><td><button class="btn sm danger" data-act="advDel" data-i="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="hint">No adverts. Add your own, or let the AI search for comparables.</td></tr>'}
      </tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="advAdd">+ Advert</button></div>
      <div class="form" style="margin-top:12px">${F('valuation.historyNotes', 'History notes (previous write-off category, finance, plate changes, imports)', { type: 'textarea', rows: 2 })}${F('valuation.optionsNotes', 'Condition, options & service history notes', { type: 'textarea', rows: 2 })}</div></div>
    ${valuationAiPanel()}
    <div class="card"><h2 style="margin-top:0">Economic repair &amp; outcome</h2>
      <div id="econBox">${econBox(t)}</div>
      <div class="form">${F('outcome.decision', 'Economic repair / total-loss assessment', { type: 'select', options: DECISIONS })}
        ${F('outcome.category', 'Salvage category (ABI Code of Practice)', { type: 'select', options: [['', 'Not assessed'], ['N', 'Category N — Non-Structural'], ['S', 'Category S — Structural']], hint: 'S: structural frame or chassis damaged. N: no structural damage. Categories A/B (break/crush only) are not offered here.' })}
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
  function valuationAiPanel() {
    const r = job.valuation.ai;
    return `<div class="card aiPanel"><div class="row"><div class="grow"><h2 style="margin:0">✦ AI valuation assistant</h2><div class="hint">Applies the ombudsman's approach: retail market value at the date of loss, starting from the highest guide, adjusted only on evidence about this vehicle, with mileage checked against the MOT history.</div></div>
      <label class="hint"><input type="checkbox" id="valSearch" style="width:auto" ${ui.valSearch !== false ? 'checked' : ''}> search the web for comparable UK adverts</label>
      <button class="btn ai" data-act="aiValuation" ${desktop && !busy('val') ? '' : 'disabled'}>${busy('val') ? '<span class="spinner"></span>Valuing…' : '✦ AI valuation'}</button></div>
      ${r ? `<div class="totals" style="margin-top:12px"><div class="g"><span>Recommended PAV</span><b>${gbp(r.recommended_pav)}</b></div><div><span>Range</span><b>${gbp(r.range_low)} – ${gbp(r.range_high)}</b></div><div><span>Basis</span><b style="font-size:13px">${esc(r.basis)}</b></div></div>
        <p><b>Guides:</b> ${esc(r.guide_assessment)}</p><p><b>Mileage:</b> ${esc(r.mileage_assessment)}</p>
        ${(r.adjustments || []).length ? `<table class="tbl"><thead><tr><th>Adjustment</th><th class="num">£</th><th>Reason</th></tr></thead><tbody>${r.adjustments.map((a) => `<tr><td>${esc(a.item)}</td><td class="num">${gbp(a.amount)}</td><td class="hint">${esc(a.reason)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${(r.comparables || []).length ? `<h3>Comparables</h3><table class="tbl"><thead><tr><th>Vehicle</th><th>Year</th><th class="num">Miles</th><th class="num">Price</th><th>Like-for-like</th><th>Source</th></tr></thead><tbody>${r.comparables.map((c, i) => `<tr><td>${esc(c.description)}<div class="hint">${esc(c.notes)}</div></td><td>${esc(c.year)}</td><td class="num">${num(c.mileage).toLocaleString('en-GB')}</td><td class="num">${gbp(c.price)}</td><td>${c.like_for_like ? '<span class="badge ok">yes</span>' : '<span class="badge warn">partial</span>'}</td><td>${httpUrl(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source || 'link')}</a>` : esc(c.source || c.url || '')}<button class="btn sm" data-act="advFromAi" data-i="${i}" title="Add to adverts">+</button></td></tr>`).join('')}</tbody></table>` : ''}
        ${(r.flags || []).length ? `<div class="card" style="border-color:#f0c36d;background:#fffaf0;margin-top:10px"><b>Check:</b><ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="aiValApply">Adopt ${gbp(r.recommended_pav)} and use these comments</button><span class="hint">${esc(r.model || '')}${r.searched ? ' · web search used' : ''}</span></div>` : ''}
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
      const res = await desktop.ai.valuation({ job: slimJob(j), motHistory: j.vehicle.motHistory || [], searchWeb: ui.valSearch !== false, model: ai.model, effort: ai.effort });
      if (!res.ok) throw new Error(res.error);
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
    return `<div class="card"><div class="row"><div class="grow"><h2 style="margin:0">Report narrative</h2><div class="hint">The AI writes every narrative section from your photos, findings, estimate and figures. You review each section before applying it.</div></div>
      <button class="btn ai" data-act="aiDraft" ${!desktop || busy('draft') ? 'disabled' : ''}>${busy('draft') ? '<span class="spinner"></span>Drafting…' : '✦ AI draft all narrative'}</button></div>
      ${pendingDrafts.has(job.id) ? '<div class="row" style="margin-top:10px"><span class="badge ai">AI draft ready</span><button class="btn sm" data-act="reviewPendingDraft">Review the AI draft</button><span class="hint">Nothing is changed until you apply sections.</span></div>' : ''}</div>
      <div class="card"><div class="form">
      ${F('report.summary', 'Section 01 — headline summary (use **bold** for key findings)', { type: 'textarea', rows: 6, full: true })}
      ${F('opinion', "Report comments / engineer's opinion", { type: 'textarea', rows: 18, full: true })}</div></div>`;
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
      if (!res.ok) throw new Error(res.error);
      const target = await applyToJob(j, (x) => logAi(x, 'Narrative drafting', res.result.model));
      if (!target) return toast(`${regOf(j)} has been deleted, so the AI draft was discarded.`, true);
      pendingDrafts.set(j.id, res.result); // kept until applied, so closing the review does not lose a paid draft
      if (job && job.id === j.id) reviewDraft(res.result, j.id);
      else toast(`The AI draft for ${regOf(target)} is ready. Open that assessment's Opinion tab to review it.`);
    } catch (e) { toast(e.message, true); } finally { running.delete(key); if (job && job.id === j.id && tab === 'opinion') renderJob(); }
  }
  function reviewDraft(d, jid) {
    const map = [
      ['summary', 'report.summary', 'Section 01 summary'], ['inspection_condition', 'inspection.condition', 'Vehicle condition at inspection'],
      ['structural', 'assessment.structural', 'Structural & body assessment'], ['mechanical', 'assessment.mechanical', 'Mechanical assessment'],
      ['wheels', 'assessment.wheels', 'Wheels & tyres'], ['geometry', 'assessment.geometry', 'Geometry'], ['diagnostics', 'assessment.diagnostics', 'Diagnostics & warning lamps'],
      ['roadworthiness', 'assessment.roadworthiness', 'Roadworthiness'], ['estimate_notes', 'estimateNotes', 'Estimate notes'], ['valuation_comments', 'valuation.comments', 'Valuation comments'],
      ['opinion', 'opinion', "Engineer's opinion"], ['decision', 'outcome.decision', 'Decision'], ['category', 'outcome.category', 'Salvage category']
    ];
    const html = `${(d.review_flags || []).length ? `<div class="card" style="border-color:#f0c36d;background:#fffaf0"><b>Check before signing:</b><ul>${d.review_flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      <div class="cmp" style="font-weight:700"><span></span><span>Current</span><span>AI draft</span></div>
      ${map.map(([k, path, label], i) => { const cur = getPath(job, path) || ''; const nu = d[k] == null ? '' : String(d[k]); if (!nu) return ''; return `<div class="cmp"><input type="checkbox" data-apply="${i}" ${cur ? '' : 'checked'} style="width:auto"><div><b>${esc(label)}</b><div class="old">${esc(cur) || '<i>empty</i>'}</div></div><div class="new">${esc(nu)}</div></div>`; }).join('')}
      <div class="row" style="margin-top:14px"><button class="btn" data-sel="all">Select all</button><span class="grow"></span><button class="btn primary" data-go="1">Apply selected sections</button></div>`;
    const b = openModal('✦ AI draft — review before applying', html);
    b.addEventListener('click', async (e) => {
      if (e.target.closest('[data-sel]')) $$('input[data-apply]', b).forEach((c) => { c.checked = true; });
      if (e.target.closest('[data-go]')) {
        const picks = $$('input[data-apply]', b).filter((c) => c.checked).map((c) => map[+c.dataset.apply]);
        closeModal();
        const target = await applyToJob({ id: jid }, (x) => picks.forEach(([k, path]) => setPath(x, path, d[k])));
        if (!target) return toast('That assessment has been deleted, so the draft was not applied.', true);
        pendingDrafts.delete(jid);
        toast(`${picks.length} section(s) applied${target !== job ? ' to ' + regOf(target) : ''}. Review them in the report preview.`);
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
        ${iss ? `<span class="badge ok">finalised ${esc(new Date(iss.at).toLocaleString('en-GB'))}</span><button class="btn" data-act="reopenReport">Re-open</button>` : '<button class="btn primary" data-act="finaliseReport">Finalise report</button>'}</div>
      <p class="hint" style="margin-bottom:0">${iss ? 'The company details, logo, declaration, signature, qualifications and AQP ID printed in this report are frozen as they were when it was finalised, so later changes in Settings do not alter it. Re-open it to use the current Settings.' : 'Finalising freezes the company details, logo, declaration, signature, qualifications and AQP ID printed in this report, so later changes in Settings cannot alter an issued report. You can re-open it later.'}</p></div>
      <div class="card"><div class="form">
      ${F('assessor.name', 'Assessor name')}${F('assessor.title', 'Professional role / title')}
      ${F('assessor.qualifications', 'Qualifications (e.g. MIAEA, IMI VDA accreditation no.)')}${F('assessor.aqpId', 'AQP ID (ABI salvage categorisation)')}
      ${F('assessor.dateSigned', 'Date signed', { type: 'date', hint: '<button class="link" data-act="signToday">Sign today</button>' })}<div></div>
      ${F('report.conflicts', 'Conflict of interest declaration', { full: true })}</div>
      <label class="row" style="margin-top:10px"><input type="checkbox" data-bind-check="report.cpr35" ${job.report.cpr35 ? 'checked' : ''} style="width:auto"> <b>Court-compliant expert report (CPR Part 35 / PD 35)</b>: adds the expert's duty statement, the statement of truth, and the PD 35 checks</label>
      ${(job.aiLog || []).length ? `<h3>AI and data-use log</h3><table class="tbl"><thead><tr><th>When</th><th>Action</th><th>Model / source</th></tr></thead><tbody>${job.aiLog.map((a) => `<tr><td class="hint">${esc(new Date(a.at).toLocaleString('en-GB'))}</td><td><span class="badge ${a.ai ? 'ai' : ''}">${a.ai ? 'AI' : 'data'}</span> ${esc(a.action)}</td><td class="hint">${esc(a.model || '')}</td></tr>`).join('')}</tbody></table><p class="hint">The report's "Use of AI and data tools" statement lists these. The assessor remains responsible for every opinion.</p>` : ''}
      <h3>Signature</h3>
      ${sig ? `<img src="${esc(sig)}" style="max-height:80px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:4px">` : '<p class="hint">No signature.</p>'}
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="sigDraw" data-target="job">Draw signature</button><button class="btn sm" data-act="sigUpload" data-target="job">Upload image</button>
        ${job.assessor.signature ? '<button class="btn sm danger" data-act="sigClear">Remove this report\'s signature</button>' : ''}
        <label class="hint"><input type="checkbox" data-bind-check="assessor.useDefaultSignature" ${job.assessor.useDefaultSignature ? 'checked' : ''} style="width:auto"> use my default signature from Settings</label></div>
      ${iss && sig ? '<p class="hint">This is the signature frozen when the report was finalised.</p>' : ''}
      <h3>Declaration</h3><p class="hint" style="white-space:pre-wrap">${esc(iss ? iss.declaration : C.settings.assessor.declaration)}</p><p class="hint">${iss ? 'The declaration as it was when the report was finalised.' : 'Edit the declaration in Settings.'}</p></div>`;
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

  async function exportPdf() {
    const un = job.lines.filter((l) => l.ai && !l.reviewed).length;
    if (un && !confirm(`${un} AI-suggested estimate line${un === 1 ? ' has' : 's have'} not been marked as reviewed, and the report will say so. Export anyway?`)) return;
    const html = Report.render(job, { mode: desktop ? 'pdf' : 'print' });
    const name = (job.report.ref || job.vehicle.reg || 'engineering-report').replace(/[^\w.-]+/g, '_');
    if (desktop) {
      const tpl = Report.pdfTemplates(job);
      const r = await desktop.exportPdf({ html, header: tpl.header, footer: tpl.footer, fileName: name });
      if (r.ok) toast('PDF saved: ' + r.filePath); else if (!r.canceled) toast('PDF export failed: ' + r.error, true);
    } else {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      f.srcdoc = html;
      f.onload = () => { f.contentWindow.print(); setTimeout(() => f.remove(), 2000); };
    }
  }
  async function saveText(content, fileName, ext) {
    if (desktop) { const r = await desktop.saveFile({ content, fileName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }); if (r.ok) toast('Saved ' + r.filePath); else if (!r.canceled && r.error) toast(r.error, true); return; }
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
    const b = openModal('Draw signature', `<canvas class="sigpad" width="640" height="200" style="width:100%;max-width:640px"></canvas><div class="row" style="margin-top:10px"><button class="btn" data-clr>Clear</button><span class="grow"></span><button class="btn primary" data-ok>Use signature</button></div>`);
    const cv = $('canvas', b); const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.strokeStyle = '#13233a';
    let drawing = false, last = null, inked = false;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    cv.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; inked = true; });
    cv.addEventListener('pointerup', () => { drawing = false; });
    b.addEventListener('click', (e) => {
      if (e.target.dataset.clr != null) { ctx.clearRect(0, 0, cv.width, cv.height); inked = false; }
      if (e.target.dataset.ok != null) { if (!inked) return toast('Draw a signature first.', true); onDone(cv.toDataURL('image/png')); closeModal(); }
    });
  }

  // ---------- SETTINGS ----------
  let dataStatus = { dvla: false, mot: false };
  async function renderSettings() {
    const seq = routeSeq;
    if (desktop) { aiStatus = await desktop.ai.status(); dataStatus = await desktop.data.status(); }
    if (seq !== routeSeq) return;
    const s = C.settings;
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
        ${desktop ? `<p>DVLA: ${dataStatus.dvla ? '<span class="badge ok">key saved</span>' : '<span class="badge warn">not set</span>'} · MOT History: ${dataStatus.mot ? '<span class="badge ok">credentials saved</span>' : '<span class="badge warn">not set</span>'}</p>
        <h3>DVLA Vehicle Enquiry Service</h3>
        <div class="form"><label class="fld"><span>DVLA API key (x-api-key)</span><input type="password" id="kDvla" autocomplete="off" placeholder="${dataStatus.dvla ? '•••••• saved, paste a new key to replace' : 'paste the key from your DVLA email'}"></label>
          ${S('dvlaEnv', 'DVLA service', { type: 'select', options: [['live', 'Live'], ['test', 'Test (UAT): test keys only, test registrations']], hint: 'DVLA test keys only work on the test service (test registrations such as AA19AAA).' })}
          <div class="row" style="align-items:end"><button class="btn primary" data-act="saveDvla">Save DVLA key</button>${dataStatus.dvla ? '<button class="btn danger" data-act="clearDvla">Remove</button>' : ''}</div></div>
        <h3>DVSA MOT History API</h3>
        <p class="hint">Copy each value from the DVSA "Here are your credentials" email.</p>
        <div class="form"><label class="fld"><span>Client ID</span><input type="password" id="kMotId" autocomplete="off"></label><label class="fld"><span>Client secret</span><input type="password" id="kMotSecret" autocomplete="off"></label>
          <label class="fld"><span>API key</span><input type="password" id="kMotKey" autocomplete="off"></label><label class="fld"><span>Token URL (https://login.microsoftonline.com/…/oauth2/v2.0/token) or tenant ID</span><input type="password" id="kMotTokenUrl" autocomplete="off"></label>
          <label class="fld"><span>Scope URL</span><input id="kMotScope" autocomplete="off" placeholder="https://tapi.dvsa.gov.uk/.default"></label>
          <div class="row" style="align-items:end"><button class="btn primary" data-act="saveMot">Save MOT credentials</button>${dataStatus.mot ? '<button class="btn danger" data-act="clearMot">Remove</button>' : ''}</div></div>
        <h3>Test the connections</h3>
        <div class="row"><input id="testReg" placeholder="Registration, e.g. ${C.settings.dvlaEnv === 'test' ? 'AA19AAA' : 'AB12 CDE'}" style="width:220px"><button class="btn" data-act="testDvla" ${dataStatus.dvla ? '' : 'disabled'}>Test DVLA</button><button class="btn" data-act="testMot" ${dataStatus.mot ? '' : 'disabled'}>Test MOT History</button></div>
        <p class="hint">Keys are encrypted on this PC${dataStatus.encrypted === false ? ' <b style="color:var(--err)">(this PC has no secure storage, so keys are saved unencrypted)</b>' : ''} and are never stored in jobs, backups or reports. If a DVSA client secret expires (every 2 years) or an API key is unused for 90 days, request new ones from DVSA.</p>` : '<p class="hint">Data connections work in the desktop app.</p>'}</div>
      <div class="card aiPanel"><h2>✦ AI assessor</h2>
        ${desktop ? `<p>Status: ${aiStatus.hasKey ? '<span class="badge ok">API key set</span>' : '<span class="badge warn">No API key</span>'} ${aiStatus.encrypted ? '<span class="hint">Key is encrypted by your operating system and never stored in reports.</span>' : ''}</p>
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
      <div class="card"><h2 style="margin-top:0">Data</h2><p class="hint">Jobs are stored on this computer. Back up regularly.</p>
        <div class="row"><button class="btn" data-act="backup">Export full backup</button><button class="btn" data-act="restore">Restore backup</button></div></div></div>`;
  }

  // ---------- CATALOGUE ----------
  function renderCatalogue() {
    const vs = C.oemVehicles();
    const sel = ui.catVeh || (vs[0] && vs[0].key) || '';
    const v = C.findOemVehicle(sel);
    const q = (ui.catQ || '').toLowerCase();
    const rows = Object.values(C.CAT).filter((p) => !q || (p.name + ' ' + p.code + ' ' + p.group).toLowerCase().includes(q) || (v && ['', 'L', 'R'].some((s) => (v.parts[p.code + '|' + s] || []).some((c) => c.oem.toLowerCase().includes(q)))));
    const total = vs.reduce((n, x) => n + Object.values(x.parts).flat().length, 0);
    main.innerHTML = `<div class="wrap"><h1>Parts catalogue</h1>
      <div class="sub">${Object.keys(C.CAT).length} master parts with this software's own codes and guide times, plus ${total} researched OEM part numbers across ${vs.length} vehicles. Add your own numbers as you use them.</div>
      <div class="card"><div class="row">
        <label class="fld" style="width:340px"><span>Vehicle</span><select id="catVeh">${vs.map((x) => `<option value="${x.key}"${x.key === sel ? ' selected' : ''}>${esc(x.make + ' ' + x.model + ' ' + x.generation + ' (' + x.years + ')')} — ${Object.values(x.parts).flat().length} nos.</option>`).join('')}</select></label>
        <label class="fld grow"><span>Search parts or part numbers</span><input id="catQ" value="${esc(ui.catQ || '')}" placeholder="e.g. mirror, FW001, 96301"></label>
        <button class="btn" data-act="catAddVeh">+ Vehicle</button><button class="btn" data-act="catAddNo">+ Part number</button><button class="btn" data-act="catImport" title="CSV columns: code, side (LH/RH), oem, description, price (£ ex VAT). A header row is optional; quoted fields may contain commas.">Import CSV</button></div>
        ${v && v.notes ? `<p class="hint">${esc(v.notes)}</p>` : ''}
        <p class="hint"><span class="oem confirmed">■ confirmed</span> = 2+ independent sources or official listing · <span class="oem single-source">■ single-source</span> = verify before use · <span class="oem report">■ user</span> = added by you. Always confirm by VIN before ordering.</p></div>
      <div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Code</th><th>Part</th><th>Group</th><th class="num">Replace h</th><th class="num">Refinish h</th><th>OEM numbers (${v ? esc(v.make + ' ' + v.model) : '—'})</th></tr></thead><tbody>
      ${rows.map((p) => { const cells = v ? ['', 'L', 'R'].map((s) => (v.parts[p.code + '|' + s] || []).map((c) => `<div class="oem ${c.user ? 'report' : esc(c.confidence)}" title="${esc(c.description + ' · ' + c.notes)}">${s ? C.sideWord(s) + ': ' : ''}<b>${esc(c.oem)}</b>${oemPrice(c) ? ' · ' + oemPrice(c) : ''}${httpUrl(c.source) ? ` <a href="${esc(c.source)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`).join('')).join('') : ''; return `<tr><td><code>${p.code}</code></td><td>${esc(p.name)}${p.sided ? ' <span class="hint">LH/RH</span>' : ''}</td><td class="hint">${esc(p.group)}</td><td class="num">${p.replaceHrs}</td><td class="num">${p.refinishHrs || '—'}</td><td>${cells || '<span class="hint">—</span>'}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }
  async function saveCustomOem(list) { await C.Store.set('customOem', list); C.setCustomOem(list); }
  function catAddNo() {
    const vs = C.oemVehicles();
    const b = openModal('Add OEM part number', `<div class="form">
      <label class="fld"><span>Vehicle</span><select id="nVeh">${vs.map((x) => `<option value="${x.key}"${x.key === ui.catVeh ? ' selected' : ''}>${esc(x.make + ' ' + x.model + ' ' + x.generation)}</option>`).join('')}</select></label>
      <label class="fld"><span>Catalogue part</span><select id="nCode">${Object.values(C.CAT).map((p) => `<option value="${p.code}">${p.code} — ${esc(p.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Side</span><select id="nSide"><option value="">— (not sided)</option><option value="L">LH</option><option value="R">RH</option></select></label>
      <label class="fld"><span>OEM part number</span><input id="nOem"></label>
      <label class="fld"><span>Description</span><input id="nDesc"></label><label class="fld"><span>Price £ ex VAT (optional)</span><input id="nPrice" type="number" step="0.01"></label>
      <label class="fld full"><span>Notes / source</span><input id="nNotes" placeholder="e.g. Confirmed by dealer for VIN …"></label></div>
      <div class="row" style="margin-top:12px"><span class="grow"></span><button class="btn primary" data-ok>Add</button></div>`);
    b.addEventListener('click', async (e) => {
      if (e.target.dataset.ok == null) return;
      const oem = $('#nOem', b).value.trim(); if (!oem) return toast('Enter a part number.', true);
      const key = $('#nVeh', b).value; const base = C.findOemVehicle(key);
      const list = C.clone(C.customOem);
      let cv = list.find((x) => x.key === key);
      if (!cv) { cv = { key, make: base.make, model: base.model, generation: base.generation, years: base.years, parts: {} }; list.push(cv); }
      const k = $('#nCode', b).value + '|' + $('#nSide', b).value;
      (cv.parts[k] = cv.parts[k] || []).unshift({ oem, description: $('#nDesc', b).value || C.CAT[$('#nCode', b).value].name, notes: $('#nNotes', b).value, price: num($('#nPrice', b).value) || null, priceIncVat: null, source: '', confidence: 'confirmed', user: true, autoFill: true, role: 'primary', market: 'UK' });
      await saveCustomOem(list); closeModal(); ui.catVeh = key; renderCatalogue(); toast('Part number added.');
    });
  }
  function catAddVeh() {
    const b = openModal('Add catalogue vehicle', `<div class="form"><label class="fld"><span>Make</span><input id="vMake"></label><label class="fld"><span>Model</span><input id="vModel"></label>
      <label class="fld"><span>Generation / chassis code</span><input id="vGen" placeholder="e.g. Mk8, F15, J11"></label><label class="fld"><span>Years</span><input id="vYears" placeholder="2017-2023"></label></div>
      <div class="row" style="margin-top:12px"><span class="grow"></span><button class="btn primary" data-ok>Add</button></div>`);
    b.addEventListener('click', async (e) => {
      if (e.target.dataset.ok == null) return;
      const make = $('#vMake', b).value.trim(), model = $('#vModel', b).value.trim();
      if (!make || !model) return toast('Make and model are required.', true);
      const gen = $('#vGen', b).value.trim();
      const key = 'user-' + (make + '-' + model + '-' + gen).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const list = C.clone(C.customOem);
      if (!list.find((x) => x.key === key)) list.push({ key, make, model, generation: gen, years: $('#vYears', b).value.trim(), parts: {} });
      await saveCustomOem(list); ui.catVeh = key; closeModal(); renderCatalogue();
    });
  }
  // RFC 4180 CSV: quoted fields may hold commas, line breaks and doubled quotes ("").
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    text = String(text || '').replace(/^\uFEFF/, '');
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
  async function catImport() {
    const f = await pickFile('.csv,text/csv'); if (!f) return;
    const rows = parseCsv(await f.text());
    const key = ui.catVeh || (C.oemVehicles()[0] || {}).key; const base = C.findOemVehicle(key);
    if (!base) return toast('Choose a vehicle first.', true);
    const list = C.clone(C.customOem);
    let cv = list.find((x) => x.key === key);
    if (!cv) { cv = { key, make: base.make, model: base.model, generation: base.generation, years: base.years, parts: {} }; list.push(cv); }
    // the first row is a header only when it says "code" or does not start with a catalogue code
    let start = 0, headerNote = '';
    if (rows.length) { const c0 = rows[0][0] || ''; if (/^code$/i.test(c0)) start = 1; else if (!C.CAT[c0.toUpperCase()]) { start = 1; headerNote = ` The first row ("${c0.slice(0, 30)}") was read as a header.`; } }
    let n = 0, bad = 0;
    for (const c of rows.slice(start)) {
      const code = (c[0] || '').toUpperCase(), oem = c[2] || '';
      if (!C.CAT[code] || !oem) { bad++; continue; }
      const sd = (c[1] || '').toUpperCase().replace(/\s+/g, '');
      const side = /^(L|LH|LEFT|NS|N\/S|NEARSIDE)$/.test(sd) ? 'L' : /^(R|RH|RIGHT|OS|O\/S|OFFSIDE)$/.test(sd) ? 'R' : '';
      const price = num(String(c[4] || '').replace(/[£,\s]/g, ''));
      const k = code + '|' + side;
      (cv.parts[k] = cv.parts[k] || []).unshift({ oem, description: c[3] || C.CAT[code].name, notes: 'Imported from CSV', price: price || null, priceIncVat: null, source: '', confidence: 'confirmed', user: true, autoFill: true, role: 'primary', market: 'UK' });
      n++;
    }
    await saveCustomOem(list); renderCatalogue();
    toast(`Imported ${n} part number(s)${bad ? `, skipped ${bad} row(s) with an unknown code or no part number` : ''}.${headerNote} CSV columns: code,side,oem,description,price (£ ex VAT)`, !n && (bad > 0 || !rows.length));
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
    }
    if (tab === 'report' && job) {
      const f = $('#preview');
      if (f) { try { f.srcdoc = Report.render(job, { mode: 'preview' }); } catch (err) { f.srcdoc = `<p style="font:14px sans-serif;padding:20px;color:#c0392b">The report preview could not be built: ${esc(err.message || err)}</p>`; } }
    }
  }

  main.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.bind && job) {
      const path = t.dataset.bind;
      setPath(job, path, t.type === 'number' ? (t.value === '' ? '' : num(t.value)) : t.value);
      if (path === 'vehicle.firstReg') { job.vehicle.firstRegPrecision = t.value ? 'day' : ''; const h = t.parentElement.querySelector('.hint'); if (h) h.textContent = ''; }
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
      const p = job.photos[+t.dataset.i]; if (!p) return;
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
      const a = job.valuation.adverts[+t.dataset.i];
      a[t.dataset.adv] = ['mileage', 'price'].includes(t.dataset.adv) ? (t.value === '' ? '' : num(t.value)) : t.value;
      changed(); return;
    }
    if (t.dataset.vs && job) {
      const s = job.valuation.sources[+t.dataset.i];
      s[t.dataset.vs] = t.dataset.vs === 'amount' ? (t.value === '' ? '' : num(t.value)) : t.value;
      changed(); return;
    }
    if (t.id === 'pickQ') { ui.pickQ = t.value; ui.zoneGroups = null; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'catQ') { ui.catQ = t.value; const pos = t.selectionStart; renderCatalogue(); const n = $('#catQ'); n.focus(); n.setSelectionRange(pos, pos); return; }
  });
  main.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.bindCheck && job) { setPath(job, t.dataset.bindCheck, t.checked); changed(); renderJob(); return; }
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
      if (['vehicle.oemKey', 'outcome.decision', 'outcome.category', 'vehicle.sizeClass', 'vehicle.paintType'].includes(t.dataset.bind)) renderJob();
    }
  });
  const saveSettingsSoon = C.debounce(() => { settingsPending = false; C.saveSettings(); }, 400);

  main.addEventListener('click', async (e) => {
    const zone = e.target.closest('[data-zone]');
    if (zone && job) {
      const z = zone.dataset.zone;
      job.zones = job.zones.includes(z) ? job.zones.filter((x) => x !== z) : job.zones.concat(z);
      changed(); renderJob(); return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    const A = {
      loadSample: async () => { const j = Sample.sampleJob(); await C.Store.saveJob(j); location.hash = `#/job/${j.id}/report`; toast('Sample job loaded. Its personal details are anonymised.'); },
      importJob: async () => {
        const f = await pickFile('.json,application/json'); if (!f) return;
        let j;
        try { j = JSON.parse(await f.text()); if (!isObj(j) || !isObj(j.vehicle) || !Array.isArray(j.lines)) throw new Error(); j.id = C.uid(); migrate(j); } catch (err) { return toast('That file is not a job file.', true); }
        await C.Store.saveJob(j); // saved in the current shape, so the Jobs list can always read it
        location.hash = `#/job/${j.id}/claim`;
      },
      dupJob: async () => {
        const src = await C.Store.getJob(el.dataset.id); if (!src) return renderJobs();
        const j = C.clone(src); migrate(j);
        j.id = C.uid(); j.report.ref = (j.report.ref || '') + '-COPY'; j.createdAt = new Date().toISOString(); delete j.issued; // a copy is a new draft
        await C.Store.saveJob(j); renderJobs();
      },
      delJob: async () => { if (!confirm('Delete this assessment permanently?')) return; await C.Store.deleteJob(el.dataset.id); renderJobs(); },
      genRef: () => { const r = (job.vehicle.reg || 'REG').replace(/\s/g, '').toUpperCase(); const d = (job.report.date || C.todayISO()).split('-'); job.report.ref = `${(C.settings.company.name || 'ER').replace(/[^A-Z]/gi, '').slice(0, 2).toUpperCase()}-${r}-${d[2]}${d[1]}${d[0].slice(2)}`; changed(); renderJob(); },
      useOem: () => { job.vehicle.oemKey = el.dataset.key; changed(); renderJob(); },
      label: () => {
        const j = job, ph = j.photos[+el.dataset.i]; if (!ph) return;
        Labeler.open(ph, (labels) => applyToJob(j, (x) => { const p = x.photos.find((q) => q.id === ph.id); if (p) { p.labels = labels; p.labelsReviewed = true; } }), openModal, closeModal);
      },
      pmove: () => { const i = +el.dataset.i, j2 = i + +el.dataset.d; if (j2 < 0 || j2 >= job.photos.length) return; const p = job.photos.splice(i, 1)[0]; job.photos.splice(j2, 0, p); changed(); renderJob(); },
      pdel: () => { if (!confirm('Remove this photo?')) return; job.photos.splice(+el.dataset.i, 1); changed(); renderJob(); },
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
      signToday: () => { job.assessor.dateSigned = C.todayISO(); changed(); renderJob(); },
      sigDraw: () => { const j = job; signaturePad(async (url) => { if (el.dataset.target === 'default') { C.settings.assessor.signature = url; await C.saveSettings(); renderSettings(); } else await applyToJob(j, (x) => { x.assessor.signature = url; }); }); },
      sigUpload: async () => { const j = job; const f = await pickFile('image/*'); if (!f) return; const r = await C.resizeDataURL(await C.readFileAsDataURL(f), 600, 0.92); if (el.dataset.target === 'default') { C.settings.assessor.signature = r.dataUrl; await C.saveSettings(); renderSettings(); } else await applyToJob(j, (x) => { x.assessor.signature = r.dataUrl; }); },
      sigClear: () => { job.assessor.signature = ''; changed(); renderJob(); },
      exportPdf, exportJson: () => saveText(JSON.stringify(job, null, 1), (job.report.ref || job.vehicle.reg || 'job').replace(/[^\w.-]+/g, '_') + '.json', 'json'),
      logoUpload: async () => {
        const f = await pickFile('image/*'); if (!f) return;
        const url = await logoDataUrl(f);
        if (!url) return toast('That file cannot be used as a logo. Use a PNG, JPEG, GIF, WebP or SVG image.', true);
        C.settings.company.logo = url; await C.saveSettings(); renderSettings();
      },
      logoClear: async () => { C.settings.company.logo = ''; await C.saveSettings(); renderSettings(); },
      aiSaveKey: async () => { const k = $('#aiKey').value.trim(); if (!k) return toast('Paste your API key first.', true); await desktop.ai.setKey(k); toast('API key saved.'); refreshAiState(); renderSettings(); },
      aiClearKey: async () => { await desktop.ai.setKey(''); toast('API key removed.'); refreshAiState(); renderSettings(); },
      aiTest: async () => {
        el.disabled = true; el.innerHTML = '<span class="spinner" style="border-color:#999;border-top-color:#333"></span>Testing…';
        let r; try { r = await desktop.ai.test({ model: (C.settings.ai || {}).model }); } finally { el.disabled = false; el.textContent = 'Test connection'; }
        r.ok ? toast('Connected: ' + r.result.model) : toast(r.error, true);
      },
      backup: async () => { const jobs = await C.Store.listJobs(); saveText(JSON.stringify({ kind: 'engineer-report-studio-backup', at: new Date().toISOString(), settings: C.settings, customOem: C.customOem, jobs }), `backup-${C.todayISO()}.json`, 'json'); },
      restore: async () => {
        const f = await pickFile('.json'); if (!f) return;
        let d;
        try { d = JSON.parse(await f.text()); if (!isObj(d) || d.kind !== 'engineer-report-studio-backup') throw new Error(); } catch (err) { return toast('That is not a backup file.', true); }
        const jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter(isObj);
        if (!confirm(`Restore ${jobs.length} job(s) and settings? Jobs with the same ID are overwritten.`)) return;
        // settings are stored as they are and re-read, so the current defaults fill anything an older version did not write (e.g. AI model)
        if (isObj(d.settings)) { await C.Store.set('settings', d.settings); await C.loadSettings(); }
        await saveCustomOem(Array.isArray(d.customOem) ? d.customOem : []);
        let n = 0, bad = 0;
        for (const j of jobs) { try { if (!j.id) j.id = C.uid(); migrate(j); await C.Store.saveJob(j); n++; } catch (err) { bad++; } }
        toast(`Backup restored: ${n} job(s)${bad ? `, ${bad} unreadable record(s) skipped` : ''} and settings.`, bad > 0); renderSettings();
      },
      catAddNo, catAddVeh, catImport,
      lookupVehicle, motByVin, applyVariant, paintMaterials, aiValuation,
      advAdd: () => { (job.valuation.adverts = job.valuation.adverts || []).push({ description: '', year: '', mileage: '', price: '', url: '' }); changed(); renderJob(); },
      advDel: () => { job.valuation.adverts.splice(+el.dataset.i, 1); changed(); renderJob(); },
      advFromAi: () => { const c = job.valuation.ai.comparables[+el.dataset.i]; (job.valuation.adverts = job.valuation.adverts || []).push({ description: c.description, year: c.year, mileage: c.mileage, price: c.price, url: c.url, source: c.source }); changed(); renderJob(); toast('Added to adverts.'); },
      inspByAssessor: () => { job.inspection.by = job.assessor.name; if (!job.inspection.byQualifications) job.inspection.byQualifications = job.assessor.qualifications || C.settings.assessor.qualifications || ''; changed(); renderJob(); },
      useSettingsRates: () => {
        if (job.issued && !confirm('This report has been finalised. Taking the current Settings rates changes its figures. Continue?')) return;
        job.rates = C.clone(C.settings.rates); job.vatPct = C.settings.vatPct; changed(); renderJob(); toast('Labour rates and VAT updated from Settings.');
      },
      finaliseReport: () => {
        const errs = C.qaChecks(job).filter((q) => q.level === 'error').length;
        if (!confirm(`${errs ? `The pre-issue checks still show ${errs} error${errs === 1 ? '' : 's'}.\n\n` : ''}Finalise this report? The company details, declaration, signature, qualifications and AQP ID are frozen in it as they are now.`)) return;
        const S = C.settings, a = job.assessor;
        job.issued = { at: new Date().toISOString(), company: C.clone(S.company), declaration: S.assessor.declaration, signature: liveSignature(job), qualifications: a.qualifications || S.assessor.qualifications || '', aqpId: a.aqpId || S.assessor.aqpId || '' };
        changed(); renderJob(); toast('Report finalised.');
      },
      reopenReport: () => { if (!confirm('Re-open this report? It will use the current Settings (company details, declaration and signature) until it is finalised again.')) return; delete job.issued; changed(); renderJob(); toast('Report re-opened.'); },
      reviewPendingDraft: () => { const d = pendingDrafts.get(job.id); if (d) reviewDraft(d, job.id); },
      aiValApply: () => { const r = job.valuation.ai; job.valuation.adopted = Math.round(num(r.recommended_pav)); job.valuation.comments = r.comments; changed(); renderJob(); toast('PAV and comments applied. Edit as needed.'); },
      saveDvla: async () => { const k = $('#kDvla').value.trim(); if (!k) return toast('Paste the DVLA key first.', true); await desktop.data.setKeys({ dvla: k }); toast('DVLA key saved.'); renderSettings(); },
      clearDvla: async () => { if (!confirm('Remove the saved DVLA key?')) return; await desktop.data.setKeys({ dvla: null }); renderSettings(); },
      saveMot: async () => {
        const tok = $('#kMotTokenUrl').value.trim();
        const patch = { motClientId: $('#kMotId').value.trim(), motClientSecret: $('#kMotSecret').value.trim(), motApiKey: $('#kMotKey').value.trim(), motScope: $('#kMotScope').value.trim() };
        if (tok) { if (/^https:\/\//i.test(tok)) patch.motTokenUrl = tok; else patch.motTenantId = tok; }
        Object.keys(patch).forEach((k) => { if (!patch[k]) delete patch[k]; });
        if (!Object.keys(patch).length) return toast('Enter the MOT credentials first.', true);
        if (patch.motTokenUrl && !/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/i.test(patch.motTokenUrl)) return toast('The token URL should look like https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token (copy it from the DVSA email).', true);
        await desktop.data.setKeys(patch); toast('MOT History credentials saved.'); renderSettings();
      },
      clearMot: async () => { if (!confirm('Remove the saved MOT History credentials?')) return; await desktop.data.setKeys({ motClientId: null, motClientSecret: null, motApiKey: null, motTokenUrl: null, motTenantId: null, motScope: null }); renderSettings(); },
      testDvla: async () => { const reg = $('#testReg').value.trim(); if (!reg) return toast('Enter a registration to test with.', true); const r = await desktop.data.dvla(reg, C.settings.dvlaEnv || 'live'); r.ok ? toast(`DVLA OK: ${r.result.make} ${r.result.colour} ${r.result.fuelType}${r.result.firstRegistration ? ', first registered ' + C.ukDate(r.result.firstRegistration) : ''}`) : toast(r.error, true); },
      testMot: async () => { const reg = $('#testReg').value.trim(); if (!reg) return toast('Enter a registration to test with.', true); const r = await desktop.data.mot(reg, 'registration'); r.ok ? toast(`MOT History OK: ${r.result.make} ${r.result.model}, ${r.result.tests.length} test(s)${r.result.tests[0] && r.result.tests[0].odometer ? ', latest ' + r.result.tests[0].odometer.toLocaleString('en-GB') + ' ' + r.result.tests[0].unit : ''}`) : toast(r.error, true); },
    };
    if (A[a]) { e.preventDefault(); try { await A[a](); } catch (err) { toast((err && err.message) || String(err), true); } }
  });

  async function refreshAiState() {
    const el = $('#aiState');
    if (!desktop) { el.innerHTML = '<span class="dot"></span>AI: desktop app only'; return; }
    aiStatus = await desktop.ai.status();
    el.innerHTML = `<span class="dot ${aiStatus.hasKey ? 'on' : 'off'}"></span>AI assessor ${aiStatus.hasKey ? 'ready' : '— add key in Settings'}`;
  }

  // ---------- boot ----------
  (async function boot() {
    await C.loadSettings();
    C.setCustomOem((await C.Store.get('customOem')) || []);
    refreshAiState();
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', () => { flushSave(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
    if (!location.hash) location.hash = '#/jobs';
    route();
  })();
})();
