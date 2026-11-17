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
  const ui = { pickQ: '', pickGroup: '', pickSide: '', pickOp: 'replace', pickSel: null, addRefinish: true, busy: false, suggestSel: {} };

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
  function openModal(title, content) {
    $('#modalTitle').textContent = title;
    const b = $('#modalBody'); b.innerHTML = '';
    if (typeof content === 'string') b.innerHTML = content; else b.appendChild(content);
    $('#modal').classList.remove('hidden');
    return b;
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
  $('#modal').addEventListener('click', (e) => { if (e.target.dataset.close != null || e.target.id === 'modal') closeModal(); });

  // ---------- saving ----------
  const saveSoon = C.debounce(async () => { if (job) { await C.Store.saveJob(job); const s = $('#savedState'); if (s) s.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB'); } }, 500);
  function changed() { const s = $('#savedState'); if (s) s.textContent = 'Saving…'; saveSoon(); updateHeader(); }

  // ---------- form helpers ----------
  function F(path, label, o) {
    o = o || {};
    const v = getPath(job, path);
    const val = v == null ? '' : v;
    let input;
    if (o.type === 'textarea') input = `<textarea data-bind="${path}" rows="${o.rows || 4}" placeholder="${esc(o.ph || '')}">${esc(val)}</textarea>`;
    else if (o.type === 'select') input = `<select data-bind="${path}">${o.options.map((x) => { const [k, t] = Array.isArray(x) ? x : [x, x || '—']; return `<option value="${esc(k)}"${String(k) === String(val) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else input = `<input data-bind="${path}" type="${o.type || 'text'}" value="${esc(val)}" placeholder="${esc(o.ph || '')}"${o.list ? ` list="${o.list}"` : ''}>`;
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
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    $$('.side nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] === 'job' ? 'jobs' : parts[0] || 'jobs')));
    if (parts[0] === 'new') {
      const j = C.newJob();
      await C.Store.saveJob(j);
      location.hash = `#/job/${j.id}/claim`;
      return;
    }
    if (parts[0] === 'job' && parts[1]) {
      if (!job || job.id !== parts[1]) {
        job = await C.Store.getJob(parts[1]);
        if (!job) { location.hash = '#/jobs'; return; }
        migrate(job);
      }
      tab = parts[2] || 'claim';
      renderJob();
      return;
    }
    job = null;
    if (parts[0] === 'settings') return renderSettings();
    if (parts[0] === 'catalogue') return renderCatalogue();
    return renderJobs();
  }
  function migrate(j) { // fill any fields added in later versions
    const blank = C.newJob();
    for (const k of Object.keys(blank)) {
      if (j[k] == null) j[k] = blank[k];
      else if (typeof blank[k] === 'object' && !Array.isArray(blank[k])) for (const kk of Object.keys(blank[k])) if (j[k][kk] == null) j[k][kk] = blank[k][kk];
    }
  }

  // ---------- JOBS LIST ----------
  async function renderJobs() {
    const jobs = (await C.Store.listJobs()).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    main.innerHTML = `<div class="wrap">
      <div class="row"><div class="grow"><h1>Assessments</h1><div class="sub">Each assessment produces a full engineering &amp; accident damage report.</div></div>
        <button class="btn" data-act="importJob">Import job file</button>
        <button class="btn" data-act="loadSample">Load sample job</button>
        <a class="btn primary" href="#/new">+ New assessment</a></div>
      <div class="card" style="padding:0">${jobs.length ? `<table class="tbl"><thead><tr><th>Registration</th><th>Vehicle</th><th>Report ref</th><th>Instructing party</th><th>Date of loss</th><th>Outcome</th><th class="num">Net repair</th><th class="num">PAV</th><th>Updated</th><th></th></tr></thead><tbody>
        ${jobs.map((j) => { const t = C.totals(j); return `<tr>
          <td><a href="#/job/${j.id}/claim"><span class="plate">${esc(j.vehicle.reg || 'NEW')}</span></a></td>
          <td>${esc([j.vehicle.make, j.vehicle.model, j.vehicle.derivative].filter(Boolean).join(' '))}</td>
          <td>${esc(j.report.ref)}</td><td>${esc(j.instruction.instructingParty)}</td><td>${esc(C.ukDate(j.instruction.dateOfLoss))}</td>
          <td>${j.outcome.decision ? `<span class="badge ${/total|ber|beyond/i.test(j.outcome.decision) ? 'err' : 'ok'}">${esc(j.outcome.decision.split('/')[0])}${j.outcome.category ? ' · Cat ' + j.outcome.category : ''}</span>` : ''}</td>
          <td class="num">${gbp(t.net)}</td><td class="num">${t.pav ? gbp(t.pav) : '—'}</td>
          <td class="hint">${j.updatedAt ? new Date(j.updatedAt).toLocaleString('en-GB') : ''}</td>
          <td class="row" style="flex-wrap:nowrap"><a class="btn sm" href="#/job/${j.id}/claim">Open</a><button class="btn sm" data-act="dupJob" data-id="${j.id}">Duplicate</button><button class="btn sm danger" data-act="delJob" data-id="${j.id}">Delete</button></td></tr>`; }).join('')}
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
      <div class="chip">PAV<b>${t.pav ? gbp(t.pav) : '—'}</b></div><div class="chip ${t.berSuggested ? 'ber' : ''}">Repair / PAV<b>${t.pav ? t.pctNet.toFixed(1) + '% net' : '—'}</b></div>`;
    const v = $('#hdVeh'); if (v) v.textContent = [job.vehicle.make, job.vehicle.model, job.vehicle.derivative].filter(Boolean).join(' ') || 'New assessment';
    const p = $('.jobhead .plate'); if (p) p.textContent = job.vehicle.reg || 'NEW';
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
    return `<div class="card"><div class="form">
      ${F('vehicle.reg', 'Registration')}${F('vehicle.vin', 'VIN / chassis number', { hint: vinHint(vin) })}
      ${F('vehicle.make', 'Make', { list: 'makes' })}${F('vehicle.model', 'Model')}
      ${F('vehicle.derivative', 'Derivative / trim')}${F('vehicle.body', 'Body type / number of doors')}
      ${F('vehicle.mileage', 'Mileage at inspection', { type: 'number' })}${F('vehicle.mileageUnit', 'Mileage unit', { type: 'select', options: ['miles', 'km'] })}
      ${F('vehicle.fuel', 'Fuel type', { type: 'select', options: ['', 'Petrol', 'Diesel', 'Hybrid', 'Plug-in hybrid', 'Electric', 'LPG'] })}${F('vehicle.transmission', 'Transmission', { type: 'select', options: ['', 'Manual', 'Automatic', 'Automatic / CVT', 'Automatic / DSG', 'Semi-automatic'] })}
      ${F('vehicle.engineSize', 'Engine size (cc)', { type: 'number' })}${F('vehicle.engineCode', 'Engine code')}
      ${F('vehicle.colour', 'Colour')}${F('vehicle.paintCode', 'Paint code')}
      ${F('vehicle.firstReg', 'First registration date', { type: 'date' })}
      ${F('vehicle.oemKey', 'Parts catalogue vehicle (for OEM part numbers)', { type: 'select', options: [['', '— none —']].concat(ov.map((v) => [v.key, `${v.make} ${v.model} ${v.generation} (${v.years})`])), hint: guess && guess.key !== job.vehicle.oemKey ? `Suggested: <button class="link" data-act="useOem" data-key="${guess.key}">${esc(guess.make + ' ' + guess.model + ' ' + guess.generation)}</button>` : 'Links estimate lines to researched OEM part numbers.' })}
      </div><datalist id="makes">${[...new Set(ov.map((v) => v.make).concat(['Audi', 'BMW', 'Citroën', 'Dacia', 'Fiat', 'Honda', 'Hyundai', 'Kia', 'Land Rover', 'Mazda', 'Mercedes-Benz', 'MG', 'MINI', 'Peugeot', 'Renault', 'SEAT', 'Škoda', 'Tesla', 'Toyota', 'Volvo']))].sort().map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>`;
  }
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
    return `<div class="card">
      <div class="row"><div class="grow"><h2 style="margin:0">Photographs</h2><div class="hint">Add inspection photos. Photos are resized for storage. Draw labels by hand, or let the AI assessor label them.</div></div>
        <button class="btn ai" data-act="aiAnalyse" ${!aiReady || !job.photos.length ? 'disabled' : ''}>${ui.busy === 'photos' ? '<span class="spinner"></span>Analysing…' : '✦ AI assess &amp; label photos'}</button></div>
      ${!aiReady ? '<p class="hint">AI tools are available in the desktop app (they need your API key in Settings).</p>' : ''}
      <div class="drop" id="drop" style="margin-top:12px">Drop photos here or <b>click to choose</b> (JPG / PNG / HEIC exported as JPG)</div>
      <input type="file" id="photoInput" accept="image/*" multiple hidden>
      <div class="pgrid">${job.photos.map((p, i) => photoCard(p, i)).join('')}</div>
    </div>
    ${f ? aiFindingsPanel(f) : ''}`;
  }
  function photoCard(p, i) {
    return `<div class="pcard ${p.exclude ? 'excluded' : ''}">
      <div class="pimg" data-act="label" data-i="${i}" title="Click to edit labels"><div class="pin"><img src="${p.dataUrl}" alt="">${Labeler.overlay(p.labels)}</div></div>
      <div class="pbody">
        <div class="row"><b>IMAGE ${String(i + 1).padStart(2, '0')}</b>${p.aiLabelled ? '<span class="badge ai">AI labelled</span>' : ''}<span class="grow"></span>
          <button class="btn sm" data-act="pmove" data-i="${i}" data-d="-1" title="Move earlier">↑</button><button class="btn sm" data-act="pmove" data-i="${i}" data-d="1" title="Move later">↓</button>
          <button class="btn sm danger" data-act="pdel" data-i="${i}" title="Remove">✕</button></div>
        <input data-pf="title" data-i="${i}" value="${esc(p.title)}" placeholder="Title, e.g. RH front door - surface damage">
        <textarea data-pf="caption" data-i="${i}" placeholder="Caption">${esc(p.caption)}</textarea>
        <div class="row"><input data-pf="source" data-i="${i}" value="${esc(p.source)}" placeholder="Source" class="grow" style="width:auto">
          <label class="hint"><input type="checkbox" data-pf="include" data-i="${i}" ${p.exclude ? '' : 'checked'} style="width:auto"> in report</label></div>
        <button class="btn sm" data-act="label" data-i="${i}">✎ Edit labels (${(p.labels || []).length})</button>
      </div></div>`;
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
      ${lines.map((l, i) => { const o = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side)[0] : null; const added = l.added; return `<tr${added ? ' style="opacity:.5"' : ''}>
        <td><input type="checkbox" data-sugg="${i}" style="width:auto" ${ui.suggestSel[i] === false || added ? '' : 'checked'} ${added ? 'disabled' : ''}></td>
        <td>${esc(l.type)}</td><td><b>${esc(l.description)}</b>${l.code && l.code !== 'OTHER' ? ` <code class="hint">${esc(l.code)}${l.side ? '-' + l.side : ''}</code>` : ''}${added ? ' <span class="badge ok">added</span>' : ''}</td>
        <td>${o ? `<span class="oem ${esc(o.confidence)}">${esc(o.oem)}</span>` : (l.needs_part ? '<span class="hint">price needed</span>' : '')}</td>
        <td class="num">${hrs(l.labour_hours)}</td><td class="reason">${esc(l.reason)}</td>
        <td><span class="conf" title="${Math.round(num(l.confidence) * 100)}%"><i style="width:${Math.round(num(l.confidence) * 100)}%"></i></span></td></tr>`; }).join('')}
      </tbody></table>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="aiAddLines">Add selected lines to estimate</button><span class="hint">They are added marked "AI" and need ticking as reviewed.</span></div></div>`;
  }

  async function addPhotos(files) {
    const list = Array.from(files).filter((f) => /^image\//.test(f.type));
    if (!list.length) return;
    toast(`Adding ${list.length} photo(s)…`);
    for (const f of list) {
      try {
        const raw = await C.readFileAsDataURL(f);
        const r = await C.resizeDataURL(raw, 1800, 0.86);
        job.photos.push({ id: C.uid(), dataUrl: r.dataUrl, w: r.width, h: r.height, title: '', caption: '', source: C.settings.company.name ? C.settings.company.name.replace(/ LTD$/i, '') : '', labels: [], fileName: f.name });
      } catch (e) { toast('Could not read ' + f.name, true); }
    }
    changed(); renderJob();
  }

  function slimJob() { // job data for the AI without heavy images
    const j = C.clone(Object.assign({}, job, { photos: [] }));
    j.photos = job.photos.map((p) => ({ title: p.title, caption: p.caption, labels: (p.labels || []).map((l) => ({ text: l.text })) }));
    return j;
  }

  async function aiAnalyse() {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    const photos = job.photos.map((p, i) => ({ p, i })).filter((x) => !x.p.exclude);
    if (!photos.length) return toast('Add photos first.', true);
    ui.busy = 'photos'; renderJob();
    try {
      const batches = [];
      for (let k = 0; k < photos.length; k += 10) batches.push(photos.slice(k, k + 10));
      const merged = { photos: [], summary: null, suggested_lines: [], model: '', at: new Date().toISOString() };
      for (let b = 0; b < batches.length; b++) {
        if (batches.length > 1) toast(`AI analysing batch ${b + 1} of ${batches.length}…`);
        const payload = [];
        for (const { p, i } of batches[b]) {
          const r = await C.resizeDataURL(p.dataUrl, 1568, 0.85);
          payload.push({ index: i + 1, mediaType: 'image/jpeg', base64: r.dataUrl.split(',')[1], title: p.title, caption: p.caption });
        }
        const res = await desktop.ai.analysePhotos({ job: slimJob(), photos: payload, model: C.settings.ai.model, effort: C.settings.ai.effort });
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
      // apply labels to photos
      for (const ph of merged.photos) {
        const p = job.photos[ph.index - 1];
        if (!p) continue;
        p.labels = (p.labels || []).filter((l) => !l.ai).concat((ph.damages || []).map((d) => ({
          x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h, text: d.label, ai: true, colour: d.severity === 'severe' ? '#ff3b30' : d.severity === 'moderate' ? '#ff9500' : '#ffcc00',
          detail: `${C.sideWord(d.side)} ${d.component_name} · ${d.damage_type} · ${d.severity} · accident-related: ${d.accident_related} · ${d.recommended_operation}${d.notes ? ' — ' + d.notes : ''}`.trim(),
          code: d.component_code, side: d.side
        })));
        p.aiLabelled = true;
        if (!p.title) p.title = ph.title;
        if (!p.caption) p.caption = ph.caption;
        p.aiTitle = ph.title; p.aiCaption = ph.caption;
      }
      job.aiFindings = merged;
      ui.suggestSel = {};
      changed();
      toast(`AI labelled ${merged.photos.length} photo(s) and suggested ${merged.suggested_lines.length} estimate line(s).`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      ui.busy = false; renderJob();
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
    (f.suggested_lines || []).forEach((l, i) => {
      if (l.added || ui.suggestSel[i] === false) return;
      const cands = l.code && C.CAT[l.code] ? C.oemLookup(job.vehicle.oemKey, l.code, l.side) : [];
      const o = cands[0];
      const cls = l.cost_class === 'paint' ? 'paint' : l.cost_class === 'other' ? 'other' : 'parts';
      job.lines.push(C.newLine({
        type: l.type, description: l.description, code: C.CAT[l.code] ? l.code : '', side: l.side, hours: l.labour_hours,
        partNo: l.needs_part && o ? o.oem : '', amount: l.needs_part && o && o.price ? o.price : 0, costClass: cls, ai: true, reviewed: false, source: l.reason
      }));
      l.added = true; n++;
    });
    changed(); toast(`${n} line(s) added to the estimate.`); renderJob();
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
      ${job.zones.length ? `<div class="row" style="margin:10px 0 2px"><span class="hint">Damage zones:</span>${job.zones.map((z) => `<button class="btn sm" data-act="zonePick" data-z="${esc(z)}">${esc(z)}</button>`).join('')}<button class="btn sm" data-act="zonePick" data-z="">All</button></div>` : ''}
      <div class="picker" style="margin-top:10px">
        <label class="fld"><span>Search part</span><input id="pickQ" value="${esc(ui.pickQ)}" placeholder="e.g. mirror, sill, bumper, door"></label>
        <label class="fld"><span>Group</span><select id="pickGroup"><option value="">All groups</option>${window.CATALOGUE_GROUPS.map((g) => `<option${g === ui.pickGroup ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <label class="fld"><span>Side</span><select id="pickSide"><option value="">—</option><option value="L"${ui.pickSide === 'L' ? ' selected' : ''}>LH</option><option value="R"${ui.pickSide === 'R' ? ' selected' : ''}>RH</option></select></label>
        <label class="fld"><span>Operation</span><select id="pickOp">${[['replace', 'Remove & replace'], ['repair', 'Repair / metal finish'], ['refinish', 'Prepare & refinish'], ['rr', 'Remove & refit'], ['check', 'Inspect / test'], ['refurb', 'Refurbish']].map(([k, v]) => `<option value="${k}"${k === ui.pickOp ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <button class="btn primary" data-act="pickAdd">Add line</button>
      </div>
      <label class="hint" style="display:inline-flex;gap:6px;margin-top:6px"><input type="checkbox" id="addRefinish" style="width:auto" ${ui.addRefinish ? 'checked' : ''}> When replacing or repairing a painted panel, also add its refinish line</label>
      <div class="results" id="pickResults">${pickResults()}</div>
      <h3>Labour-only operations</h3>
      <div class="row" style="gap:6px">${Object.values(C.OPS).map((o) => `<button class="btn sm" data-act="addOp" data-code="${o.code}" title="${o.type} · ${o.hours}h">${esc(o.name)}</button>`).join('')}</div>
    </div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl" id="linesTbl"><thead><tr><th>#</th><th>Type</th><th style="min-width:260px">Description</th><th>Part no. / ref</th><th class="num">Hours</th><th class="num">Rate £/h</th><th class="num">Labour £</th><th class="num">Parts / mat. £</th><th>Cost class</th><th>Review</th><th></th></tr></thead>
      <tbody>${job.lines.map(lineRow).join('') || '<tr><td colspan="11" class="empty">No lines yet. Add parts above, or use the AI suggestions from Photos &amp; AI.</td></tr>'}</tbody></table>
      <div class="row" style="padding:10px"><button class="btn sm" data-act="addBlank">+ Blank line</button><span class="grow"></span><label class="fld" style="width:160px"><span>Discount £</span><input data-bind="discount" type="number" step="0.01" value="${esc(job.discount)}"></label></div></div>
    <div class="card"><div class="totals" id="totalsBox">${totalsBox(t)}</div></div>
    <div class="card">${F('estimateNotes', 'Estimate notes', { type: 'textarea', rows: 6, full: true })}</div>`;
  }
  function totalsBox(t) {
    return `<div><span>Labour hours</span><b>${hrs(t.labourHours)}</b></div><div><span>Labour</span><b>${gbp(t.labour)}</b></div><div><span>Parts</span><b>${gbp(t.parts)}</b></div>
      <div><span>Paint materials</span><b>${gbp(t.paint)}</b></div><div><span>Other / services</span><b>${gbp(t.other)}</b></div><div><span>Net (excl. VAT)</span><b>${gbp(t.net)}</b></div>
      <div><span>VAT @ ${num(C.settings.vatPct)}%</span><b>${gbp(t.vat)}</b></div><div class="g"><span>Total repair cost</span><b>${gbp(t.gross)}</b></div>`;
  }
  function pickResults() {
    const q = ui.pickQ.toLowerCase().trim();
    let groups = null;
    if (ui.pickGroup) groups = [ui.pickGroup];
    if (ui.zoneGroups) groups = ui.zoneGroups;
    const rows = Object.values(C.CAT).filter((p) => (!groups || groups.includes(p.group)) && (!q || (p.name + ' ' + p.code + ' ' + p.group).toLowerCase().includes(q))).slice(0, 80);
    if (!rows.length) return '<div class="r hint">No matching parts.</div>';
    return rows.map((p) => {
      const sides = p.sided ? (ui.pickSide ? [ui.pickSide] : ['L', 'R']) : [''];
      const oems = sides.map((s) => { const c = C.oemLookup(job.vehicle.oemKey, p.code, s)[0]; return c ? `<span class="oem ${esc(c.confidence)}" title="${esc(c.description + ' — ' + c.confidence)}">${s ? C.sideWord(s) + ' ' : ''}${esc(c.oem)}${c.price ? ' · ' + gbp(c.price) : ''}</span>` : ''; }).filter(Boolean).join(' &nbsp; ');
      return `<div class="r${ui.pickSel === p.code ? ' sel' : ''}" data-act="pickSel" data-code="${p.code}"><code>${p.code}</code><div class="grow"><b>${esc(p.name)}</b> <span class="hint">· ${esc(p.group)}${p.sided ? ' · LH/RH' : ''}</span><div>${oems}</div></div>
        <span class="hint">R&amp;R ${p.replaceHrs}h${p.refinishHrs ? ' · paint ' + p.refinishHrs + 'h' : ''}</span></div>`;
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
      <td class="num" data-lv="${l.id}">${num(l.hours) ? gbp(num(l.hours) * rate) : '—'}</td>
      <td class="num" style="width:100px"><input data-lf="amount" data-id="${l.id}" type="number" step="0.01" value="${esc(l.amount)}"></td>
      <td style="min-width:128px"><select data-lf="costClass" data-id="${l.id}">${COST_CLASSES.map(([k, v]) => `<option value="${k}"${k === l.costClass ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
      <td>${l.ai ? `<label class="badge ${l.reviewed ? 'ok' : 'ai'}" style="cursor:pointer"><input type="checkbox" data-lf="reviewed" data-id="${l.id}" ${l.reviewed ? 'checked' : ''} style="width:auto;vertical-align:-2px"> AI ${l.reviewed ? 'reviewed' : 'suggested'}</label>` : ''}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-act="lmove" data-id="${l.id}" data-d="-1">↑</button><button class="btn sm" data-act="lmove" data-id="${l.id}" data-d="1">↓</button><button class="btn sm danger" data-act="ldel" data-id="${l.id}">✕</button></td></tr>`;
  }
  function addFromCatalogue() {
    const p = C.CAT[ui.pickSel];
    if (!p) return toast('Select a part in the list first.', true);
    let sides = [''];
    if (p.sided) {
      if (!ui.pickSide) return toast('Choose LH or RH for this part.', true);
      sides = [ui.pickSide];
    }
    for (const side of sides) {
      const sw = side ? C.sideWord(side) + ' ' : '';
      const nm = sw + p.name.charAt(0).toLowerCase() + p.name.slice(1);
      const Nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      const typeFor = ['M', 'W'].includes(p.kind) ? 'Mechanical' : ['E', 'A'].includes(p.kind) ? 'Electrical' : 'Body';
      const o = C.oemLookup(job.vehicle.oemKey, p.code, side)[0];
      const painted = p.refinishHrs > 0;
      switch (ui.pickOp) {
        case 'replace':
          job.lines.push(C.newLine({ type: typeFor, description: `${Nm} – remove & replace`, code: p.code, side, hours: p.replaceHrs, partNo: o ? o.oem : '', amount: o && o.price ? o.price : 0, costClass: 'parts' }));
          if (painted && ui.addRefinish) job.lines.push(C.newLine({ type: 'Painting', description: `${Nm} – prepare & refinish (new part)`, code: p.code, side, hours: p.refinishHrs, costClass: 'paint' }));
          break;
        case 'repair':
          job.lines.push(C.newLine({ type: 'Body', description: `${Nm} – repair / metal finish`, code: p.code, side, hours: C.OPS.OP001.hours, partNo: 'Existing panel', costClass: 'parts' }));
          if (painted && ui.addRefinish) job.lines.push(C.newLine({ type: 'Painting', description: `${Nm} – prepare & refinish`, code: p.code, side, hours: Math.max(0.8, Math.round(p.refinishHrs * 0.75 * 10) / 10), costClass: 'paint' }));
          break;
        case 'refinish':
          job.lines.push(C.newLine({ type: 'Painting', description: `${Nm} – prepare & refinish`, code: p.code, side, hours: p.refinishHrs || 1.0, costClass: 'paint' }));
          break;
        case 'rr':
          job.lines.push(C.newLine({ type: 'Auxiliary', description: `${Nm} – remove & refit`, code: p.code, side, hours: Math.max(0.1, Math.round(p.replaceHrs * 0.6 * 10) / 10), costClass: 'parts' }));
          break;
        case 'check':
          job.lines.push(C.newLine({ type: typeFor === 'Body' ? 'Auxiliary' : typeFor, description: `${Nm} – inspect / test`, code: p.code, side, hours: 0.3, costClass: 'parts' }));
          break;
        case 'refurb':
          job.lines.push(C.newLine({ type: 'Other', description: `${Nm} – refurbishment`, code: p.code, side, hours: 0, amount: 0, costClass: 'other' }));
          break;
      }
    }
    changed(); renderJob();
    toast('Line added.');
  }
  function oemPicker(lineId) {
    const l = job.lines.find((x) => x.id === lineId); if (!l) return;
    const cands = C.oemLookup(job.vehicle.oemKey, l.code, l.side);
    const b = openModal('OEM part numbers — ' + l.description, `<p class="hint">Researched numbers for this vehicle. Confirm against the VIN with a dealer parts counter before ordering. Versions often differ by facelift, trim and options.</p>
      <table class="tbl"><thead><tr><th>Part number</th><th>Description</th><th>Confidence</th><th class="num">Price</th><th>Notes</th><th></th></tr></thead><tbody>
      ${cands.map((c, i) => `<tr><td><b>${esc(c.oem)}</b></td><td>${esc(c.description)}</td><td><span class="badge ${c.confidence === 'confirmed' ? 'ok' : 'warn'}">${esc(c.confidence)}</span></td><td class="num">${c.price ? gbp(c.price) : '—'}</td>
        <td class="hint" style="max-width:380px">${esc(c.notes)}${c.source ? `<br><a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}</td><td><button class="btn sm primary" data-use="${i}">Use</button></td></tr>`).join('')}</tbody></table>`);
    b.addEventListener('click', (e) => {
      const i = e.target.dataset.use; if (i == null) return;
      const c = cands[+i]; l.partNo = c.oem; if (c.price) l.amount = c.price;
      changed(); closeModal(); renderJob();
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
        ${t.valMax ? `<span class="hint">Range ${gbp(t.valMin)} – ${gbp(t.valMax)} · average ${gbp(t.valAvg)}</span>
        <button class="btn sm" data-act="adopt" data-w="max">Adopt highest</button><button class="btn sm" data-act="adopt" data-w="avg">Adopt average</button><button class="btn sm" data-act="adopt" data-w="min">Adopt lowest</button>` : ''}</div>
      <div class="form3" style="margin-top:14px">${F('valuation.adopted', 'Assessed pre-accident value £', { type: 'number' })}${F('valuation.salvagePct', 'Salvage % of PAV', { type: 'number', hint: `= ${gbp(C.round2(t.pav * num(v.salvagePct) / 100))}` })}${F('valuation.salvageOverride', 'Salvage value override £ (e.g. actual bid)', { type: 'number' })}</div></div>
    <div class="card"><h2 style="margin-top:0">Economic repair &amp; outcome</h2>
      <div class="totals"><div><span>Net repair</span><b>${gbp(t.net)}</b></div><div><span>Gross repair</span><b>${gbp(t.gross)}</b></div><div><span>PAV</span><b>${t.pav ? gbp(t.pav) : '—'}</b></div>
        <div><span>Repair / PAV (net)</span><b>${t.pctNet.toFixed(2)}%</b></div><div><span>Repair / PAV (gross)</span><b>${t.pctGross.toFixed(2)}%</b></div><div><span>Salvage</span><b>${gbp(t.salvage)}</b></div></div>
      <p>${t.pav ? (t.berSuggested ? `<span class="badge err">Over threshold</span> Repair cost is at or above your ${C.settings.berThresholdPct}% (${C.settings.berBasis}) economic-repair threshold. Consider a total loss.` : `<span class="badge ok">Within threshold</span> Repair cost is below your ${C.settings.berThresholdPct}% (${C.settings.berBasis}) threshold.`) : '<span class="hint">Enter a PAV to see the economic repair position.</span>'}</p>
      <div class="form">${F('outcome.decision', 'Economic repair / total-loss assessment', { type: 'select', options: DECISIONS })}
        ${F('outcome.category', 'Salvage category (ABI Code of Practice)', { type: 'select', options: [['', 'Not assessed'], ['N', 'Category N — Non-Structural'], ['S', 'Category S — Structural']], hint: 'S: structural frame or chassis damaged. N: no structural damage. Categories A/B (break/crush only) are not offered here.' })}
        ${F('report.headline', 'Cover headline (optional override)', { ph: 'Auto: e.g. TOTAL LOSS RECOMMENDED' })}${F('report.subHeadline', 'Cover sub-headline (optional override)', { ph: 'Auto: e.g. CATEGORY N - RECOMMENDATION' })}
        ${F('valuation.comments', 'Valuation comments', { type: 'textarea', rows: 8, full: true, hint: '<button class="link" data-act="genValComments">Write from the figures</button> · use **bold** for emphasis' })}</div></div>`;
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
      <button class="btn ai" data-act="aiDraft" ${!desktop ? 'disabled' : ''}>${ui.busy === 'draft' ? '<span class="spinner"></span>Drafting…' : '✦ AI draft all narrative'}</button></div></div>
      <div class="card"><div class="form">
      ${F('report.summary', 'Section 01 — headline summary (use **bold** for key findings)', { type: 'textarea', rows: 6, full: true })}
      ${F('opinion', "Report comments / engineer's opinion", { type: 'textarea', rows: 18, full: true })}</div></div>`;
  }
  async function aiDraft() {
    if (!desktop) return toast('AI tools need the desktop app.', true);
    ui.busy = 'draft'; renderJob();
    try {
      const res = await desktop.ai.draftNarrative({ job: slimJob(), totals: C.totals(job), settings: { berThresholdPct: C.settings.berThresholdPct, berBasis: C.settings.berBasis }, model: C.settings.ai.model, effort: C.settings.ai.effort });
      if (!res.ok) throw new Error(res.error);
      reviewDraft(res.result);
    } catch (e) { toast(e.message, true); } finally { ui.busy = false; if (tab === 'opinion') renderJob(); }
  }
  function reviewDraft(d) {
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
    b.addEventListener('click', (e) => {
      if (e.target.dataset.sel) $$('input[data-apply]', b).forEach((c) => { c.checked = true; });
      if (e.target.dataset.go) {
        let n = 0;
        $$('input[data-apply]', b).forEach((c) => { if (c.checked) { const [k, path] = map[+c.dataset.apply]; setPath(job, path, d[k]); n++; } });
        changed(); closeModal(); renderJob(); toast(`${n} section(s) applied. Review them in the report preview.`);
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

  function tabSignoff() {
    const sig = job.assessor.signature || (job.assessor.useDefaultSignature ? C.settings.assessor.signature : '');
    return `<div class="card"><div class="form">
      ${F('assessor.name', 'Assessor name')}${F('assessor.title', 'Professional role / title')}
      ${F('assessor.dateSigned', 'Date signed', { type: 'date', hint: '<button class="link" data-act="signToday">Sign today</button>' })}<div></div></div>
      <h3>Signature</h3>
      ${sig ? `<img src="${sig}" style="max-height:80px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:4px">` : '<p class="hint">No signature.</p>'}
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="sigDraw" data-target="job">Draw signature</button><button class="btn sm" data-act="sigUpload" data-target="job">Upload image</button>
        ${job.assessor.signature ? '<button class="btn sm danger" data-act="sigClear">Remove this report\'s signature</button>' : ''}
        <label class="hint"><input type="checkbox" data-bind-check="assessor.useDefaultSignature" ${job.assessor.useDefaultSignature ? 'checked' : ''} style="width:auto"> use my default signature from Settings</label></div>
      <h3>Declaration</h3><p class="hint" style="white-space:pre-wrap">${esc(C.settings.assessor.declaration)}</p><p class="hint">Edit the declaration in Settings.</p></div>`;
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
    const html = Report.render(job, { mode: desktop ? 'pdf' : 'print' });
    const name = (job.report.ref || job.vehicle.reg || 'engineering-report').replace(/[^\w.-]+/g, '_');
    if (desktop) {
      const tpl = Report.pdfTemplates();
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
    if (desktop) { const r = await desktop.saveFile({ content, fileName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }); if (r.ok) toast('Saved ' + r.filePath); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = fileName; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function pickFile(accept) {
    return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });
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
  async function renderSettings() {
    if (desktop) aiStatus = await desktop.ai.status();
    const s = C.settings;
    main.innerHTML = `<div class="wrap"><h1>Settings</h1><div class="sub">Company details, rates and AI. These apply to every report.</div>
      <div class="card"><h2 style="margin-top:0">Company &amp; report branding</h2><div class="form">
        ${S('company.name', 'Company name')}${S('company.tradingName', 'Trading name / site')}${S('company.address', 'Address', { full: true })}
        ${S('company.companyNo', 'Company number')}${S('company.phone', 'Telephone')}${S('company.email', 'Email')}<div></div>
        ${S('company.coverTitle', 'Cover title')}${S('company.coverSubtitle', 'Cover subtitle')}${S('company.reportTitle', 'Page header title')}<div></div>
        ${S('company.navy', 'Heading colour', { type: 'color' })}${S('company.accent', 'Accent colour', { type: 'color' })}</div>
        <h3>Logo</h3><div class="row">${s.company.logo ? `<img src="${s.company.logo}" style="max-height:70px;background:#fff;border:1px solid var(--line);padding:4px;border-radius:6px">` : '<span class="hint">No logo uploaded.</span>'}
        <button class="btn sm" data-act="logoUpload">Upload logo</button>${s.company.logo ? '<button class="btn sm danger" data-act="logoClear">Remove</button>' : ''}</div></div>
      <div class="card"><h2 style="margin-top:0">Rates &amp; thresholds</h2><div class="form3">
        ${Object.keys(s.rates).map((k) => S('rates.' + k, `${k} labour rate £/h`, { type: 'number', step: '0.01' })).join('')}
        ${S('vatPct', 'VAT %', { type: 'number' })}${S('salvagePct', 'Default salvage % of PAV', { type: 'number' })}
        ${S('berThresholdPct', 'Economic repair threshold %', { type: 'number', hint: 'Repair cost as % of PAV at which a total loss is flagged.' })}${S('berBasis', 'Threshold based on', { type: 'select', options: [['net', 'Net (excl. VAT)'], ['gross', 'Gross (incl. VAT)']] })}</div></div>
      <div class="card aiPanel"><h2>✦ AI assessor</h2>
        ${desktop ? `<p>Status: ${aiStatus.hasKey ? '<span class="badge ok">API key set</span>' : '<span class="badge warn">No API key</span>'} ${aiStatus.encrypted ? '<span class="hint">Key is encrypted by your operating system and never stored in reports.</span>' : ''}</p>
        <div class="form"><label class="fld"><span>Anthropic API key</span><input type="password" id="aiKey" placeholder="${aiStatus.hasKey ? '•••••••••• (saved, enter a new key to replace)' : 'sk-ant-…'}"></label>
          <div class="row" style="align-items:end"><button class="btn primary" data-act="aiSaveKey">Save key</button><button class="btn" data-act="aiTest">Test connection</button>${aiStatus.hasKey ? '<button class="btn danger" data-act="aiClearKey">Remove key</button>' : ''}</div>
          ${S('ai.model', 'Model', { hint: 'Default: claude-opus-5-5 (Anthropic\'s current Opus model, with vision).' })}${S('ai.effort', 'Thoroughness (effort)', { type: 'select', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High (recommended)'], ['xhigh', 'Extra high'], ['max', 'Maximum (slowest)']] })}</div>
        <p class="hint">Get a key at console.anthropic.com. Photos and claim details are sent to Anthropic's API for analysis when you press an AI button, and only then. Check this fits your data-protection notices to clients.</p>`
        : '<p class="hint">AI features run in the desktop app (Windows .exe). In a browser the rest of the software works, but AI buttons are disabled.</p>'}</div>
      <div class="card"><h2 style="margin-top:0">Assessor defaults</h2><div class="form">
        ${S('assessor.name', 'Default assessor name')}${S('assessor.title', 'Default professional title')}
        ${S('assessor.declaration', 'Assessor declaration', { type: 'textarea', rows: 8, full: true })}</div>
        <h3>Default signature</h3><div class="row">${s.assessor.signature ? `<img src="${s.assessor.signature}" style="max-height:70px;background:#fff;border:1px solid var(--line);padding:4px">` : '<span class="hint">None.</span>'}
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
        <button class="btn" data-act="catAddVeh">+ Vehicle</button><button class="btn" data-act="catAddNo">+ Part number</button><button class="btn" data-act="catImport">Import CSV</button></div>
        ${v && v.notes ? `<p class="hint">${esc(v.notes)}</p>` : ''}
        <p class="hint"><span class="oem confirmed">■ confirmed</span> = 2+ independent sources or official listing · <span class="oem single-source">■ single-source</span> = verify before use · <span class="oem report">■ user</span> = added by you. Always confirm by VIN before ordering.</p></div>
      <div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Code</th><th>Part</th><th>Group</th><th class="num">Replace h</th><th class="num">Refinish h</th><th>OEM numbers (${v ? esc(v.make + ' ' + v.model) : '—'})</th></tr></thead><tbody>
      ${rows.map((p) => { const cells = v ? ['', 'L', 'R'].map((s) => (v.parts[p.code + '|' + s] || []).map((c) => `<div class="oem ${c.user ? 'report' : esc(c.confidence)}" title="${esc(c.description + ' · ' + c.notes)}">${s ? C.sideWord(s) + ': ' : ''}<b>${esc(c.oem)}</b>${c.price ? ' · ' + gbp(c.price) : ''}${c.source ? ` <a href="${esc(c.source)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`).join('')).join('') : ''; return `<tr><td><code>${p.code}</code></td><td>${esc(p.name)}${p.sided ? ' <span class="hint">LH/RH</span>' : ''}</td><td class="hint">${esc(p.group)}</td><td class="num">${p.replaceHrs}</td><td class="num">${p.refinishHrs || '—'}</td><td>${cells || '<span class="hint">—</span>'}</td></tr>`; }).join('')}
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
      <label class="fld"><span>Description</span><input id="nDesc"></label><label class="fld"><span>Price £ (optional)</span><input id="nPrice" type="number" step="0.01"></label>
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
      (cv.parts[k] = cv.parts[k] || []).unshift({ oem, description: $('#nDesc', b).value || C.CAT[$('#nCode', b).value].name, notes: $('#nNotes', b).value, price: num($('#nPrice', b).value) || null, source: '', confidence: 'confirmed', user: true });
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
  async function catImport() {
    const f = await pickFile('.csv,text/csv'); if (!f) return;
    const text = await f.text();
    const key = ui.catVeh || (C.oemVehicles()[0] || {}).key; const base = C.findOemVehicle(key);
    if (!base) return toast('Choose a vehicle first.', true);
    const list = C.clone(C.customOem);
    let cv = list.find((x) => x.key === key);
    if (!cv) { cv = { key, make: base.make, model: base.model, generation: base.generation, years: base.years, parts: {} }; list.push(cv); }
    let n = 0, bad = 0;
    text.split(/\r?\n/).slice(1).forEach((line) => {
      const c = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      if (c.length < 3 || !c[0]) return;
      const [code, side, oem, desc, price] = c;
      if (!C.CAT[code] || !oem) { bad++; return; }
      const k = code + '|' + (side || '').toUpperCase().replace('LH', 'L').replace('RH', 'R');
      (cv.parts[k] = cv.parts[k] || []).unshift({ oem, description: desc || C.CAT[code].name, notes: 'Imported from CSV', price: num(price) || null, source: '', confidence: 'confirmed', user: true });
      n++;
    });
    await saveCustomOem(list); renderCatalogue();
    toast(`Imported ${n} part number(s)${bad ? `, skipped ${bad} with unknown codes` : ''}. CSV columns: code,side,oem,description,price`);
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
      const f = $('#preview'); if (f) f.srcdoc = Report.render(job, { mode: 'preview' });
    }
  }

  main.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.bind && job) {
      setPath(job, t.dataset.bind, t.type === 'number' ? (t.value === '' ? '' : num(t.value)) : t.value);
      changed();
      if (t.dataset.bind === 'vehicle.vin') { const h = t.parentElement.querySelector('.hint'); if (h) h.innerHTML = vinHint(C.decodeVin(t.value)); }
      return;
    }
    if (t.dataset.sbind) {
      setPath(C.settings, t.dataset.sbind, t.type === 'number' ? num(t.value) : t.value);
      saveSettingsSoon();
      return;
    }
    if (t.dataset.pf && job) {
      const p = job.photos[+t.dataset.i];
      if (t.dataset.pf === 'include') p.exclude = !t.checked; else p[t.dataset.pf] = t.value;
      changed(); return;
    }
    if (t.dataset.lf && job) {
      const l = job.lines.find((x) => x.id === t.dataset.id); if (!l) return;
      const f = t.dataset.lf;
      if (f === 'reviewed') l.reviewed = t.checked;
      else if (['hours', 'amount'].includes(f)) l[f] = num(t.value);
      else if (f === 'rate') l.rate = t.value === '' ? '' : num(t.value);
      else l[f] = t.value;
      const lv = $(`[data-lv="${l.id}"]`); if (lv) { const r = C.lineRate(job, l); lv.textContent = num(l.hours) ? gbp(num(l.hours) * r) : '—'; }
      const tb = $('#totalsBox'); if (tb) tb.innerHTML = totalsBox(C.totals(job));
      changed();
      if (f === 'reviewed' || f === 'type') renderJob();
      return;
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
    if (t.id === 'pickGroup') { ui.pickGroup = t.value; ui.zoneGroups = null; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'pickSide') { ui.pickSide = t.value; $('#pickResults').innerHTML = pickResults(); return; }
    if (t.id === 'pickOp') { ui.pickOp = t.value; return; }
    if (t.id === 'addRefinish') { ui.addRefinish = t.checked; return; }
    if (t.id === 'catVeh') { ui.catVeh = t.value; renderCatalogue(); return; }
    if (t.dataset.sugg != null) { ui.suggestSel[+t.dataset.sugg] = t.checked; return; }
    if (t.dataset.act === 'suggAll') { $$('input[data-sugg]').forEach((c) => { if (!c.disabled) { c.checked = t.checked; ui.suggestSel[+c.dataset.sugg] = t.checked; } }); return; }
    if (t.dataset.bind && job && (t.tagName === 'SELECT' || t.type === 'date')) {
      if (['vehicle.oemKey', 'outcome.decision', 'outcome.category'].includes(t.dataset.bind)) renderJob();
    }
  });
  const saveSettingsSoon = C.debounce(() => C.saveSettings(), 400);

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
        try { const j = JSON.parse(await f.text()); if (!j.vehicle || !j.lines) throw new Error(); j.id = C.uid(); await C.Store.saveJob(j); location.hash = `#/job/${j.id}/claim`; } catch (err) { toast('That file is not a job file.', true); }
      },
      dupJob: async () => { const j = C.clone(await C.Store.getJob(el.dataset.id)); j.id = C.uid(); j.report.ref = (j.report.ref || '') + '-COPY'; j.createdAt = new Date().toISOString(); await C.Store.saveJob(j); renderJobs(); },
      delJob: async () => { if (!confirm('Delete this assessment permanently?')) return; await C.Store.deleteJob(el.dataset.id); renderJobs(); },
      genRef: () => { const r = (job.vehicle.reg || 'REG').replace(/\s/g, '').toUpperCase(); const d = (job.report.date || C.todayISO()).split('-'); job.report.ref = `${(C.settings.company.name || 'ER').replace(/[^A-Z]/gi, '').slice(0, 2).toUpperCase()}-${r}-${d[2]}${d[1]}${d[0].slice(2)}`; changed(); renderJob(); },
      useOem: () => { job.vehicle.oemKey = el.dataset.key; changed(); renderJob(); },
      label: () => { const i = +el.dataset.i; Labeler.open(job.photos[i], (labels) => { job.photos[i].labels = labels; changed(); renderJob(); }, openModal, closeModal); },
      pmove: () => { const i = +el.dataset.i, j2 = i + +el.dataset.d; if (j2 < 0 || j2 >= job.photos.length) return; const p = job.photos.splice(i, 1)[0]; job.photos.splice(j2, 0, p); changed(); renderJob(); },
      pdel: () => { if (!confirm('Remove this photo?')) return; job.photos.splice(+el.dataset.i, 1); changed(); renderJob(); },
      aiAnalyse, aiApplySummary, aiAddLines, aiDraft,
      zoneDel: () => { job.zones = job.zones.filter((x) => x !== el.dataset.z); changed(); renderJob(); },
      zonePick: () => { const z = Diagram.byLabel(el.dataset.z); ui.zoneGroups = z ? z.groups : null; ui.pickGroup = ''; if (z && z.side) ui.pickSide = z.side; renderJob(); },
      pickSel: () => { ui.pickSel = el.dataset.code; $$('#pickResults .r').forEach((r) => r.classList.toggle('sel', r.dataset.code === ui.pickSel)); if (e.detail === 2) addFromCatalogue(); },
      pickAdd: addFromCatalogue,
      addOp: () => { const o = C.OPS[el.dataset.code]; const cls = o.type === 'Painting' ? 'paint' : 'parts'; job.lines.push(C.newLine({ type: o.type, description: o.name, hours: o.hours, costClass: cls })); changed(); renderJob(); },
      addBlank: () => { job.lines.push(C.newLine()); changed(); renderJob(); },
      lmove: () => { const i = job.lines.findIndex((x) => x.id === el.dataset.id), j2 = i + +el.dataset.d; if (j2 < 0 || j2 >= job.lines.length) return; const l = job.lines.splice(i, 1)[0]; job.lines.splice(j2, 0, l); changed(); renderJob(); },
      ldel: () => { job.lines = job.lines.filter((x) => x.id !== el.dataset.id); changed(); renderJob(); },
      oemPick: () => oemPicker(el.dataset.id),
      vsAdd: () => { job.valuation.sources.push({ name: '', amount: '' }); changed(); renderJob(); },
      vsDel: () => { job.valuation.sources.splice(+el.dataset.i, 1); changed(); renderJob(); },
      adopt: () => { const t = C.totals(job); job.valuation.adopted = { max: t.valMax, min: t.valMin, avg: Math.round(t.valAvg) }[el.dataset.w]; changed(); renderJob(); },
      valMileage: () => { job.valuation.mileage = job.vehicle.mileage; changed(); renderJob(); },
      genValComments,
      signToday: () => { job.assessor.dateSigned = C.todayISO(); changed(); renderJob(); },
      sigDraw: () => signaturePad(async (url) => { if (el.dataset.target === 'default') { C.settings.assessor.signature = url; await C.saveSettings(); renderSettings(); } else { job.assessor.signature = url; changed(); renderJob(); } }),
      sigUpload: async () => { const f = await pickFile('image/*'); if (!f) return; const r = await C.resizeDataURL(await C.readFileAsDataURL(f), 600, 0.92); if (el.dataset.target === 'default') { C.settings.assessor.signature = r.dataUrl; await C.saveSettings(); renderSettings(); } else { job.assessor.signature = r.dataUrl; changed(); renderJob(); } },
      sigClear: () => { job.assessor.signature = ''; changed(); renderJob(); },
      exportPdf, exportJson: () => saveText(JSON.stringify(job, null, 1), (job.report.ref || job.vehicle.reg || 'job').replace(/[^\w.-]+/g, '_') + '.json', 'json'),
      logoUpload: async () => { const f = await pickFile('image/*'); if (!f) return; const raw = await C.readFileAsDataURL(f); const r = f.type === 'image/png' || f.type === 'image/svg+xml' ? { dataUrl: raw } : await C.resizeDataURL(raw, 900, 0.92); C.settings.company.logo = r.dataUrl; await C.saveSettings(); renderSettings(); },
      logoClear: async () => { C.settings.company.logo = ''; await C.saveSettings(); renderSettings(); },
      aiSaveKey: async () => { const k = $('#aiKey').value.trim(); if (!k) return toast('Paste your API key first.', true); await desktop.ai.setKey(k); toast('API key saved.'); refreshAiState(); renderSettings(); },
      aiClearKey: async () => { await desktop.ai.setKey(''); toast('API key removed.'); refreshAiState(); renderSettings(); },
      aiTest: async () => { el.disabled = true; el.innerHTML = '<span class="spinner" style="border-color:#999;border-top-color:#333"></span>Testing…'; const r = await desktop.ai.test({ model: C.settings.ai.model }); el.disabled = false; el.textContent = 'Test connection'; r.ok ? toast('Connected: ' + r.result.model) : toast(r.error, true); },
      backup: async () => { const jobs = await C.Store.listJobs(); saveText(JSON.stringify({ kind: 'engineer-report-studio-backup', at: new Date().toISOString(), settings: C.settings, customOem: C.customOem, jobs }), `backup-${C.todayISO()}.json`, 'json'); },
      restore: async () => {
        const f = await pickFile('.json'); if (!f) return;
        try {
          const d = JSON.parse(await f.text()); if (d.kind !== 'engineer-report-studio-backup') throw new Error();
          if (!confirm(`Restore ${d.jobs.length} job(s) and settings? Jobs with the same ID are overwritten.`)) return;
          for (const j of d.jobs) await C.Store.saveJob(j);
          C.settings = d.settings; await C.saveSettings(); await saveCustomOem(d.customOem || []);
          toast('Backup restored.'); renderSettings();
        } catch (err) { toast('That is not a backup file.', true); }
      },
      catAddNo, catAddVeh, catImport
    };
    if (A[a]) { e.preventDefault(); await A[a](); }
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
    if (!location.hash) location.hash = '#/jobs';
    route();
  })();
})();
