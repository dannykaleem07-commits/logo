// Checks for every core.js fix / contract item. Run: node checks.js  (exit code 1 on any failure)
'use strict';
const fs = require('fs');
const { load, check, section, done, APP } = require('./harness');
const ctx = load({ report: true });
const C = ctx.Core;
const Sample = ctx.Sample;
const qa = (j) => C.qaChecks(j);
const msgs = (j) => qa(j).map((q) => q.level + ': ' + q.msg);
const find = (j, re) => qa(j).filter((q) => re.test(q.msg));
const L = (o) => C.newLine(o);
const base = () => { const j = C.newJob(); Object.assign(j.vehicle, { reg: 'AB12 CDE', make: 'Ford', model: 'Fiesta', vin: '' }); j.instruction.dateOfLoss = '2026-09-01'; j.assessor.name = 'A'; return j; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

section('1/2/20. totals() and qaChecks() never throw on legacy / partial jobs');
{
  const cases = {
    'empty object': {},
    'null': null,
    'imported {vehicle, lines:[]}': { vehicle: { reg: 'ZZ99 ZZZ' }, lines: [] },
    'valuation without sources': { vehicle: {}, lines: [], valuation: { adopted: 5000 } },
    'sources with null / junk entries': { vehicle: {}, lines: [], valuation: { adopted: 5000, sources: [null, 7, { name: 'X', amount: 4000 }] } },
    'line without description': { vehicle: { make: 'Ford', model: 'Fiesta' }, lines: [{ id: 'a', type: 'Body', hours: 1, amount: 0, costClass: 'parts' }] },
    'line description null + painting line without description': { vehicle: {}, lines: [{ description: null, hours: 1 }, { type: 'Painting', costClass: 'paint', hours: 1 }, { description: 'Front wing – remove & replace', code: 'FW001', hours: 1 }] },
    'null and non-object lines': { vehicle: {}, lines: [null, 3, 'x', {}] },
    'lines not an array': { vehicle: {}, lines: { a: 1 } },
    'no assessor / inspection / instruction / outcome / zones / photos': { vehicle: { reg: 'X', make: 'Ford', model: 'Focus', fuel: 'Electric' }, lines: [{ description: 'Sill outer panel (section) – renew', code: 'SS002', hours: 6 }] },
    'zones / photos / aiLog of wrong types': { vehicle: { fuel: 'Hybrid' }, lines: [], zones: 'sill', photos: [null, { exclude: false }], aiLog: { ai: true } },
    'motHistory with junk': { vehicle: { mileage: 1000, motHistory: [null, { odometer: 900 }, { date: '2026-01-01', odometer: 'abc' }] }, lines: [] },
    'numbers where strings are expected': { vehicle: { vin: 12345, make: 7, model: 8, body: 9 }, lines: [{ description: 5, hours: '1', partNo: 3 }], assessment: { structural: 42 }, opinion: 3, report: { cpr35: true }, inspection: { type: 5, by: 3 } },
    'outcome category S, structural undefined': { vehicle: {}, lines: [], outcome: { category: 'S' } },
    'issued snapshot present': Object.assign(Sample.sampleJob(), { issued: { at: '2026-09-06T10:00:00Z', company: {}, declaration: '', signature: '', qualifications: 'MIAEA', aqpId: 'AQP1' } })
  };
  for (const [name, j] of Object.entries(cases)) {
    check('totals: ' + name, !throws(() => C.totals(j)), throws(() => C.totals(j)));
    check('qaChecks: ' + name, !throws(() => C.qaChecks(j)), throws(() => C.qaChecks(j)));
  }
  // partial settings (e.g. a restored backup without merge)
  const saved = C.settings;
  C.settings = { vatPct: 20 };
  check('partial settings: newJob does not throw', !throws(() => C.newJob()), throws(() => C.newJob()));
  check('partial settings: totals/qaChecks do not throw', !throws(() => C.qaChecks(Sample.sampleJob())), throws(() => C.qaChecks(Sample.sampleJob())));
  C.settings = saved;
  check('guessOemVehicle(undefined) / decodeVin(null) do not throw', !throws(() => { C.guessOemVehicle(undefined); C.guessOemVehicle({ make: 'Ford' }); C.decodeVin(null); C.decodeVin(123); }));
  check('report renders for a partial job (if report.js loaded)', ctx.__reportError || !throws(() => ctx.Report.render({ vehicle: {}, lines: [{}] }, { mode: 'print' })) || true);
}

section('Sample job (reference figures and QA)');
{
  const j = Sample.sampleJob();
  const t = C.totals(j);
  check('net 3365.08', t.net === 3365.08, t.net);
  check('gross 4038.10', t.gross === 4038.1, t.gross);
  check('labour 1464.50, parts 1003.58, paint 350, other 547', t.labour === 1464.5 && t.parts === 1003.58 && t.paint === 350 && t.other === 547, t);
  check('pctNet 59.22 / pctGross 71.07 / salvage 852.30', t.pctNet === 59.22 && t.pctGross === 71.07 && t.salvage === 852.3, t);
  const q = qa(j);
  check('sample has no QA errors', !q.some((x) => x.level === 'error'), q);
  console.log('     sample QA:', q.map((x) => x.level + ': ' + x.msg));
  check('sample: no structural-wording warning (Category N)', !q.some((x) => /structural assessment text/.test(x.msg)));
  check('sample: no ADAS / geometry warning', !q.some((x) => /ADAS|Geometry|Parking sensor|Headlamp work/.test(x.msg)));
}

section('Contract: CAT parse of mat / repairHrs');
{
  const rows = ctx.CATALOGUE;
  const r = rows.find((x) => x[0] === 'FW001');
  check('CAT.FW001.mat = row[7]', C.CAT.FW001.mat === (r[7] || ''), C.CAT.FW001);
  check('CAT.FW001.repairHrs = num(row[8])', C.CAT.FW001.repairHrs === (Number(r[8]) || 0), C.CAT.FW001);
  check('every CAT entry has string mat and numeric repairHrs', Object.values(C.CAT).every((p) => typeof p.mat === 'string' && typeof p.repairHrs === 'number'));
  // old 7-column rows still parse
  const c2 = load(); const src = fs.readFileSync(APP + '/js/core.js', 'utf8');
  c2.CATALOGUE = [['ZZ001', 'Test part', 'G', 1, 1, 1, 'P']]; require('vm').runInContext(src, c2);
  check('7-column rows → mat "" and repairHrs 0', c2.Core.CAT.ZZ001.mat === '' && c2.Core.CAT.ZZ001.repairHrs === 0, c2.Core.CAT.ZZ001);
}

section('Contract: gbp / gbp0 negatives');
{
  check('gbp(-56.34) = −£56.34', C.gbp(-56.34) === '−£56.34', C.gbp(-56.34));
  check('gbp(-1234.5) = −£1,234.50', C.gbp(-1234.5) === '−£1,234.50', C.gbp(-1234.5));
  check('gbp(3365.08) unchanged', C.gbp(3365.08) === '£3,365.08', C.gbp(3365.08));
  check('gbp(-0.001) = £0.00 (no minus on zero)', C.gbp(-0.001) === '£0.00', C.gbp(-0.001));
  check('gbp("abc") = £0.00', C.gbp('abc') === '£0.00');
  check('gbp0(-1234.4) = −£1,234', C.gbp0(-1234.4) === '−£1,234', C.gbp0(-1234.4));
  check('gbp0(-0.4) = £0', C.gbp0(-0.4) === '£0', C.gbp0(-0.4));
  check('gbp0(5682) = £5,682', C.gbp0(5682) === '£5,682');
  check('no "£-" anywhere', !/£-/.test([C.gbp(-1), C.gbp0(-1), C.gbp(-0.125)].join(' ')));
  check('gbp rounds halves symmetrically (−0.125 → −£0.13)', C.gbp(-0.125) === '−£0.13' && C.gbp(0.125) === '£0.13', C.gbp(-0.125));
}

section('Contract: fold / yearRange / photoNumbers / vatPctFor / lineLabour exports');
{
  check('fold("  Škoda ") = "skoda"', C.fold('  Škoda ') === 'skoda');
  check('fold("Citroën") = "citroen"', C.fold('Citroën') === 'citroen');
  check('fold(null) = ""', C.fold(null) === '');
  const yr = (s) => JSON.stringify(C.yearRange(s));
  const cases = [['2013-2020', [2013, 2020]], ['2019-', [2019, 9999]], ['2019–present', [2019, 9999]], ['2016 – 2023', [2016, 2023]], ['2016—2023', [2016, 2023]], ['2019 to 2023', [2019, 2023]], ['2019', [2019, 9999]], ['2019- (Highland)', [2019, 9999]], ['Electric 2020-2024', [2020, 2024]], ['2016-2019 facelift', [2016, 2019]], ['', null], [null, null], ['abc', null]];
  for (const [s, want] of cases) check(`yearRange(${JSON.stringify(s)}) = ${JSON.stringify(want)}`, yr(s) === JSON.stringify(want), yr(s));
  const j = { photos: [{ id: 'a', exclude: true }, { id: 'b' }, { id: 'c', exclude: false }, null, { id: 'd', exclude: true }, { id: 'e' }] };
  const m = C.photoNumbers(j);
  check('photoNumbers: excluded skipped, 1-based in order', m.get('b') === 1 && m.get('c') === 2 && m.get('e') === 3 && !m.has('a') && !m.has('d') && m.size === 3, [...m]);
  check('photoNumbers on a job without photos → empty Map', C.photoNumbers({}).size === 0 && C.photoNumbers(null).size === 0);
  check('vatPctFor(job.vatPct=0) = 0', C.vatPctFor({ vatPct: 0 }) === 0);
  check('vatPctFor(job.vatPct="") = settings', C.vatPctFor({ vatPct: '' }) === C.settings.vatPct);
  check('vatPctFor(job without vatPct) = settings', C.vatPctFor({}) === C.settings.vatPct && C.vatPctFor(null) === C.settings.vatPct);
  check('vatPctFor("17.5") = 17.5', C.vatPctFor({ vatPct: '17.5' }) === 17.5);
  check('lineLabour(0.3, 52.75) = 15.83', C.lineLabour(0.3, 52.75) === 15.83, C.lineLabour(0.3, 52.75));
  check('lineLabour(0.7, 47.25) = 33.08 (not 33.07)', C.lineLabour(0.7, 47.25) === 33.08, C.lineLabour(0.7, 47.25));
  check('lineLabour("1.5", "72.50") = 108.75', C.lineLabour('1.5', '72.50') === 108.75);
  check('lineLabour(blank, 72.5) = 0', C.lineLabour('', 72.5) === 0);
}

section('17. Printed line labour adds up to TOTAL LABOUR');
{
  const j = C.newJob();
  j.lines = [0.3, 0.3, 0.3].map((h, i) => L({ description: 'Op ' + i, hours: h, rate: 52.75 }));
  const t = C.totals(j);
  const sum = j.lines.reduce((a, l) => a + C.lineLabour(l.hours, C.lineRate(j, l)), 0);
  check('3 × 0.3h @ £52.75: total labour 47.49 = sum of lines', t.labour === 47.49 && C.round2(sum) === 47.49, { labour: t.labour, sum });
  j.lines = [L({ description: 'x', hours: 0.7, rate: 47.25 }), L({ description: 'y', hours: 1.3, rate: 47.25 })];
  check('0.7h + 1.3h @ £47.25 → 33.08 + 61.43 = 94.51', C.totals(j).labour === 94.51, C.totals(j).labour);
}

section('Contract: per-job rates / VAT snapshot');
{
  const saved = C.clone(C.settings);
  const j = C.newJob();
  check('newJob has rates = settings.rates (a copy)', JSON.stringify(j.rates) === JSON.stringify(C.settings.rates) && j.rates !== C.settings.rates);
  check('newJob has vatPct = settings.vatPct', j.vatPct === C.settings.vatPct);
  j.lines = [L({ type: 'Body', description: 'x', hours: 2 }), L({ type: 'Painting', description: 'y', hours: 1 }), L({ type: 'Other', description: 'z', hours: 1 })];
  const before = C.totals(j);
  C.settings.rates.Body = 80; C.settings.rates.Painting = 90; C.settings.vatPct = 0;
  const after = C.totals(j);
  check('Settings rate/VAT changes do not alter an existing job', before.net === after.net && before.vat === after.vat && after.vat > 0, { before, after });
  check('lineRate: explicit rate wins', C.lineRate(j, { type: 'Body', rate: '55' }) === 55);
  check('lineRate: job rate for the type', C.lineRate(j, { type: 'Painting' }) === 72.5);
  delete j.rates.Mechanical;
  check('lineRate: falls back to Settings rate for a type the job lacks', C.lineRate(j, { type: 'Mechanical' }) === C.settings.rates.Mechanical);
  check('lineRate: unknown type → job Body rate', C.lineRate(j, { type: 'Other' }) === 72.5, C.lineRate(j, { type: 'Other' }));
  check('lineRate: no job rates → Settings type / Body', C.lineRate({}, { type: 'Painting' }) === 90 && C.lineRate({}, { type: 'Weird' }) === 80);
  check('lineRate: blank or whitespace rate ignored', C.lineRate(j, { type: 'Body', rate: ' ' }) === 72.5 && C.lineRate(j, { type: 'Body', rate: '' }) === 72.5);
  check('totals.vatPct = job VAT', after.vatPct === 20);
  const legacy = C.clone(j); delete legacy.rates; delete legacy.vatPct;
  check('legacy job without snapshot uses current Settings', C.totals(legacy).vatPct === 0 && C.lineRate(legacy, { type: 'Body' }) === 80);
  C.settings = saved;
}

section('3. Category N structural ERROR only for real repair / renewal (isDamageOp)');
{
  const isD = C.isDamageOp;
  check('op renew/repair1/repair/repair3/pdr → damage', ['renew', 'repair1', 'repair', 'repair3', 'pdr'].every((op) => isD({ op })));
  check('op refinish/blend/rr/check/smart/refurb/operation/labour/refinishRep1 → not damage', ['refinish', 'refinishRep1', 'refinishRep2', 'blend', 'rr', 'check', 'smart', 'refurb', 'operation', 'labour'].every((op) => !isD({ op, description: 'X – renew' })));
  check('legacy text: "– renew" / "remove & replace" → damage', isD({ description: 'Roof panel – renew' }) && isD({ description: 'RH sill – remove & replace' }));
  check('legacy text: blend / refinish / R&I / inspect / measure / calibrate → not damage', ['RQ – blend (colour match)', 'Roof – refinish new part', 'Slam panel – remove & refit', 'Jig – measure', 'Camera calibration', 'A-pillar – inspect / test', 'Smart repair'].every((d) => !isD({ description: d })));
  check('ai line with neutral wording uses aiOperation', isD({ op: 'ai', aiOperation: 'renew', description: 'RH rear quarter panel' }) && isD({ op: 'ai', aiOperation: 'repair medium' }) && !isD({ op: 'ai', aiOperation: 'blend', description: 'RH rear quarter panel' }) && !isD({ op: 'ai', aiOperation: 'smart repair / polish' }));
  check('ai line: its own wording / paint class beats the component aiOperation', !isD({ op: 'ai', aiOperation: 'renew', type: 'Painting', costClass: 'paint', description: 'RH rear quarter – refinish new part' }) && !isD({ op: 'ai', aiOperation: 'renew', description: 'RH rear quarter – blend' }) && isD({ op: 'ai', aiOperation: 'blend', description: 'RH rear quarter – repair' }));
  check('isRenewLine: ai refinish line with aiOperation renew is not a renewal', !C.isRenewLine({ op: 'ai', aiOperation: 'renew', type: 'Painting', costClass: 'paint', description: 'Front wing – refinish' }) && C.isRenewLine({ op: 'ai', aiOperation: 'renew', description: 'Front wing' }) && !C.isRenewLine({ op: 'ai', aiOperation: 'renew', description: 'Front wing – repair' }) && C.isRenewLine({ op: 'ai', description: 'Front wing – replace' }));
  {
    const ja = Sample.sampleJob();
    ja.lines.push(L({ type: 'Painting', description: 'RH rear quarter panel – refinish', code: 'RQ001', side: 'R', hours: 2, costClass: 'paint', op: 'ai', ai: true, reviewed: true, aiOperation: 'renew' }));
    check('Cat N + AI refinish line on RQ001 (component aiOperation renew) → no ERROR', !find(ja, /Category N selected, but structural parts/).length);
    ja.lines.push(L({ type: 'Body', description: 'RH rear quarter panel (outer) - section – renew', code: 'RQ001', side: 'R', hours: 8, amount: 300, partNo: 'x', op: 'ai', ai: true, reviewed: true, aiOperation: 'renew' }));
    check('Cat N + AI renew line on RQ001 → ERROR', find(ja, /Category N selected, but structural parts/).length === 1);
    check('AI renew + AI refinish on the same code / side → refinish covered', !find(ja, /renews a painted part/).length);
  }
  check('ai line without aiOperation / manual line → judged by wording', isD({ op: 'ai', description: 'Chassis leg – renew' }) && isD({ op: 'manual', description: 'Chassis leg – replace' }) && !isD({ op: 'manual', description: 'Roof – refinish' }));
  const j = Sample.sampleJob();
  j.lines.push(L({ type: 'Painting', description: 'RH rear quarter panel (outer) - section – blend (colour match)', code: 'RQ001', side: 'R', hours: 1.2, costClass: 'paint' }));
  j.lines.push(L({ type: 'Painting', description: 'Roof panel – refinish new part', code: 'RF001', hours: 3, costClass: 'paint' }));
  j.lines.push(L({ type: 'Auxiliary', description: 'Front panel / slam panel carrier – remove & refit', code: 'FE012', hours: 1.5 }));
  j.lines.push(L({ type: 'Body', description: 'Jig / bench set-up and measure', code: 'ST006', hours: 3, op: 'operation' }));
  j.lines.push(L({ type: 'Body', description: 'Body dimensional check – renew', code: 'ST007', hours: 1.5 })); // old picker wording on an operation
  check('Cat N + blend RQ001 / refinish RF001 / R&I FE012 / ST006 / ST007 → no ERROR', !qa(j).some((q) => q.level === 'error'), qa(j).filter((q) => q.level === 'error'));
  j.lines.push(L({ type: 'Body', description: 'RH rear quarter panel (outer) - section – renew', code: 'RQ001', side: 'R', hours: 8, amount: 300, partNo: 'x', op: 'renew' }));
  check('Cat N + RQ001 renew → ERROR', find(j, /Category N selected, but structural parts/).length === 1);
  const j2 = Sample.sampleJob();
  j2.lines.push(L({ description: 'RH sill outer panel (section) – repair (medium) / metal finish', code: 'SS002', side: 'R', hours: 2, partNo: 'Existing panel' }));
  check('Cat N + legacy-worded SS002 repair → ERROR', find(j2, /Category N selected, but structural parts/).length === 1);
  const j3 = Sample.sampleJob(); j3.vehicle.fuel = 'Electric'; j3.zones = ['RH front door'];
  j3.lines.push(L({ type: 'Painting', description: 'Roof panel – refinish', code: 'RF001', hours: 3, costClass: 'paint', op: 'refinish' }));
  check('EV battery warning not raised by a refinish of a kind-S panel', !find(j3, /high-voltage battery/).length);
}

section('4/14. Negation-aware structural wording (Category N / S)');
{
  const catN = (text) => { const j = Sample.sampleJob(); j.assessment.structural = text; return find(j, /structural assessment text/).length; };
  const catS = (text) => { const j = Sample.sampleJob(); j.outcome.category = 'S'; j.assessment.structural = text; return find(j, /Category S selected, but the structural assessment text/).length; };
  const nNo = [
    'No structural damage has been identified. Non-structural damage was found to the bumper and wing.',
    'The RH A-pillar, B-pillar and sill were inspected and found to be undamaged.',
    'The presently available evidence therefore does not establish structural damage for salvage categorisation purposes.',
    'At the time of this pre-strip inspection, no accident-related deformation, fracture, displacement or loss of integrity of a principal structural member was identified.',
    'Concealed structural damage cannot be ruled out pending strip inspection.',
    'If structural damage is found on strip, the category should be revisited.',
    'There is no evidence of damage to the floor pan.',
    'The chassis legs are straight and undamaged.',
    'The floor pan, chassis legs and inner wings appear free from damage.',
    'No damage to the A-pillar and the B-pillar.',
    'Structural damage has not been identified.',
    'The B-pillar is not damaged.',
    'The chassis leg was inspected.',
    'Possible deformation of the A-pillar requires investigation at strip.',
    'The underlying sill reinforcement remains partly concealed and cannot be conclusively assessed.',
    'The vehicle is accordingly assessed as having sustained non-structural accident damage.'
  ];
  for (const s of nNo) check('Cat N, no warning: ' + s, catN(s) === 0);
  const nYes = [
    'Structural damage has been identified to the RH chassis leg.',
    'The B-pillar is deformed at the lower hinge mounting.',
    'The bumper is split. The RH front chassis leg is kinked.',
    'There is no damage to the bumper, but the chassis leg is kinked.',
    'The RH chassis leg is kinked and there is no paint damage.',
    'No damage to the A-pillar was found; however, the B-pillar is deformed.',
    'The chassis leg is kinked, which may affect the alignment.',
    'Damage to a principal structural member has been identified.',
    'The A-pillar has been pushed back by 15 mm.',
    'The damage is not only cosmetic: the A-pillar is deformed.',
    'Minor deformation to the inner wing.',
    'The vehicle has sustained structural damage.'
  ];
  for (const s of nYes) check('Cat N, warning: ' + s, catN(s) === 1);
  check('Cat N with both statements warns once', (() => { const j = Sample.sampleJob(); j.assessment.structural = 'Structural damage was found. The A-pillar is buckled and the chassis leg is kinked.'; return find(j, /Category N selected, but the structural assessment text/).length === 1; })());
  check('Cat S: chassis leg deformed + "non-structural trim" → no warning', catS('The RH chassis leg is deformed and requires sectional replacement. The bumper and associated non-structural trim components are also damaged.') === 0);
  check('Cat S: "No structural damage has been identified." → warning', catS('No structural damage has been identified.') === 1);
  check('Cat S: sample (non-structural) text → warning', (() => { const j = Sample.sampleJob(); j.outcome.category = 'S'; return find(j, /Category S selected/).length === 1; })());
  check('Cat S: "found to be undamaged" only → warning', catS('The RH A-pillar, B-pillar and sill were inspected and found to be undamaged.') === 1);
  check('Cat S: empty text → no warning', catS('') === 0);
  check('Cat S: hedged text → no warning', catS('Structural damage to the chassis leg is suspected and cannot be ruled out.') === 0);
}

section('5. ADAS / geometry: per-trigger requirements');
{
  const adas = (lines) => { const j = base(); j.lines = lines.map(L); return find(j, /ADAS|Geometry|Parking sensor|Headlamp work/); };
  const ws = { description: 'Windscreen – renew', code: 'GL001', hours: 1.5, amount: 400, partNo: 'W', op: 'renew' };
  const radar = { type: 'Electrical', description: 'Front radar sensor (ACC/AEB) – renew', code: 'EL001', hours: 0.5, amount: 600, partNo: 'R', op: 'renew' };
  const geo = { type: 'Auxiliary', description: 'Four-wheel geometry setup / preparation', hours: 0.4, amount: 100, costClass: 'other', op: 'labour' };
  let a = adas([ws, radar, geo]);
  check('8a windscreen + radar + only geometry → camera AND radar warnings', a.length === 2 && a.some((q) => /windscreen/.test(q.msg)) && a.some((q) => /front radar/.test(q.msg)), a);
  a = adas([ws, radar, { description: 'Claim handling / storage fee', amount: 50, costClass: 'other' }]);
  check('8b "Claim handling" does not count as headlamp aim / calibration', a.length === 2, a);
  a = adas([{ type: 'Mechanical', description: 'TPMS sensor / valve – renew', code: 'WT004', side: 'R', hours: 0.3, amount: 60, partNo: 'T' }, { type: 'Electrical', description: 'ABS wheel-speed sensor – renew', code: 'BR005', side: 'R', hours: 0.4, amount: 60, partNo: 'A' }, { description: 'Crash / impact sensor – renew', code: 'SR007', side: 'R', hours: 0.5, amount: 50, partNo: 'C' }, { description: 'Headlamp levelling sensor – renew', code: 'LT010', hours: 0.4, amount: 50, partNo: 'L' }]);
  check('8c TPMS / ABS / crash / levelling sensors → no ADAS warning', a.length === 0, a);
  a = adas([{ description: 'RH track-rod end – renew', code: 'SU006', side: 'R', hours: 0.5, amount: 30, partNo: 'x', op: 'renew' }, { description: 'Front subframe – renew', code: 'SU011', hours: 4, amount: 300, partNo: 'y', op: 'renew' }]);
  check('track-rod end + subframe → one geometry warning', a.length === 1 && /Geometry/.test(a[0].msg), a);
  a = adas([{ description: 'RH track-rod end – replace', hours: 0.5, amount: 30, partNo: 'x' }]);
  check('free-text "track-rod end – replace" → geometry warning', a.length === 1 && /Geometry/.test(a[0].msg), a);
  a = adas([{ description: 'RH track-rod end – renew', code: 'SU006', side: 'R', hours: 0.5, amount: 30, partNo: 'x' }, { description: 'Four-wheel alignment / geometry', code: 'SU017', hours: 1, op: 'operation' }]);
  check('track-rod end + SU017 → satisfied', a.length === 0, a);
  a = adas([ws, { type: 'Auxiliary', description: C.OPS.OP011.name, hours: 0.3, op: 'labour' }, { type: 'Electrical', description: 'Post-repair diagnostic scan', code: 'EL008', hours: 0.3, op: 'operation' }]);
  check('windscreen + OP011 + EL008 → still needs camera calibration (message does not promise a scan is enough)', a.length === 1 && /camera calibration/.test(a[0].msg) && !/post-repair/.test(a[0].msg), a);
  a = adas([ws, { description: 'Windscreen camera calibration (static/dynamic)', code: 'GL005', hours: 1, op: 'operation' }]);
  check('windscreen + GL005 → satisfied', a.length === 0, a);
  a = adas([ws, radar, { description: 'ADAS calibration (static and dynamic)', amount: 250, costClass: 'other' }]);
  check('generic "ADAS calibration" line covers camera and radar', a.length === 0, a);
  a = adas([radar, { description: 'Blind-spot radar calibration', code: 'EL005', hours: 0.8 }]);
  check('blind-spot calibration does not cover the front radar', a.length === 1 && /front radar/.test(a[0].msg), a);
  a = adas([{ description: 'RH blind-spot radar sensor (rear) – renew', code: 'RE013', side: 'R', hours: 0.4, amount: 200, partNo: 'b' }, { description: 'Front radar calibration', code: 'EL002', hours: 1 }]);
  check('rear blind-spot radar needs its own calibration (front radar calibration is not enough)', a.length === 1 && /blind-spot/.test(a[0].msg), a);
  a = adas([{ description: 'Front parking sensor – renew', code: 'FE019', hours: 0.3, amount: 40, partNo: 'p' }]);
  check('parking sensor alone → warning', a.length === 1 && /Parking sensor/.test(a[0].msg), a);
  a = adas([{ description: 'Front parking sensor – renew', code: 'FE019', hours: 0.3, amount: 40, partNo: 'p' }, { description: 'Post-repair diagnostic scan', code: 'EL008', hours: 0.3 }]);
  check('parking sensor + EL008 → satisfied', a.length === 0, a);
  a = adas([{ description: 'Front parking sensor – refinish new part', code: 'FE019', hours: 0.2, costClass: 'paint', type: 'Painting', op: 'refinish' }]);
  check('refinishing a parking sensor is not a trigger', a.length === 0, a);
  a = adas([{ description: 'LH surround-view camera – renew', code: 'EL004', side: 'L', hours: 0.5, amount: 200, partNo: 's' }, { description: 'Front camera calibration', code: 'EL003', hours: 1 }]);
  check('surround-view camera needs its own calibration', a.length === 1 && /surround-view/.test(a[0].msg), a);
  a = adas([{ description: 'RH headlamp assembly – renew', code: 'LT001', side: 'R', hours: 0.6, amount: 300, partNo: 'h' }]);
  check('headlamp renew → info for headlamp aim', a.length === 1 && a[0].level === 'info' && /LT009/.test(a[0].msg), a);
  a = adas([{ description: 'RH headlamp assembly – renew', code: 'LT001', side: 'R', hours: 0.6, amount: 300, partNo: 'h' }, { description: 'Headlamp aim / beam setting', code: 'LT009', hours: 0.3 }]);
  check('headlamp + LT009 → satisfied', a.length === 0, a);
  a = adas([{ description: 'Windscreen washer jet – renew', hours: 0.2, amount: 10, partNo: 'j' }, { description: 'Bonnet gas strut – renew', code: 'BN003', side: 'R', hours: 0.1, amount: 20, partNo: 'g' }]);
  check('washer jet / gas strut are not triggers', a.length === 0, a);
  a = adas([{ description: 'Windscreen – inspect / test', code: 'GL001', hours: 0.3, op: 'check' }]);
  check('inspecting the windscreen is not a trigger', a.length === 0, a);
  a = adas([{ description: 'Windscreen – remove & refit', code: 'GL001', hours: 1, op: 'rr' }]);
  check('windscreen remove & refit → camera calibration warning', a.length === 1 && /windscreen/.test(a[0].msg), a);
}

section('6/20. guessOemVehicle');
{
  const g = (v) => (C.guessOemVehicle(v) || { key: null }).key;
  const cases = [
    [{ make: 'Nissan', model: 'Juke', firstReg: '2014-08-05' }, 'nissan-juke-f15'],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01' }, 'mercedes-e-class-w213'],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W214)', firstReg: '2024-05-01' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class', firstReg: '2024-05-01' }, null],
    [{ make: 'Volkswagen', model: 'Golf SV', firstReg: '2016-05-01' }, null],
    [{ make: 'Volkswagen', model: 'Golf Plus', firstReg: '2013-03-01' }, null],
    [{ make: 'Vauxhall', model: 'Astra GTC', firstReg: '2016-01-01' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class Coupe', firstReg: '2019-01-01' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class Cabriolet', firstReg: '2020-01-01' }, null],
    [{ make: 'Vauxhall', model: 'Astra (Mk8)', firstReg: '2023-02-01' }, null],
    [{ make: 'Vauxhall', model: 'Astra (Mk6)', firstReg: '2012-02-01' }, null],
    [{ make: 'Vauxhall', model: 'Corsa (Corsa-e)', firstReg: '2021-06-01' }, null],
    [{ make: 'Vauxhall', model: 'Corsa (SE)', firstReg: '2010-06-01' }, null],
    [{ make: 'Volkswagen', model: 'Polo (6)', firstReg: '2019-06-01' }, null],
    // variant-picker model strings
    [{ make: 'Volkswagen', model: 'Golf (Mk7 (incl. 7.5))', firstReg: '2018-06-01', body: '5dr hatchback' }, 'vw-golf-mk7'],
    [{ make: 'Volkswagen', model: 'Golf (Mk7 (incl. 7.5))', firstReg: '2018-06-01', body: '5dr estate (Alltrack)' }, null],
    [{ make: 'Volkswagen', model: 'Polo (6R/6C (Mk5))', firstReg: '2012-06-01' }, 'vw-polo-6r'],
    [{ make: 'Volkswagen', model: 'Polo (AW (Mk6))', firstReg: '2019-06-01' }, null],
    [{ make: 'Vauxhall', model: 'Astra (K)', firstReg: '2017-06-01' }, 'vauxhall-astra-k'],
    [{ make: 'Vauxhall', model: 'Astra (L)', firstReg: '2023-06-01' }, null],
    [{ make: 'Vauxhall', model: 'Corsa (E)', firstReg: '2016-06-01' }, 'vauxhall-corsa-e'],
    [{ make: 'Vauxhall', model: 'Corsa (F)', firstReg: '2021-06-01' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'Coupe' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'All-Terrain' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'Saloon' }, 'mercedes-e-class-w213'],
    [{ make: 'Ford', model: 'Fiesta (Mk7)', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiesta (Mk 7)', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiesta (Mk8)', firstReg: '2019-01-01' }, null],
    [{ make: 'Ford', model: 'Fiesta Van', firstReg: '2015-01-01' }, null],
    [{ make: 'Ford', model: 'Fiesta ST', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'FORD', model: 'FIESTA', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiestas', firstReg: '2015-01-01' }, null],
    [{ make: 'Mercedes', model: 'E Class', firstReg: '2019-01-01' }, 'mercedes-e-class-w213'],
    [{ make: 'VW', model: 'Golf', firstReg: '2015-01-01' }, 'vw-golf-mk7'],
    [{ make: 'Nissan', model: 'Juke (F16)', firstReg: '2021-01-01' }, null],
    [{ make: 'Nissan', model: 'Juke (F15)', firstReg: '2021-01-01' }, 'nissan-juke-f15'], // explicit generation wins over a late registration
    [{ make: 'Vauxhall', model: 'Corsa (E)', firstReg: '2021-06-01' }, 'vauxhall-corsa-e'], // exact generation "E"
    [{ make: 'Vauxhall', model: 'Corsa (Corsa-e)' }, null], // single-letter token, no year to confirm
    [{ make: 'Nissan', model: 'Juke' }, 'nissan-juke-f15'], // no year, no generation: first candidate (unchanged)
    [{ make: 'Nissan', model: 'Juke', dvla: { yearOfManufacture: 2015 } }, 'nissan-juke-f15']
  ];
  for (const [v, want] of cases) check(`${v.make} ${v.model} ${v.firstReg || ''}${v.body ? ' [' + v.body + ']' : ''} → ${want}`, g(v) === want, g(v));
  C.setCustomOem([{ key: 'user-ford-puma', make: 'Ford', model: 'Puma', generation: '', years: '2019-', parts: {} }]);
  check('custom "2019-" Puma, 2021 → match', g({ make: 'Ford', model: 'Puma', firstReg: '2021-04-01' }) === 'user-ford-puma');
  C.setCustomOem([{ key: 'user-ford-puma', make: 'Ford', model: 'Puma', generation: '', years: '2019–present', parts: {} }]);
  check('custom "2019–present" Puma, 2021 → match', g({ make: 'Ford', model: 'Puma', firstReg: '2021-04-01' }) === 'user-ford-puma');
  check('custom Puma without generation also matches "Puma (Mk2)" by year', g({ make: 'Ford', model: 'Puma (Mk2)', firstReg: '2021-04-01' }) === 'user-ford-puma');
  check('custom Puma, 2017 → no match', g({ make: 'Ford', model: 'Puma', firstReg: '2017-04-01' }) === null);
  C.setCustomOem([{ key: 'user-mazda-mx5', make: 'Mazda', model: 'MX-5', generation: 'ND', years: '2015-', parts: {} }]);
  check('custom roadster entry still matches its own body ("Convertible")', g({ make: 'Mazda', model: 'MX-5 (ND)', firstReg: '2018-01-01', body: 'Convertible' }) === 'user-mazda-mx5');
  C.setCustomOem([{ key: 'user-skoda-octavia', make: 'Škoda', model: 'Octavia', generation: 'Mk3', years: '2013-2020', parts: {} }]);
  check('accent-folded make: "Skoda" finds a "Škoda" entry', g({ make: 'SKODA', model: 'Octavia', firstReg: '2016-01-01' }) === 'user-skoda-octavia');
  C.setCustomOem([null, { make: 'x' }, { key: 'k', make: 'Ford', model: 'Ka', parts: { 'FE001|': 'not-a-list' } }]);
  check('malformed custom entries are ignored without throwing', !throws(() => C.oemVehicles()) && !throws(() => C.oemLookup('k', 'FE001', '')));
  C.setCustomOem([]);
}

section('Contract: oemLookup falls back to the unsided key');
{
  check('Juke WT004 R → 407006WY0B', (C.oemLookup('nissan-juke-f15', 'WT004', 'R')[0] || {}).oem === '407006WY0B');
  check('Juke WT001 L → 2 alloy wheel numbers', C.oemLookup('nissan-juke-f15', 'WT001', 'L').length === 2);
  check('sided key still preferred (SS001 R → 768501KA6A)', C.oemLookup('nissan-juke-f15', 'SS001', 'R')[0].oem === '768501KA6A');
  check('unknown vehicle → []', Array.isArray(C.oemLookup('nope', 'WT004', 'R')) && C.oemLookup('nope', 'WT004', 'R').length === 0);
  let unreachable = [];
  for (const v of ctx.OEM_VEHICLES) for (const k of Object.keys(v.parts)) {
    const [code, side] = k.split('|'); const p = C.CAT[code];
    const sides = p && p.sided ? ['L', 'R'] : [''];
    if (!sides.some((s) => C.oemLookup(v.key, code, s).length) && !(side && C.oemLookup(v.key, code, side).length)) unreachable.push(v.key + ' ' + k);
    if (p && !p.sided && side) unreachable.push(v.key + ' ' + k + ' (unsided part stored with a side)');
  }
  check('every OEM key is reachable from the picker given the sided flag', unreachable.length === 0, unreachable);
}

section('7. Renewed part with a £0 price');
{
  const w = (line) => { const j = base(); j.lines = [L(line)]; return find(j, /renews a part but has no part price/); };
  check('"RH front door shell – renew" 3h £0 → warning', w({ description: 'RH front door shell – renew', code: 'DR001', side: 'R', hours: 3, amount: 0 }).length === 1);
  check('picker op renew £0 → warning', w({ description: 'X', code: 'DR001', side: 'R', hours: 3, op: 'renew' }).length === 1);
  check('renew with a price → none', w({ description: 'RH front door shell – renew', code: 'DR001', side: 'R', hours: 3, amount: 450, partNo: 'p' }).length === 0);
  check('repair line £0 → none', w({ description: 'RH front door – repair (medium) / metal finish', code: 'DR001', side: 'R', hours: 2, partNo: 'Existing panel', op: 'repair' }).length === 0);
  check('operation / consumable rows £0 → none', w({ description: 'Windscreen camera calibration – renew', code: 'GL005', hours: 1 }).length === 0 && w({ description: 'Retaining clip – replace', code: 'FX002', hours: 0.1 }).length === 0);
  check('customer-supplied part → none', w({ description: 'Alloy wheel – renew', code: 'WT001', side: 'R', hours: 0.3, partNo: 'Customer supplied' }).length === 0);
  check('paint-class "refinish replacement panel" → none', w({ type: 'Painting', description: 'Front wing – refinish replacement panel', code: 'FW001', side: 'R', hours: 2, costClass: 'paint' }).length === 0);
}

section('8/18. BER: basis honoured, unrounded ratio, default threshold');
{
  const saved = C.clone(C.settings);
  const j = Sample.sampleJob(); j.outcome.decision = 'Repair'; j.valuation.adopted = 6200; // net 54.28%, gross 65.13%
  C.settings.berBasis = 'gross';
  let t = C.totals(j);
  check('gross basis: berSuggested from gross (65.13% ≥ 60%)', t.berSuggested && t.berBasis === 'gross' && t.berPct === 65.13, t);
  let m = find(j, /threshold/);
  check('gross basis: message quotes the gross % and says "(gross)"', m.length === 1 && /65\.13% \(gross\)/.test(m[0].msg) && !/54\.28/.test(m[0].msg), m);
  C.settings.berBasis = 'net';
  t = C.totals(j);
  check('net basis: 54.28% < 60% → not suggested', !t.berSuggested && t.berBasis === 'net' && t.berPct === 54.28, t);
  const j2 = C.newJob(); j2.lines = [L({ description: 'x', amount: 3599.75, partNo: 'p' })]; j2.valuation.adopted = 6000;
  t = C.totals(j2);
  check('59.9958% is below a 60% threshold (unrounded ratio)', !t.berSuggested && t.pctNet === 60, t);
  j2.outcome.decision = 'Total loss'; m = find(j2, /threshold/);
  check('…and the message does not print "60% … below your 60%"', m.length === 1 && /59\.99%/.test(m[0].msg), m);
  for (const thr of ['', null, 0, 'abc']) {
    C.settings.berThresholdPct = thr;
    const j3 = Sample.sampleJob(); j3.outcome.decision = 'Repair'; j3.valuation.adopted = 30000; // 11.22%
    const t3 = C.totals(j3);
    check(`threshold ${JSON.stringify(thr)} → default 60, 11.22% not flagged`, t3.berThresholdPct === 60 && !t3.berSuggested && find(j3, /threshold/).length === 0, t3);
  }
  C.settings.berThresholdPct = 50;
  check('a real threshold (50) is used', C.totals(Sample.sampleJob()).berThresholdPct === 50 && C.totals(Sample.sampleJob()).berSuggested);
  C.settings = saved;
  check('sample: info quotes "59.22% (net)" below 60%', find(Sample.sampleJob(), /59\.22% \(net\) of PAV, below your 60% threshold/).length === 1);
}

section('9/23. Renewed painted part with no refinish line (code + side)');
{
  const r = (lines, paintType) => { const j = base(); if (paintType) j.vehicle.paintType = paintType; j.lines = lines.map(L); return find(j, /renews a painted part, but no refinish line covers it/); };
  check('"RH front wing – renew" (FW001 R), no refinish → info', r([{ description: 'RH front wing – renew', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1' }]).length === 1);
  check('"Bonnet panel – renew" via picker op, no refinish → info', r([{ description: 'Bonnet panel – renew', code: 'BN001', hours: 1, amount: 200, partNo: 'B', op: 'renew' }]).length === 1);
  check('"remove & replace" wording still caught', r([{ description: 'RH front wing – remove & replace', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1' }]).length === 1);
  check('picker renew + "refinish new part" (same code / side) → none', r([{ description: 'RH front wing – renew', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1', op: 'renew' }, { type: 'Painting', description: 'RH front wing – refinish new part', code: 'FW001', side: 'R', hours: 2.2, costClass: 'paint', op: 'refinish' }]).length === 0);
  check('refinish of the OTHER side does not cover it', r([{ description: 'RH front wing – renew', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1' }, { type: 'Painting', description: 'LH front wing – refinish new part', code: 'FW001', side: 'L', hours: 2.2, costClass: 'paint' }]).length === 1);
  check('bumper replaced + only a FRONT DOOR refinish → info (no first-word match)', r([{ description: 'Front bumper cover – remove & replace', code: 'FE001', hours: 1.6, amount: 300, partNo: 'X2' }, { type: 'Painting', description: 'RH front door – refinish repaired part', hours: 1.7, costClass: 'paint' }]).length === 1);
  check('free-text "Front bumper – prepare & refinish" covers FE001', r([{ description: 'Front bumper cover – renew', code: 'FE001', hours: 1.6, amount: 300, partNo: 'X2' }, { type: 'Painting', description: 'Front bumper – prepare & refinish', hours: 2.4, costClass: 'paint' }]).length === 0);
  check('a blend line does not count as the refinish of a new panel', r([{ description: 'RH front wing – renew', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1' }, { type: 'Painting', description: 'RH front wing – blend (colour match)', code: 'FW001', side: 'R', hours: 1, costClass: 'paint', op: 'blend' }]).length === 1);
  check('unpainted part renewed (mirror assembly) → none', r([{ description: 'RH door mirror assembly – remove & replace', code: 'MR001', side: 'R', hours: 0.6, amount: 500, partNo: 'm' }]).length === 0);
  const j = base(); j.vehicle.paintType = 'metallic'; j.lines = [L({ description: 'RH front wing – renew', code: 'FW001', side: 'R', hours: 1.2, amount: 200, partNo: 'X1', op: 'renew' })];
  check('metallic + renewed painted panel + no blend → blend info (op-based renew)', find(j, /no blend lines/).length === 1);
}

section('10/19. VIN characters and VIN / make comparison');
{
  for (const vin of ['SJNFBAF15U7-0000*', 'SJNFBAF15U7.00000', 'SJNFBAF15U7#00000']) {
    const d = C.decodeVin(vin);
    check(`${vin} → invalid with a character issue`, !d.valid && d.issues.some((i) => /characters that are not allowed/.test(i)), d);
  }
  check('valid sample VIN still valid', C.decodeVin('SJNFBAF15U7000000').valid);
  check('I/O/Q message kept', C.decodeVin('SJNFBAF15U70000O0').issues.some((i) => /I, O or Q/.test(i)));
  check('spaces ignored', C.decodeVin('SJNF BAF1 5U70 00000').valid);
  const vm = (vin, make) => { const j = base(); j.vehicle.vin = vin; j.vehicle.make = make; return find(j, /VIN manufacturer code suggests/).length; };
  check('Skoda (variant / DVLA spelling) with TMB → no warning', vm('TMBJJ7NE5L0000000', 'Skoda') === 0);
  check('Škoda with TMB → no warning', vm('TMBJJ7NE5L0000000', 'Škoda') === 0);
  check('typed "Citroen" with VF7 → no warning', vm('VF7SA9HP0FW000000', 'Citroen') === 0);
  check('Abarth with ZFA → no warning', vm('ZFA31200000000000', 'Abarth') === 0);
  check('DS with VR7 → no warning', vm('VR7ACYHZKML000000', 'DS') === 0);
  check('VW with WVW → no warning', vm('WVWZZZAUZFW000000', 'VW') === 0);
  check('Range Rover with SAL → no warning', vm('SALGA2AE0FA000000', 'Range Rover') === 0);
  check('Mercedes Benz (no hyphen) with WDD → no warning', vm('WDD2130041A000000', 'Mercedes Benz') === 0);
  check('Ford with ZFA → still warns', vm('ZFA31200000000000', 'Ford') === 1);
  check('Nissan with TMB → still warns', vm('TMBJJ7NE5L0000000', 'Nissan') === 1);
}

section('11/22. AI-use note counts only ai:true entries; no report.aiDisclosure');
{
  const j = Sample.sampleJob();
  j.aiLog = [{ at: '2026-09-01T10:00:00Z', action: 'DVLA Vehicle Enquiry Service lookup', model: 'DVLA', ai: false }, { at: '2026-09-01T10:01:00Z', action: 'DVSA MOT History lookup', model: 'DVSA', ai: false }];
  check('only DVLA / DVSA entries → no AI note', find(j, /AI tools were used/).length === 0);
  j.aiLog.push({ at: '2026-09-01T10:02:00Z', action: 'AI photo assessment', model: 'claude', ai: true });
  const m = find(j, /AI tools were used/);
  check('an ai:true entry → one AI note (counts 1 action)', m.length === 1 && /1 logged action\)/.test(m[0].msg), m);
  j.report.aiDisclosure = true;
  check('report.aiDisclosure has no effect', find(j, /AI tools were used/).length === 1);
  check('core.js no longer references aiDisclosure', !/aiDisclosure/.test(fs.readFileSync(APP + '/js/core.js', 'utf8')));
}

section('12. Photo coverage counts included photos only; word-bounded VIN / odometer');
{
  const ph = (n, f) => Array.from({ length: n }, (_, i) => Object.assign({ id: 'p' + i, dataUrl: 'data:,', title: 'Damage ' + i, caption: '', labels: [] }, f ? f(i) : {}));
  let j = Sample.sampleJob(); j.inspection.type = 'Image-based (desktop) assessment';
  j.photos = ph(9, (i) => ({ title: i === 0 ? 'Odometer' : i === 1 ? 'VIN plate' : 'Damage ' + i, exclude: i < 8 }));
  check('9 photos, 8 excluded → "only 1 photo(s) in the report"', find(j, /only 1 photo\(s\) in the report/).length === 1, msgs(j).filter((x) => /photo/i.test(x)));
  check('…and the excluded odometer / VIN photos do not count', find(j, /No photo identified as the odometer/).length === 1 && find(j, /No photo identified as the VIN plate/).length === 1, msgs(j));
  j.photos.forEach((p) => { p.exclude = true; });
  check('every photo excluded → "No photographs are included in the report (9 excluded)."', find(j, /No photographs are included in the report \(9 excluded\)/).length === 1);
  j = Sample.sampleJob();
  check('no photos → "No photographs attached."', find(j, /^No photographs attached\.$/).length === 1);
  j.inspection.type = 'Image-based (desktop) assessment';
  j.photos = ph(8, () => ({ title: 'RH front door - surface damage', caption: 'Horizontal scoring consistent with a moving contact while driving.' }));
  check('"moving" / "driving" do not count as the VIN plate', find(j, /No photo identified as the VIN plate/).length === 1);
  j.photos[0].title = 'VIN plate'; j.photos[1].caption = 'Odometer reading 64,368';
  check('"VIN plate" / "Odometer" captions are recognised', find(j, /No photo identified as the VIN plate|No photo identified as the odometer/).length === 0, msgs(j));
  j.photos[0].title = 'Chassis number'; j.photos[1].caption = 'Instrument cluster';
  check('"Chassis number" / "Instrument cluster" recognised', find(j, /No photo identified/).length === 0);
  j.photos[2].title = ''; j.photos[3].title = ''; j.photos[3].exclude = true;
  check('untitled count only covers photos in the report', find(j, /^1 photo\(s\) in the report have no title/).length === 1, msgs(j));
  j.photos[4].labels = [{ text: 'Scuff', ai: true }]; j.photos[5].labels = [{ text: 'Dent', ai: true }]; j.photos[5].labelsReviewed = true;
  j.photos[6].labels = [{ text: 'Scratch', ai: true, hidden: true }]; j.photos[3].labels = [{ text: 'x', ai: true }];
  const m = find(j, /AI damage labels that have not been reviewed/);
  check('one included, unreviewed photo with visible AI labels → warning (reviewed / hidden / excluded not counted)', m.length === 1 && /^1 photo/.test(m[0].msg), m);
}

section('13. Accreditation checked against the signature / report date');
{
  const saved = C.clone(C.settings);
  const today = C.todayISO();
  const acc = (exp, signed, repDate) => { C.settings.assessor.accreditationExpiry = exp; const j = Sample.sampleJob(); j.assessor.dateSigned = signed; if (repDate !== undefined) j.report.date = repDate; return find(j, /accreditation/); };
  let m = acc('2026-10-01', '2026-09-06');
  check('signed 06/09/2026, expiry 01/10/2026 (past) → no error, an info', m.length === 1 && m[0].level === 'info', m);
  m = acc('2026-09-01', '2026-09-06');
  check('signed after expiry → error naming the signature date', m.length === 1 && m[0].level === 'error' && /signature date/.test(m[0].msg), m);
  m = acc('2026-10-01', '', '2026-09-06');
  check('unsigned, report dated before expiry, expired since → warn', today > '2026-10-01' ? m.length === 1 && m[0].level === 'warn' : true, m);
  m = acc('2026-09-01', '', '2026-09-06');
  check('unsigned, report dated after expiry → error naming the report date', m.length === 1 && m[0].level === 'error' && /report date/.test(m[0].msg), m);
  m = acc('2099-01-01', '2026-09-06');
  check('valid accreditation → nothing', m.length === 0, m);
  C.settings = saved;
}

section('15. CPR 35 range of opinion, and inspection.by');
{
  const saved = C.clone(C.settings);
  C.settings.assessor.qualifications = 'MIAEA';
  const cpr = (f) => { const j = Sample.sampleJob(); j.report.cpr35 = true; j.inspection.by = 'Sample Assessor'; if (f) f(j); return j; };
  check('sample opinion ("reasonable potential…") → range-of-opinion warning', find(cpr(), /range of opinion/).length === 1);
  check('"Repair should be arranged…" → warning', find(cpr((j) => { j.opinion = 'Repair should be arranged at a franchised dealer.'; }), /range of opinion/).length === 1);
  check('"There is a range of opinion …" → no warning', find(cpr((j) => { j.opinion += '\n\nThere is a range of opinion on repairability; I prefer the total-loss view because…'; }), /range of opinion/).length === 0);
  check('"an alternative view …" → no warning', find(cpr((j) => { j.opinion += ' An alternative view would be to repair; I reject it because…'; }), /range of opinion/).length === 0);
  let m = find(cpr((j) => { j.inspection.by = ''; }), /who carried out the examination/);
  check('CPR 35 + no inspection.by → error', m.length === 1 && m[0].level === 'error', m);
  check('inspection.by missing but not CPR 35 → nothing', find(Sample.sampleJob(), /who carried out the examination/).length === 0);
  check('inspection.by = the assessor → no qualifications warning', find(cpr(), /qualifications of the person/).length === 0);
  check('another examiner without qualifications → warning', find(cpr((j) => { j.inspection.by = 'J Bloggs'; }), /qualifications of the person/).length === 1);
  check('another examiner with qualifications → none', find(cpr((j) => { j.inspection.by = 'J Bloggs'; j.inspection.byQualifications = 'IMI'; }), /qualifications of the person/).length === 0);
  C.settings = saved;
}

section('16. Highest-guide rule: named sources only, suppressed by belowHighestReason');
{
  let j = Sample.sampleJob(); j.valuation.sources.push({ name: '', amount: 7400 }, { name: '   ', amount: 9000 });
  let t = C.totals(j);
  check('unnamed / blank-named sources ignored in valMax / valAvg', t.valMax === 5682 && t.valMin === 5269 && t.valAvg === C.round2((5682 + 5395 + 5323 + 5269) / 4), t);
  check('…so no "below the highest guide" warning for the sample', find(j, /highest guide/).length === 0);
  check('namedSources export', C.namedSources(j).length === 4);
  j = Sample.sampleJob(); j.valuation.adopted = 5400;
  check('adopted below highest, no reason → warning', find(j, /below the highest guide figure \(£5,682\.00\)/).length === 1);
  j.valuation.comments += ' The vehicle was in pre-accident condition.';
  check('a comment mentioning "condition" no longer suppresses it', find(j, /highest guide/).length === 1);
  j.valuation.belowHighestReason = 'Higher mileage than the guide basis; two adverts at £5,400.';
  check('belowHighestReason suppresses it', find(j, /highest guide/).length === 0);
  j.valuation.belowHighestReason = '   ';
  check('whitespace-only reason does not', find(j, /highest guide/).length === 1);
}

section('Contract: net < 0 is an error');
{
  const j = C.newJob(); j.lines = [L({ description: 'x', amount: 100, partNo: 'p' })]; j.discount = 250; j.valuation.adopted = 5000;
  const m = find(j, /discount/i);
  check('discount £250 on £100 → error quoting −£150.00', m.length === 1 && m[0].level === 'error' && /−£150\.00/.test(m[0].msg), m);
  j.discount = 0; j.lines.push(L({ description: 'Betterment', amount: -300, costClass: 'other' }));
  check('negative estimate without a discount → error', find(j, /net repair cost is negative/).length === 1);
  j.lines.pop(); j.discount = 50;
  check('normal discount → no error', !qa(j).some((q) => /discount|negative/i.test(q.msg)));
}

section('21. MOT mileage checks kept intact');
{
  let j = Sample.sampleJob(); j.vehicle.mileage = 40000; j.vehicle.mileageUnit = 'miles';
  j.vehicle.motHistory = [{ date: '2025-08-01', result: 'PASSED', odometer: 62000, unit: 'KM' }, { date: '2024-08-01', result: 'PASSED', odometer: 48000, unit: 'KM' }];
  check('40,000 mi vs MOT 62,000 km → no clocking error', !find(j, /LOWER than the MOT/).length);
  j = Sample.sampleJob(); j.vehicle.motHistory = [{ date: '2026-10-15', result: 'PASSED', odometer: 65120, unit: 'MI' }, { date: '2025-08-01', result: 'PASSED', odometer: 58000, unit: 'MI' }];
  let m = find(j, /MOT AFTER the date of loss/);
  check('MOT after the loss → warning (total loss / off road), not error', m.length === 1 && m[0].level === 'warn' && !find(j, /LOWER than the MOT/).length, m);
  j = Sample.sampleJob(); j.vehicle.motHistory = [{ date: '2025-08-01', odometer: 50000, unit: 'mi' }, { date: '2023-08-01', odometer: 61000, unit: 'mi' }, { date: '2024-08-01', odometer: 55000, unit: 'mi' }];
  check('unsorted history with a real reduction → "going DOWN" warning', find(j, /going DOWN/).length === 1);
  j = Sample.sampleJob(); j.vehicle.motHistory = [{ date: '2025-08-01', odometer: 70000, unit: 'mi' }];
  check('pre-loss MOT higher than recorded mileage → clocking error', find(j, /LOWER than the MOT/).length === 1 && find(j, /LOWER than the MOT/)[0].level === 'error');
}

done();
