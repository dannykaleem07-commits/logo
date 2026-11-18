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
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const gbp = (n) => '£' + round2(num(n)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gbp0 = (n) => '£' + Math.round(num(n)).toLocaleString('en-GB');
  const hrs = (n) => num(n).toFixed(2);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const ukDate = (iso) => {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
  };
  const longDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
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

  // ---------- IndexedDB storage ----------
  const DB_NAME = 'engineer-report-studio';
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const Store = {
    async listJobs() { return tx('jobs', 'readonly', (s) => reqP(s.getAll())); },
    async getJob(id) { return tx('jobs', 'readonly', (s) => reqP(s.get(id))); },
    async saveJob(job) { job.updatedAt = new Date().toISOString(); return tx('jobs', 'readwrite', (s) => reqP(s.put(job))); },
    async deleteJob(id) { return tx('jobs', 'readwrite', (s) => reqP(s.delete(id))); },
    async get(key) { return tx('kv', 'readonly', (s) => reqP(s.get(key))); },
    async set(key, val) { return tx('kv', 'readwrite', (s) => reqP(s.put(val, key))); }
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
    CAT[r[0]] = { code: r[0], name: r[1], group: r[2], sided: !!r[3], replaceHrs: r[4], refinishHrs: r[5], kind: r[6] };
  });
  const OPS = {};
  (window.LABOUR_OPS || []).forEach((r) => { OPS[r[0]] = { code: r[0], name: r[1], type: r[2], hours: r[3] }; });
  // Our own guide-time adjustment by vehicle size (not manufacturer data)
  const SIZE_CLASSES = { small: ['Small (city / supermini)', 0.9], medium: ['Medium (hatch / saloon)', 1.0], large: ['Large (exec / estate / MPV)', 1.1], suv: ['SUV / 4x4', 1.15], premium: ['Large premium / luxury', 1.2], lcv: ['Van / LCV', 1.15] };
  const sizeFactor = (job) => ((SIZE_CLASSES[(job && job.vehicle && job.vehicle.sizeClass) || 'medium'] || [0, 1])[1]);
  const paintFactor = (job) => num((settings.paintTypeFactor || {})[(job && job.vehicle && job.vehicle.paintType) || 'metallic'] || 1);
  const sideWord = (s) => (s === 'R' ? 'RH' : s === 'L' ? 'LH' : '');

  // OEM lookups: window.OEM_VEHICLES = [{key, make, model, generation, years, parts:{ 'CODE|SIDE': {...} } }]
  let customOem = []; // user-added vehicles / numbers, persisted in kv 'customOem'
  function setCustomOem(list) { customOem = list || []; }
  function oemVehicles() {
    const base = (window.OEM_VEHICLES || []).map((v) => Object.assign({}, v, { parts: Object.assign({}, v.parts) }));
    for (const cv of customOem) {
      let v = base.find((x) => x.key === cv.key);
      if (!v) { v = { key: cv.key, make: cv.make, model: cv.model, generation: cv.generation || '', years: cv.years || '', notes: 'Added by user', parts: {} }; base.push(v); }
      for (const [k, list] of Object.entries(cv.parts || {})) v.parts[k] = list.concat(v.parts[k] || []);
    }
    return base;
  }
  function findOemVehicle(key) { return oemVehicles().find((v) => v.key === key); }
  function guessOemVehicle(vehicle) {
    const mk = (vehicle.make || '').toLowerCase().trim();
    const mdRaw = (vehicle.model || '').toLowerCase().trim();
    if (!mk || !mdRaw) return null;
    const md = mdRaw.replace(/\s*\(.*\)\s*$/, '');
    const gen = ((/\(([^)]+)\)/.exec(vehicle.model || '') || [])[1] || '').toLowerCase();
    const year = parseInt((vehicle.firstReg || '').slice(0, 4), 10);
    let cands = oemVehicles().filter((v) => v.make.toLowerCase() === mk && md.startsWith(v.model.toLowerCase()));
    if (gen) {
      // a generation code was chosen (e.g. "E-Class (W214)"): never fall back to a different generation
      cands = cands.filter((v) => { const g = (v.generation || '').toLowerCase(); return g && (g.includes(gen) || gen.includes(g.split(' ')[0])); });
      if (!cands.length) return null;
    }
    if (!year) return cands[0] || null;
    const inRange = cands.find((v) => {
      const m = /(\d{4})\D+(\d{4})/.exec(v.years || '');
      return m && year >= +m[1] && year <= +m[2];
    });
    return inRange || (gen ? cands[0] : null);
  }
  // Returns an array of candidate OEM entries (best first), or [].
  function oemLookup(vehicleKey, code, side) {
    const v = findOemVehicle(vehicleKey);
    if (!v) return [];
    return v.parts[code + '|' + (side || '')] || [];
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
    vin = (vin || '').toUpperCase().replace(/\s/g, '');
    const out = { valid: false, issues: [] };
    if (!vin) return out;
    if (vin.length !== 17) out.issues.push(`VIN has ${vin.length} characters (should be 17).`);
    if (/[IOQ]/.test(vin)) out.issues.push('VIN contains I, O or Q, which are not used in VINs.');
    out.manufacturer = WMI[vin.slice(0, 3)] || null;
    const yc = vin.charAt(9);
    const idx = VIN_YEAR.indexOf(yc);
    if (idx >= 0) out.yearCodes = [1980 + idx, 2010 + idx].filter((y) => y <= new Date().getFullYear() + 1);
    out.valid = out.issues.length === 0;
    return out;
  }

  // ---------- job model ----------
  function newJob() {
    const id = uid();
    const s = settings;
    return {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      report: { ref: '', date: todayISO(), version: '1.0', status: 'Draft', headline: '', subHeadline: '', cpr35: false, conflicts: 'I have no conflict of interest in relation to this matter.' },
      aiLog: [],
      instruction: {
        instructingParty: '', ownInsurer: '', ownRef: '', tpInsurer: '', tpRef: '', dateOfLoss: '', locationOfLoss: '',
        tpVehicle: '', tpReg: '', dateInstructed: todayISO(), fileRef: '',
        purpose: 'To undertake an engineering and accident-damage assessment of the claimant\'s vehicle, establish the nature and extent of the accident-related damage, assess structural condition, roadworthiness and associated mechanical concerns, determine an appropriate repair methodology and estimated repair costs, and consider the vehicle\'s pre-accident value and economic repair position.'
      },
      vehicle: {
        reg: '', vin: '', make: '', model: '', derivative: '', mileage: '', mileageUnit: 'miles', body: '', fuel: '', transmission: '',
        engineSize: '', engineCode: '', colour: '', paintCode: '', paintType: 'metallic', firstReg: '', oemKey: '',
        sizeClass: 'medium', variantKey: '', dvla: null, motHistory: [], motModel: ''
      },
      inspection: {
        date: todayISO(), time: '', location: '', type: 'Physical vehicle inspection / pre-strip engineering assessment',
        condition: '', dismantling: 'No dismantling undertaken. Assessment limited to damage visible and accessible with the vehicle in its assembled condition.',
        photos: 'Yes', diagnostic: '', roadTest: '', warningLamps: ''
      },
      circumstances: { providedBy: '', narrative: '', impactType: '', primaryArea: '', secondaryArea: '', direction: '', symptoms: '', liabilityNote: 'Legal liability is outside the scope of this engineering report.' },
      assessment: { structural: '', mechanical: '', wheels: '', geometry: '', diagnostics: '', roadworthiness: '' },
      zones: [],
      valuation: {
        date: '', mileage: '', costNew: '', condition: 'SATISFACTORY',
        sources: [{ name: "Glass's Guide", amount: '' }, { name: 'CAP HPI', amount: '' }, { name: 'AutoTrader', amount: '' }],
        adopted: '', salvagePct: s.salvagePct, salvageOverride: '', comments: '',
        adverts: [], historyNotes: '', optionsNotes: '', ai: null
      },
      outcome: { decision: '', category: '' },
      lines: [],
      discount: 0,
      estimateNotes: '',
      opinion: '',
      photos: [],
      aiFindings: null,
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
  function lineRate(job, line) {
    if (line.rate !== '' && line.rate != null) return num(line.rate);
    return num(settings.rates[line.type] != null ? settings.rates[line.type] : settings.rates.Body);
  }
  function totals(job) {
    const t = { labourHours: 0, labour: 0, parts: 0, paint: 0, other: 0, discount: num(job.discount) };
    for (const l of job.lines) {
      const h = num(l.hours);
      t.labourHours += h;
      t.labour += h * lineRate(job, l);
      const a = num(l.amount);
      if (l.costClass === 'paint') t.paint += a;
      else if (l.costClass === 'other') t.other += a;
      else t.parts += a;
    }
    Object.keys(t).forEach((k) => { t[k] = round2(t[k]); });
    t.net = round2(t.labour + t.parts + t.paint + t.other - t.discount);
    t.vat = round2(t.net * num(settings.vatPct) / 100);
    t.gross = round2(t.net + t.vat);
    const v = job.valuation;
    t.pav = num(v.adopted);
    t.salvage = v.salvageOverride !== '' && v.salvageOverride != null ? num(v.salvageOverride) : round2(t.pav * num(v.salvagePct) / 100);
    t.pctNet = t.pav ? round2(t.net / t.pav * 100) : 0;
    t.pctGross = t.pav ? round2(t.gross / t.pav * 100) : 0;
    const basisPct = settings.berBasis === 'gross' ? t.pctGross : t.pctNet;
    t.berSuggested = t.pav > 0 && basisPct >= num(settings.berThresholdPct);
    const vals = v.sources.map((x) => num(x.amount)).filter((x) => x > 0);
    t.valMin = vals.length ? Math.min(...vals) : 0;
    t.valMax = vals.length ? Math.max(...vals) : 0;
    t.valAvg = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    return t;
  }

  // ---------- QA checks (rule based, no AI needed) ----------
  function qaChecks(job) {
    const t = totals(job);
    const out = [];
    const add = (level, msg, tab) => out.push({ level, msg, tab });
    const v = job.vehicle;
    if (!v.reg) add('error', 'Registration is missing.', 'vehicle');
    if (!v.make || !v.model) add('error', 'Make / model is missing.', 'vehicle');
    const vin = decodeVin(v.vin);
    if (!v.vin) add('warn', 'VIN is missing.', 'vehicle');
    else vin.issues.forEach((i) => add('warn', i, 'vehicle'));
    if (vin.manufacturer && v.make && !vin.manufacturer.toLowerCase().includes(v.make.toLowerCase().split(' ')[0])) {
      add('warn', `VIN manufacturer code suggests ${vin.manufacturer}, but make is "${v.make}".`, 'vehicle');
    }
    if (!job.instruction.dateOfLoss) add('error', 'Date of loss is missing.', 'claim');
    if (job.instruction.dateOfLoss && job.inspection.date && job.inspection.date < job.instruction.dateOfLoss) add('error', 'Inspection date is before the date of loss.', 'inspection');
    if (!job.instruction.instructingParty) add('warn', 'Instructing party is missing.', 'claim');
    if (!job.photos.length) add('warn', 'No photographs attached.', 'photos');
    const unlabelled = job.photos.filter((p) => !p.title).length;
    if (unlabelled) add('info', `${unlabelled} photo(s) have no title.`, 'photos');
    if (!job.lines.length) add('warn', 'Repair estimate has no lines.', 'estimate');
    job.lines.forEach((l, i) => {
      if (!l.description) add('warn', `Estimate line ${i + 1} has no description.`, 'estimate');
      if (l.costClass === 'parts' && num(l.amount) > 0 && !l.partNo) add('info', `Line ${i + 1} (${l.description}) has a part cost but no part number.`, 'estimate');
      if (!num(l.hours) && !num(l.amount)) add('info', `Line ${i + 1} (${l.description || 'blank'}) has no hours and no cost.`, 'estimate');
      if (l.ai && !l.reviewed) add('warn', `Line ${i + 1} (${l.description}) was suggested by AI and has not been marked as reviewed.`, 'estimate');
    });
    const replaced = job.lines.filter((l) => l.code && CAT[l.code] && CAT[l.code].refinishHrs > 0 && /replace/i.test(l.description));
    replaced.forEach((l) => {
      const name = CAT[l.code].name.toLowerCase().split(' ')[0];
      const painted = job.lines.some((x) => x.type === 'Painting' && x.description.toLowerCase().includes(name));
      if (!painted) add('info', `"${l.description}" is a painted part being replaced, but no refinish line mentions it.`, 'estimate');
    });
    if (!t.pav) add('warn', 'No pre-accident value adopted.', 'valuation');
    if (t.pav && t.berSuggested && job.outcome.decision === 'Repair') add('warn', `Repair cost is ${t.pctNet}% (net) of PAV, at or above your ${settings.berThresholdPct}% threshold, but the decision is "Repair".`, 'valuation');
    if (t.pav && !t.berSuggested && /total|ber/i.test(job.outcome.decision)) add('info', `Decision is total loss, but repair cost is ${t.pctNet}% of PAV, below your ${settings.berThresholdPct}% threshold. Make sure the opinion explains why.`, 'opinion');
    if (job.outcome.category === 'S' && /no damage to a principal structural member|non-structural/i.test(job.assessment.structural)) add('warn', 'Category S selected, but the structural assessment text says non-structural.', 'assessment');
    if (job.outcome.category === 'N' && /structural damage (has been|was) (identified|found)/i.test(job.assessment.structural)) add('warn', 'Category N selected, but the structural text records structural damage.', 'assessment');
    if (!job.opinion) add('warn', "Engineer's opinion is empty.", 'opinion');
    // ---- engineer checks ----
    const has = (re) => job.lines.some((l) => re.test(l.description));
    const structural = job.lines.filter((l) => l.code && CAT[l.code] && CAT[l.code].kind === 'S' && !/inspect|check|measure/i.test(l.description));
    if (structural.length && job.outcome.category === 'N') add('error', `Category N selected, but structural parts are being repaired/renewed (${structural.map((l) => l.description).join('; ')}). Damage to a structural member rules out Category N.`, 'valuation');
    if (/structural damage|chassis leg|a-pillar|b-pillar|floor pan|inner wing/i.test(job.assessment.structural) && !/no (accident-related )?(deformation|damage)|not (been )?established|no definitive/i.test(job.assessment.structural) && job.outcome.category === 'N') add('warn', 'Structural text mentions structural members but Category N is selected. Check the categorisation.', 'assessment');
    if (job.outcome.category && !(job.assessor.aqpId || settings.assessor.aqpId)) add('warn', 'A salvage category is recommended but no AQP (Appropriately Qualified Person) ID is recorded. Add it in Settings → Assessor or on Sign-off.', 'signoff');
    if (settings.assessor.accreditationExpiry && settings.assessor.accreditationExpiry < todayISO()) add('error', 'Your recorded accreditation expiry date has passed. Update it in Settings.', 'signoff');
    if (/electric|hybrid|plug-in/i.test(v.fuel) && (structural.length || job.zones.some((z) => /under|sill/i.test(z)))) add('warn', 'Electric/hybrid vehicle with underbody, sill or structural involvement: assess the high-voltage battery under the ABI salvage code battery provisions and isolate before repair.', 'assessment');
    const srs = job.lines.filter((l) => l.code && CAT[l.code] && CAT[l.code].group === 'SRS / airbags');
    if (srs.length && !has(/diagnostic/i)) add('warn', 'SRS components are included but there is no diagnostic scan line.', 'estimate');
    const adasTriggers = job.lines.filter((l) => ['GL001', 'FE019', 'FE020', 'EL001', 'EL004', 'RE007', 'RE013', 'MR001', 'SU017', 'SU001', 'SU004', 'SU007', 'SU008'].includes(l.code) || /windscreen|radar|camera|sensor|geometry|track rod|steering rack/i.test(l.description));
    const hasCal = has(/calibrat|adas|aim|geometry|steering angle/i) || ['GL005', 'EL002', 'EL003', 'EL005', 'SU018', 'LT009', 'OP012'].some((c) => job.lines.some((l) => l.code === c || l.description.includes(OPS[c] ? OPS[c].name : '###')));
    if (adasTriggers.length && !hasCal) add('warn', `Work affects ADAS-related parts (${adasTriggers.slice(0, 3).map((l) => l.description).join('; ')}${adasTriggers.length > 3 ? '…' : ''}) but no calibration / geometry / post-repair check line is included.`, 'estimate');
    if (job.lines.length && !has(/pre-repair diagnostic|pre repair diagnostic|pre-repair scan/i)) add('info', 'No pre-repair diagnostic scan line. Most manufacturers require pre- and post-repair scans.', 'estimate');
    const renewedPainted = job.lines.filter((l) => l.code && CAT[l.code] && CAT[l.code].refinishHrs > 0 && /renew|replace/i.test(l.description));
    const painting = job.lines.filter((l) => l.type === 'Painting');
    if (renewedPainted.length && /metallic|pearl|three-stage/.test(v.paintType || '') && !has(/blend/i)) add('info', `Metallic/pearl colour with renewed painted panels and no blend lines. Consider blending adjacent panels for colour match.`, 'estimate');
    if (painting.length && !job.lines.some((l) => l.costClass === 'paint' && num(l.amount) > 0)) add('info', 'Refinish labour is included but no paint materials cost.', 'estimate');
    // ---- MOT mileage evidence (DVSA) ----
    const wantKm = /km/i.test(v.mileageUnit || '');
    const toUnit = (n, unit) => { const u = String(unit || '').toLowerCase(); if (u === 'km' && !wantKm) return n * 0.621371; if ((u === 'mi' || u === 'miles') && wantKm) return n * 1.609344; return n; };
    const unitWord = wantKm ? 'km' : 'miles';
    const fmt = (n) => Math.round(n).toLocaleString('en-GB');
    const readings = (v.motHistory || [])
      .filter((t) => num(t.odometer) > 0 && t.date && (!t.odometerResult || t.odometerResult === 'READ'))
      .map((t) => ({ date: String(t.date).slice(0, 10), miles: toUnit(num(t.odometer), t.unit) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const cutoff = job.instruction.dateOfLoss || job.inspection.date || '';
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
      const offRoad = /total|ber|beyond/i.test(job.outcome.decision) || /off the road|not .*(suitable|roadworthy)|unroadworthy|should not be (used|driven)/i.test(job.assessment.roadworthiness + ' ' + job.inspection.roadTest);
      add(offRoad ? 'warn' : 'info', `The vehicle was presented for an MOT AFTER the date of loss: ${after.map((r) => `${ukDate(r.date)} at ${fmt(r.miles)} ${unitWord}`).join('; ')}${since > 0 ? ` (${fmt(since)} ${unitWord} more than the inspection reading)` : ''}. ${offRoad ? 'The report treats it as off the road / a total loss: confirm whether it has been repaired or used, and address this in the opinion.' : 'Confirm the repair / usage history.'}`, 'vehicle');
    }
    if (/image|desktop|photo/i.test(job.inspection.type)) {
      if (job.photos.length < 8) add('warn', `Image-based assessment with only ${job.photos.length} photo(s). Desktop reports are commonly challenged on coverage: include all four corners, the damage close-up and in context, VIN plate and odometer.`, 'photos');
      if (!job.photos.some((p) => /odometer|mileage|cluster|dash/i.test(p.title + ' ' + p.caption))) add('info', 'No photo identified as the odometer / instrument cluster.', 'photos');
      if (!job.photos.some((p) => /vin|chassis/i.test(p.title + ' ' + p.caption))) add('info', 'No photo identified as the VIN plate.', 'photos');
    }
    if (job.report.cpr35) {
      if (!job.instruction.purpose) add('error', 'CPR 35 report: the substance of the instructions must be stated (Purpose of instruction).', 'claim');
      if (!(job.assessor.qualifications || settings.assessor.qualifications)) add('error', 'CPR 35 report: the expert\'s qualifications must be stated (Settings → Assessor).', 'signoff');
      if (!/range|alternative|other view|reasonable/i.test(job.opinion)) add('warn', 'CPR 35 report: where there is a range of opinion, summarise it and give reasons for your own view.', 'opinion');
    }
    if ((job.aiLog || []).length && !job.report.aiDisclosure) add('info', 'AI tools were used on this report. The report will include an AI-use statement (recommended by the Civil Justice Council, Oct 2026).', 'report');
    if (num(job.valuation.adopted) && t.valMax && num(job.valuation.adopted) < t.valMax && !/like-for-like|advert|deduct|condition/i.test(job.valuation.comments)) add('warn', `Adopted PAV (${gbp(job.valuation.adopted)}) is below the highest guide figure (${gbp(t.valMax)}). The ombudsman's starting point is the highest retail guide; explain any lower figure with vehicle-specific evidence.`, 'valuation');
    if (!job.assessor.name) add('error', 'Assessor name is missing.', 'signoff');
    if (!job.assessor.dateSigned) add('info', 'Report has not been dated / signed.', 'signoff');
    return out;
  }

  // ---------- image helpers ----------
  function readFileAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  async function resizeDataURL(dataUrl, maxEdge, quality) {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return { dataUrl: c.toDataURL('image/jpeg', quality || 0.85), width: w, height: h };
  }

  window.Core = {
    $, $$, uid, esc, num, round2, gbp, gbp0, hrs, todayISO, ukDate, longDate, getPath, setPath, debounce, clone,
    Store, DEFAULT_SETTINGS, loadSettings, saveSettings, get settings() { return settings; }, set settings(v) { settings = v; },
    CAT, OPS, sideWord, SIZE_CLASSES, sizeFactor, paintFactor, oemVehicles, setCustomOem, get customOem() { return customOem; }, findOemVehicle, guessOemVehicle, oemLookup, decodeVin,
    newJob, newLine, lineRate, totals, qaChecks, readFileAsDataURL, loadImage, resizeDataURL
  };
})();
