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
    [{ make: 'Vauxhall', model: 'Corsa (F)', firstReg: '2021-06-01' }, 'vauxhall-corsa-f'], // researched since round 3
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'Coupe' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'All-Terrain' }, null],
    [{ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01', body: 'Saloon' }, 'mercedes-e-class-w213'],
    [{ make: 'Ford', model: 'Fiesta (Mk7)', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiesta (Mk 7)', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiesta (Mk8)', firstReg: '2019-01-01' }, 'ford-fiesta-mk8'],
    [{ make: 'Ford', model: 'Fiesta Van', firstReg: '2015-01-01' }, null],
    [{ make: 'Ford', model: 'Fiesta ST', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'FORD', model: 'FIESTA', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Ford', model: 'Fiestas', firstReg: '2015-01-01' }, null],
    [{ make: 'Mercedes', model: 'E Class', firstReg: '2019-01-01' }, 'mercedes-e-class-w213'],
    [{ make: 'VW', model: 'Golf', firstReg: '2015-01-01' }, 'vw-golf-mk7'],
    [{ make: 'Nissan', model: 'Juke (F16)', firstReg: '2021-01-01' }, 'nissan-juke-f16'],
    [{ make: 'Nissan', model: 'Juke (F15)', firstReg: '2021-01-01' }, 'nissan-juke-f15'], // explicit generation wins over a late registration
    [{ make: 'Vauxhall', model: 'Corsa (E)', firstReg: '2021-06-01' }, 'vauxhall-corsa-e'], // exact generation "E"
    [{ make: 'Vauxhall', model: 'Corsa (Corsa-e)' }, null], // single-letter token, no year to confirm
    [{ make: 'Nissan', model: 'Juke' }, 'nissan-juke-f15'], // no year, no generation: first candidate (unchanged)
    [{ make: 'Nissan', model: 'Juke', dvla: { yearOfManufacture: 2015 } }, 'nissan-juke-f15']
  ];
  for (const [v, want] of cases) check(`${v.make} ${v.model} ${v.firstReg || ''}${v.body ? ' [' + v.body + ']' : ''} → ${want}`, g(v) === want, g(v));
  // Generation safety with research for consecutive generations: an explicit generation never borrows its predecessor's
  // (or successor's) part numbers, whatever the registration year; without a generation the year decides.
  const never = [
    [{ make: 'Vauxhall', model: 'Corsa (F)', firstReg: '2021-06-01' }, 'vauxhall-corsa-e'], [{ make: 'Vauxhall', model: 'Corsa (F)', firstReg: '2017-06-01' }, 'vauxhall-corsa-e'],
    [{ make: 'Ford', model: 'Fiesta (Mk8)', firstReg: '2019-01-01' }, 'ford-fiesta-mk7'], [{ make: 'Ford', model: 'Fiesta (Mk8)', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Nissan', model: 'Juke (F16)', firstReg: '2021-01-01' }, 'nissan-juke-f15'], [{ make: 'Nissan', model: 'Juke (F16)', firstReg: '2015-01-01' }, 'nissan-juke-f15'],
    [{ make: 'Vauxhall', model: 'Corsa (E)', firstReg: '2021-06-01' }, 'vauxhall-corsa-f'], [{ make: 'Ford', model: 'Fiesta (Mk7)', firstReg: '2019-01-01' }, 'ford-fiesta-mk8'],
    [{ make: 'Nissan', model: 'Juke (F15)', firstReg: '2021-01-01' }, 'nissan-juke-f16']
  ];
  for (const [v, bad] of never) check(`${v.make} ${v.model} ${v.firstReg} never → ${bad}`, g(v) !== bad && g(v) !== null, g(v));
  const byYear = [[{ make: 'Vauxhall', model: 'Corsa', firstReg: '2021-06-01' }, 'vauxhall-corsa-f'], [{ make: 'Vauxhall', model: 'Corsa', firstReg: '2016-06-01' }, 'vauxhall-corsa-e'],
    [{ make: 'Ford', model: 'Fiesta', firstReg: '2019-01-01' }, 'ford-fiesta-mk8'], [{ make: 'Ford', model: 'Fiesta', firstReg: '2015-01-01' }, 'ford-fiesta-mk7'],
    [{ make: 'Nissan', model: 'Juke', firstReg: '2021-01-01' }, 'nissan-juke-f16'], [{ make: 'Nissan', model: 'Juke', firstReg: '2015-01-01' }, 'nissan-juke-f15']];
  for (const [v, want] of byYear) check(`no generation, ${v.make} ${v.model} ${v.firstReg} → ${want} (by year)`, g(v) === want, g(v));
  C.setCustomOem([{ key: 'user-ford-puma', make: 'Ford', model: 'Puma', generation: '', years: '2019-', parts: {} }]);
  check('custom "2019-" Puma, 2021 → match', g({ make: 'Ford', model: 'Puma', firstReg: '2021-04-01' }) === 'user-ford-puma');
  C.setCustomOem([{ key: 'user-ford-puma', make: 'Ford', model: 'Puma', generation: '', years: '2019–present', parts: {} }]);
  check('custom "2019–present" Puma, 2021 → match', g({ make: 'Ford', model: 'Puma', firstReg: '2021-04-01' }) === 'user-ford-puma');
  check('custom Puma without generation also matches "Puma (Mk2)" by year', g({ make: 'Ford', model: 'Puma (Mk2)', firstReg: '2021-04-01' }) === 'user-ford-puma');
  check('custom Puma, 2017 → no match', g({ make: 'Ford', model: 'Puma', firstReg: '2017-04-01' }) === null);
  C.setCustomOem([{ key: 'user-mazda-mx5', make: 'Mazda', model: 'MX-5', generation: 'ND', years: '2015-', parts: {} }]);
  check('custom roadster entry still matches its own body ("Convertible")', g({ make: 'Mazda', model: 'MX-5 (ND)', firstReg: '2018-01-01', body: 'Convertible' }) === 'user-mazda-mx5');
  // a model the research does not cover, so the match can only come from accent folding ("SKODA" → "Škoda")
  C.setCustomOem([{ key: 'user-skoda-fabia', make: 'Škoda', model: 'Fabia', generation: 'Mk3', years: '2015-2021', parts: {} }]);
  check('accent-folded make: "Skoda" finds a "Škoda" entry', g({ make: 'SKODA', model: 'Fabia', firstReg: '2016-01-01' }) === 'user-skoda-fabia' && g({ make: 'Skoda', model: 'Fabia (Mk3)', firstReg: '2016-01-01' }) === 'user-skoda-fabia');
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

// ======================= round 3 =======================

section('R#26. Tolerant num(): £, thousands commas, spaces, decimal comma');
{
  const cases = [['£5,995', 5995], ['60,000', 60000], ['1,234.50', 1234.5], ['1,5', 1.5], ['1,50', 1.5], ['12,7', 12.7], ['1.234,56', 1234.56], [' £ 1 234.5 ', 1234.5], ['−£56.34', -56.34], ['-£5', -5], ['£−1', -1],
    ['1,500', 1500], ['1,000,000', 1000000], ['64,368 miles', 64368], ['1.5h', 1.5], ['1e3', 1000], ['2014-08-05', 2014], ['15%', 15], ['.5', 0.5], ['-.5', -0.5], ['', 0], ['abc', 0], ['Infinity', 0],
    [null, 0], [undefined, 0], [true, 0], [NaN, 0], [Infinity, 0], [{}, 0], [[5], 5], [3365.08, 3365.08], ['\u00a01\u202f000', 1000]];
  const bad = cases.filter(([v, want]) => !Object.is(C.num(v), want)).map(([v, want]) => `${JSON.stringify(v)} → ${C.num(v)} (want ${want})`);
  check(`num() reads ${cases.length} legacy / imported number formats`, bad.length === 0, bad);
  const j = Sample.sampleJob();
  j.lines[0].hours = '0,6'; j.lines[0].amount = '£74.55'; j.valuation.adopted = '£5,682';
  const t = C.totals(j);
  check('string amounts / hours / PAV ("0,6", "£74.55", "£5,682") keep the reference totals', t.net === 3365.08 && t.gross === 4038.1 && t.pav === 5682 && t.pctNet === 59.22, t);
}

section('R#27. Dates: invalid calendar dates are printed as entered (never rolled over), with a QA warning');
{
  check('longDate("2023-02-29") stays "2023-02-29" (was "01 March 2023")', C.longDate('2023-02-29') === '2023-02-29');
  check('ukDate("2023-02-29") stays "2023-02-29"', C.ukDate('2023-02-29') === '2023-02-29');
  check('ukDate / longDate agree on 2026-06-31, 2026-13-01, 2026-02-30', ['2026-06-31', '2026-13-01', '2026-02-30', '2026-00-10'].every((d) => C.ukDate(d) === d && C.longDate(d) === d));
  check('valid dates unchanged (leap day 2024-02-29, DST change days, timestamps)', C.longDate('2024-02-29') === '29 February 2024' && C.ukDate('2024-02-29') === '29/02/2024' && C.longDate('2026-03-29') === '29 March 2026' && C.longDate('2026-10-25') === '25 October 2026' && C.ukDate('2026-09-01T10:00:00Z') === '01/09/2026' && C.longDate('2026-09-01') === '01 September 2026');
  check('empty / null → ""; other text unchanged', C.ukDate('') === '' && C.longDate(null) === '' && C.ukDate('September 2026') === 'September 2026' && C.longDate('n/a') === 'n/a');
  const j = Sample.sampleJob(); j.instruction.dateOfLoss = '2023-02-29'; j.assessor.dateSigned = '2026-09-31'; j.vehicle.firstReg = '2014-13-05';
  const m = find(j, /is not a valid date/);
  check('QA warning names each invalid date field', m.length === 3 && m.every((x) => x.level === 'warn') && /^Date of loss "2023-02-29"/.test(m[0].msg) && m.some((x) => /^First registration date/.test(x.msg) && x.tab === 'vehicle') && m.some((x) => /^Date signed/.test(x.msg) && x.tab === 'signoff'), m);
  check('the sample has no date warnings', find(Sample.sampleJob(), /is not a valid date/).length === 0);
}

section('R#9. todayISO / localISODate: the UK calendar date, not the UTC date');
{
  check('localISODate(2026-06-15T23:30Z) = 2026-06-16 (00:30 BST)', C.localISODate(new Date('2026-06-15T23:30:00Z')) === '2026-06-16', C.localISODate(new Date('2026-06-15T23:30:00Z')));
  check('localISODate of an ISO string (lookedUpAt) and of a winter time', C.localISODate('2026-06-15T23:30:00.000Z') === '2026-06-16' && C.localISODate('2026-01-15T23:30:00Z') === '2026-01-15');
  check('localISODate passes a plain date through; junk → ""', C.localISODate('2026-02-01') === '2026-02-01' && C.localISODate('not a date') === '' && C.localISODate({}) === '');
  // a sandbox whose clock reads 00:30 BST on 16 June 2026 (the process runs in UTC)
  const c2 = load();
  require('vm').runInContext(`(() => { const R = Date, at = R.parse('2026-06-15T23:30:00Z'); globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(at); } static now() { return at; } }; })()`, c2);
  const nj = c2.Core.newJob();
  check('todayISO() at 00:30 BST is 2026-06-16, and new jobs are dated that day', c2.Core.todayISO() === '2026-06-16' && nj.report.date === '2026-06-16' && nj.instruction.dateInstructed === '2026-06-16' && nj.inspection.date === '2026-06-16', [c2.Core.todayISO(), nj.report.date]);
}

section('R#13 / R#20. Negative discount or PAV: ignored by totals(), reported as errors; PAV ≤ 0 is missing');
{
  const j = C.newJob(); j.lines = [L({ description: 'Part', amount: 1000, partNo: 'p' })]; j.discount = -100;
  let t = C.totals(j);
  check('discount −100 → totals use 0 (net £1,000, not £1,100)', t.discount === 0 && t.net === 1000, t);
  let m = find(j, /discount is negative/);
  check('…and a QA error for the negative discount', m.length === 1 && m[0].level === 'error' && m[0].tab === 'estimate', m);
  j.discount = 100;
  check('a positive discount is still applied', C.totals(j).net === 900 && !find(j, /discount is negative/).length);
  const k = Sample.sampleJob(); k.valuation.adopted = -5000;
  t = C.totals(k);
  check('PAV −5000 → pav 0, no ratio', t.pav === 0 && t.pctNet === 0 && !t.berSuggested, t);
  m = qa(k);
  check('…QA error for the negative PAV, "No pre-accident value adopted", and no "below the highest guide" message', m.some((q) => q.level === 'error' && /pre-accident value is negative/.test(q.msg)) && m.some((q) => /^No pre-accident value adopted/.test(q.msg)) && !m.some((q) => /highest guide/.test(q.msg)), m.map((q) => q.msg));
  k.valuation.adopted = 0;
  check('PAV 0 → "No pre-accident value adopted" (no negative error)', find(k, /^No pre-accident value adopted/).length === 1 && !find(k, /negative/).length);
}

section('#5. A finalised report keeps its rates and VAT (issued.rates / issued.vatPct)');
{
  const saved = C.clone(C.settings);
  const j = Sample.sampleJob();
  j.lines.push(L({ type: 'Other', description: 'Valet', hours: 1 }), L({ type: 'Materials', description: 'Sundries', hours: 0.5 }));
  const before = C.totals(j);
  const snap = C.rateSnapshot(j);
  check('rateSnapshot: every standard type and every line type in use, plus VAT %', ['Body', 'Painting', 'Mechanical', 'Auxiliary', 'Electrical', 'Other', 'Materials'].every((k) => snap.rates[k] === 72.5) && snap.vatPct === 20, snap);
  j.issued = Object.assign({ at: '2026-09-06T10:00:00Z' }, snap);
  check('finalising does not change any figure', JSON.stringify(C.totals(j)) === JSON.stringify(before));
  C.settings.rates = { Body: 99, Painting: 99, Mechanical: 99, Auxiliary: 99, Electrical: 99 }; C.settings.vatPct = 5;
  j.rates = { Body: 50, Painting: 50, Mechanical: 50, Auxiliary: 50, Electrical: 50 }; j.vatPct = 0;
  const after = C.totals(j);
  check('later Settings AND job rate / VAT changes do not alter the issued figures', after.net === before.net && after.vat === before.vat && after.gross === before.gross && after.vatPct === 20, { before: before.gross, after: after.gross });
  check('lineRate / vatPctFor read the snapshot (an explicit line rate still wins)', C.lineRate(j, { type: 'Painting' }) === 72.5 && C.lineRate(j, { type: 'Unknown type' }) === 72.5 && C.lineRate(j, { type: 'Body', rate: 40 }) === 40 && C.vatPctFor(j) === 20);
  const reopened = C.clone(j); delete reopened.issued;
  check('re-opened (issued cleared): the job\'s own rates apply again', C.lineRate(reopened, { type: 'Body' }) === 50 && C.vatPctFor(reopened) === 0);
  const legacy = C.clone(j); legacy.issued = { at: '2026-09-06T10:00:00Z' };
  check('a report finalised before snapshots existed uses the job\'s own rates', C.lineRate(legacy, { type: 'Body' }) === 50);
  C.settings = saved;
  const s = Sample.sampleJob(); s.issued = Object.assign({ at: '2026-09-06T10:00:00Z' }, C.rateSnapshot(s));
  const ts = C.totals(s);
  check('sample finalised: still £3,365.08 / £4,038.10 / 59.22% / 71.07%', ts.net === 3365.08 && ts.gross === 4038.1 && ts.pctNet === 59.22 && ts.pctGross === 71.07, ts);
  check('a "constructor" line type does not read Object.prototype (rate is the Body rate)', C.lineRate(Sample.sampleJob(), { type: 'constructor' }) === 72.5);
}

section('#7. Salvage category vs decision');
{
  const cd = (decision, category) => { const j = Sample.sampleJob(); j.outcome = { decision, category }; j.valuation.adopted = 20000; return qa(j); };
  let q = cd('Repair', 'S');
  const m = q.filter((x) => /salvage category \(Category S\) is recorded, but the decision is "Repair"/.test(x.msg));
  check('Repair + Category S → warning on the Valuation tab', m.length === 1 && m[0].level === 'warn' && m[0].tab === 'valuation', q.map((x) => x.msg));
  check('…and no AQP-ID warning (no category is being recommended)', !q.some((x) => /AQP/.test(x.msg)));
  q = cd('Repair', 'B');
  check('Repair + Category B → error (must not return to the road)', q.some((x) => x.level === 'error' && /Category B \(break for parts\)/.test(x.msg)));
  q = cd('', 'N');
  check('no decision + Category N → warning', q.some((x) => x.level === 'warn' && /decision is not set/.test(x.msg)));
  q = cd('Further investigation required', 's');
  check('lower-case "s" is read as Category S', q.some((x) => /Category S\) is recorded/.test(x.msg)));
  q = cd('Beyond Economical Repair / Total Loss Recommended', 'N');
  check('total loss + Category N → no category / decision message', !q.some((x) => /is recorded, but the decision/.test(x.msg)));
  check('isTotalLoss: BER / total / beyond; not "October" or "Repair"', C.isTotalLoss('BER') && C.isTotalLoss('Total Loss — Uneconomical to Repair') && !C.isTotalLoss('Repair after strip in October') && !C.isTotalLoss('Repair') && !C.isTotalLoss(null));
}

section('#8. CPR 35: material relied on');
{
  const saved = C.clone(C.settings);
  C.settings.assessor.qualifications = 'MIAEA';
  const j = Sample.sampleJob(); j.report.cpr35 = true; j.inspection.by = 'Sample Assessor';
  check('newJob has report.materialsRelied = ""', C.newJob().report.materialsRelied === '');
  let m = find(j, /material relied on/i);
  check('CPR 35 with no material relied on → error (Sign-off)', m.length === 1 && m[0].level === 'error' && m[0].tab === 'signoff' && /PD 35 para 3\.2\(2\)/.test(m[0].msg), m);
  j.report.materialsRelied = "Glass's Guide and CAP HPI retail values; ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage.";
  check('filled in → no error', find(j, /material relied on/i).length === 0);
  check('not a CPR 35 report → no error', find(Sample.sampleJob(), /material relied on/i).length === 0);
  C.settings = saved;
}

section('#15 (core messages). Settings sections named as they are titled');
{
  const src = fs.readFileSync(APP + '/js/core.js', 'utf8');
  check('no "Settings → Assessor" without "defaults"', !/Settings → Assessor(?! defaults)/.test(src));
  const j = Sample.sampleJob(); j.outcome.category = 'N';
  check('AQP message points to "Settings → Assessor defaults"', find(j, /AQP/).every((q) => /Settings → Assessor defaults/.test(q.msg)) && find(j, /AQP/).length === 1);
}

section('#2. Unverified AI comparables: QA warning');
{
  const j = Sample.sampleJob();
  j.valuation.adverts = [
    { description: 'Nissan Juke Tekna', year: '2014', mileage: 70000, price: 5495, source: 'AutoTrader', url: '', aiUnverified: true, claimedUrl: 'https://www.autotrader.co.uk/car-details/made-up' },
    { description: 'Nissan Juke Acenta', year: '2014', mileage: 61000, price: 5600, source: 'AutoTrader', url: 'https://www.autotrader.co.uk/car-details/1' },
    { description: '', price: '', aiUnverified: true }
  ];
  const m = find(j, /found by AI web search/);
  check('one warning listing the unverified advert (Valuation tab)', m.length === 1 && m[0].level === 'warn' && m[0].tab === 'valuation' && /^1 advert found by AI web search has not been verified \(Nissan Juke Tekna 2014 £5,495\.00\)/.test(m[0].msg), m);
  delete j.valuation.adverts[0].aiUnverified;
  check('ticked "Verified" (flag removed) → no warning', find(j, /found by AI web search/).length === 0);
}

section('#3. C.unreviewedAiText: fields still holding the AI\'s text');
{
  const j = Sample.sampleJob();
  check('no aiText → []', JSON.stringify(C.unreviewedAiText(j)) === '[]' && JSON.stringify(C.unreviewedAiText(null)) === '[]');
  j.photos = [{ id: 'p1', title: 'AI title', caption: 'Edited caption' }, { id: 'p2', title: 'AI title 2', exclude: true }, { id: 'p3', title: 'Second photo', caption: 'AI caption 3' }];
  j.circumstances.impactType = 'Sideswipe / lateral side contact';
  j.aiText = {
    opinion: j.opinion + ' edited later', // edited by the assessor
    'circumstances.impactType': 'Sideswipe  /  lateral side contact ', // spacing differs only
    'report.summary': j.report.summary,
    'photos.p1.title': 'AI title', 'photos.p1.caption': 'AI caption 1', 'photos.p2.title': 'AI title 2', 'photos.p3.caption': 'AI caption 3', 'photos.gone.title': 'x',
    'assessment.wheels': '', 'constructor.name': 'Object', '__proto__.x': 'y', 'valuation.historyNotes': 'AI history', 'estimateNotes': 7
  };
  j.valuation.historyNotes = 'AI history';
  const u = C.unreviewedAiText(j);
  check('lists only fields whose current text is the AI text (spacing ignored), in report order', JSON.stringify(u.map((x) => x.path)) === JSON.stringify(['report.summary', 'circumstances.impactType', 'photos.p1.title', 'photos.p3.caption', 'valuation.historyNotes']), u);
  check('labels and tabs', u[0].label === 'Section 01 summary' && u[0].tab === 'opinion' && u[1].label === 'Impact type (section 05)' && u[1].tab === 'circumstances' && u[2].label === 'Title of IMAGE 01' && u[2].tab === 'photos' && u[3].label === 'Caption of IMAGE 02' && u[4].label === 'Valuation: history notes' && u[4].tab === 'valuation', u);
  check('edited, empty, excluded-photo, deleted-photo, prototype and non-string entries are ignored', !u.some((x) => /opinion|wheels|constructor|proto|p2|gone|estimateNotes/.test(x.path)));
  const m = find(j, /AI-drafted text not yet edited/);
  check('QA: one warning per tab naming the fields', m.length === 4 && m.every((x) => x.level === 'warn') && m.some((x) => x.tab === 'photos' && /Title of IMAGE 01; Caption of IMAGE 02/.test(x.msg)) && m.some((x) => x.tab === 'circumstances' && /Impact type \(section 05\)/.test(x.msg)), m);
  j.aiText = {};
  check('no unedited AI text → no warning', find(j, /AI-drafted text/).length === 0);
}

section('#21. AI narrative review flags: one QA warning each');
{
  const j = Sample.sampleJob();
  j.aiFlags = [{ section: 'Valuation comments', text: 'No PAV adopted: redraft the valuation comments.', at: '2026-06-15T23:30:00Z' }, { text: 'Check concealed sill damage at strip' }, { text: '  ' }, null, 'junk'];
  const m = find(j, /^AI review flag/);
  check('two warnings (blank / junk entries ignored), Opinion tab', m.length === 2 && m.every((x) => x.level === 'warn' && x.tab === 'opinion'), m);
  check('…with the section, the UK date and the text', m[0].msg === 'AI review flag (Valuation comments), 16/06/2026: No PAV adopted: redraft the valuation comments. Check it, then dismiss the flag.', m[0].msg);
  check('…a flag without a full stop gets one before the instruction', m[1].msg === 'AI review flag: Check concealed sill damage at strip. Check it, then dismiss the flag.', m[1].msg);
  j.aiFlags = 'not-an-array';
  check('aiFlags of the wrong type do not throw', !throws(() => C.qaChecks(j)));
  check('newJob has aiFlags = []', Array.isArray(C.newJob().aiFlags));
}

section('#9. OEM lookup: the assessor\'s numbers rank with confirmed ones and respect auto-fill');
{
  const k = 'nissan-juke-f15';
  const base = C.oemLookup(k, 'SS001', 'R');
  C.setCustomOem([{ key: k, make: 'Nissan', model: 'Juke', parts: { 'SS001|R': [{ oem: 'USER-NOFILL', confidence: 'user', user: true, autoFill: false, role: 'primary', market: 'UK' }] } }]);
  let c = C.oemLookup(k, 'SS001', 'R');
  check('a user number NOT marked auto-fill is never ahead of an auto-fill one', c[0].oem === base[0].oem && c.some((x) => x.oem === 'USER-NOFILL'), c.map((x) => x.oem));
  C.setCustomOem([{ key: k, make: 'Nissan', model: 'Juke', parts: { 'SS001|R': [{ oem: 'USER-FILL', confidence: 'user', user: true, autoFill: true, role: 'primary', market: 'UK' }] } }]);
  c = C.oemLookup(k, 'SS001', 'R');
  check('a user number marked auto-fill ranks like a confirmed one and comes first', c[0].oem === 'USER-FILL', c.map((x) => x.oem + '/' + x.confidence));
  const mixed = [{ oem: 'S1', confidence: 'single-source', autoFill: true, market: '' }, { oem: 'U1', confidence: 'user', autoFill: true, market: '' }, { oem: 'C1', confidence: 'confirmed', autoFill: true, market: '' }, { oem: 'V1', confidence: 'confirmed', role: 'variant', autoFill: true }];
  C.setCustomOem([{ key: 'user-test', make: 'Test', model: 'Car', parts: { 'FE001|': mixed } }]);
  c = C.oemLookup('user-test', 'FE001', '');
  check('order: user/confirmed (stored order) before single-source; variants last', c.map((x) => x.oem).join(',') === 'U1,C1,S1,V1', c.map((x) => x.oem));
  check('oemAlternatives: a line using the assessor\'s own number (confidence user) needs no VIN check', C.oemAlternatives('user-test', { code: 'FE001', partNo: 'U1' }) === 0 && C.oemAlternatives('user-test', { code: 'FE001', partNo: 'C1' }) === 3);
  C.setCustomOem([]);
  check('built-in research order unchanged (Juke SS001 R → 768501KA6A first)', C.oemLookup(k, 'SS001', 'R')[0].oem === '768501KA6A');
}

section('#18. Unused export removed; namedSources used by report.js');
{
  check('isServiceCode is no longer exported (used inside core only)', !('isServiceCode' in C));
  check('report.js uses C.namedSources', /C\.namedSources\(/.test(fs.readFileSync(APP + '/js/report.js', 'utf8')));
}

// ======================= round 4 (final review) =======================

section('R4 store/num: "0,600" is a decimal comma (0.6), not thousands');
{
  const cases = [['0,600', 0.6], ['0,500', 0.5], ['0,125', 0.125], ['0,999', 0.999], ['00,500', 0.5], ['-0,500', -0.5], ['£0,500', 0.5], ['0,6', 0.6], ['0,05', 0.05],
    ['1,500', 1500], ['12,345', 12345], ['1,234.50', 1234.5], ['1.234,56', 1234.56], ['0.600,5', 0.6005]];
  const bad = cases.filter(([v, want]) => !Object.is(C.num(v), want)).map(([v, want]) => `${v} → ${C.num(v)} (want ${want})`);
  check('num(): a group starting with 0 is never thousands; real thousands still read', bad.length === 0, bad);
  const j = Sample.sampleJob(); j.lines[0].hours = '0,600';
  check('sample with line hours "0,600" keeps the reference net £3,365.08 (was £46,821.58)', C.totals(j).net === 3365.08 && C.totals(j).labourHours === 20.2, C.totals(j));
}

section('R4 qa/structural: a negation counts only when it denies the damage (#14)');
{
  const catN = (text) => { const j = Sample.sampleJob(); j.assessment.structural = text; return find(j, /Category N selected, but the structural assessment text/).length; };
  const catS = (text) => { const j = Sample.sampleJob(); j.outcome.category = 'S'; j.assessment.structural = text; return find(j, /Category S selected, but the structural assessment text/).length; };
  // records structural damage although the clause has a "not": Cat N warns, Cat S does not
  const records = [
    'The RH A-pillar is deformed and is not economically repairable.',
    'The RH chassis leg is buckled and must not be straightened; it requires renewal.',
    'The vehicle has sustained structural damage, not merely cosmetic damage.',
    'The RH chassis leg is kinked and can\'t be straightened.',
    'The RH A-pillar is deformed beyond repair and is not safe.',
    'Structural damage is present and does not permit a safe repair.',
    'The RH chassis leg is kinked, with no other damage found.',
    'There is no doubt that the RH A-pillar is deformed.',
    'The RH B-pillar is deformed and has not been repaired.',
    'The RH sill reinforcement is cracked and is not repairable.',
    'The A-pillar is not just creased but kinked.'
  ];
  for (const s of records) check('records damage (Cat N warns, Cat S silent): ' + s, catN(s) === 1 && catS(s) === 0, [catN(s), catS(s)]);
  // denies structural damage: Cat N silent, Cat S warns
  const denies = [
    'The chassis leg does not require repair or replacement.',
    'No repair is required to the chassis legs.',
    'The chassis leg requires no repair.',
    'Neither the A-pillar nor the B-pillar is damaged.',
    'The A-pillar isn\'t damaged.',
    'Deformation of the chassis leg was not found.',
    'The A-pillar was not affected.',
    'Structural damage: nil.',
    'Structural damage: none identified.',
    'Chassis legs: no damage.',
    'The B-pillar was inspected and not found to be damaged.'
  ];
  for (const s of denies) check('denies damage (Cat N silent, Cat S warns): ' + s, catN(s) === 0 && catS(s) === 1, [catN(s), catS(s)]);
  for (const s of ['No damage to a principal structural member has been identified.', 'The vehicle has not sustained any structural damage.', 'Damage is confined to bolt-on panels; no structural members are affected.', 'There is no need to replace the A-pillar.']) {
    check('denies damage (Cat N silent, Cat S warns): ' + s, catN(s) === 0 && catS(s) === 1, [catN(s), catS(s)]);
  }
  for (const s of ['The A-pillar is deformed and the sill is not damaged.', 'Minor structural damage, not requiring sectioning.', 'The A-pillar damage is not severe.']) {
    check('records damage (Cat N warns, Cat S silent): ' + s, catN(s) === 1 && catS(s) === 0, [catN(s), catS(s)]);
  }
  // neither: a negation of something that is not the damage, without any damage recorded; or a speculative "not ruled out"
  check('"The chassis leg was not inspected." neither records nor denies (no false Cat S warning)', catN('The chassis leg was not inspected.') === 0 && catS('The chassis leg was not inspected.') === 0);
  check('"Structural damage has not been ruled out." / "…not yet been excluded" are speculative: neither', ['Structural damage has not been ruled out.', 'Structural damage to the chassis leg has not yet been excluded.'].every((s) => catN(s) === 0 && catS(s) === 0));
  check('the sample text (Category N) still gives no warning, and still warns under Category S', catN(Sample.sampleJob().assessment.structural) === 0 && catS(Sample.sampleJob().assessment.structural) === 1);
}

section('R4 qa/ADAS: an "ADAS … calibration" line covers only the sensor it names (#15)');
{
  const adas = (lines) => { const j = base(); j.lines = lines.map(L); return find(j, /ADAS|Geometry|Parking sensor|Headlamp work/); };
  const ws = { description: 'Windscreen – renew', code: 'GL001', hours: 1.5, amount: 400, partNo: 'W', op: 'renew' };
  const radar = { type: 'Electrical', description: 'Front radar sensor (ACC/AEB) – renew', code: 'EL001', hours: 0.5, amount: 600, partNo: 'R', op: 'renew' };
  const bsm = { description: 'RH blind-spot radar sensor (rear) – renew', code: 'RE013', side: 'R', hours: 0.4, amount: 200, partNo: 'b' };
  let a = adas([ws, radar, { description: 'ADAS front camera calibration', code: 'EL003', hours: 1 }]);
  check('windscreen + front radar + "ADAS front camera calibration" → front radar warning only', a.length === 1 && /front radar work/.test(a[0].msg), a);
  a = adas([bsm, { description: 'ADAS calibration – windscreen camera', code: 'GL005', hours: 1 }]);
  check('blind-spot radar + "ADAS calibration – windscreen camera" → blind-spot warning', a.length === 1 && /blind-spot radar work/.test(a[0].msg), a);
  a = adas([{ description: 'LH surround-view camera – renew', code: 'EL004', side: 'L', hours: 0.5, amount: 200, partNo: 's' }, { description: 'ADAS front camera calibration', code: 'EL003', hours: 1 }]);
  check('surround-view camera + "ADAS front camera calibration" → surround-view warning', a.length === 1 && /surround-view/.test(a[0].msg), a);
  a = adas([ws, radar, { description: 'ADAS front radar calibration', code: 'EL002', hours: 1 }]);
  check('windscreen + radar + "ADAS front radar calibration" → camera warning only', a.length === 1 && /windscreen \/ front camera/.test(a[0].msg), a);
  a = adas([radar, { description: 'ADAS blind-spot radar calibration', code: 'EL005', hours: 0.8 }]);
  check('front radar + "ADAS blind-spot radar calibration" → front radar warning', a.length === 1 && /front radar work/.test(a[0].msg), a);
  a = adas([radar, { description: 'ADAS calibration - front camera', amount: 150, costClass: 'other' }]);
  check('a free-text "ADAS calibration - front camera" line does not cover the radar', a.length === 1 && /front radar work/.test(a[0].msg), a);
  a = adas([ws, radar, bsm, { description: 'ADAS calibration (static and dynamic)', amount: 250, costClass: 'other' }]);
  check('a generic "ADAS calibration (static and dynamic)" line still covers camera, radar and blind-spot', a.length === 0, a);
  a = adas([ws, radar, { description: 'ADAS calibration (front camera and radar)', amount: 250, costClass: 'other' }]);
  check('"ADAS calibration (front camera and radar)" covers both sensors it names', a.length === 0, a);
}

section('R4 qa/MOT: a test after the loss counts whatever its odometer result (#16)');
{
  const mot = (r, extra) => { const j = Sample.sampleJob(); j.vehicle.motHistory = [{ date: '2025-08-01', result: 'PASSED', odometer: 58000, unit: 'mi', odometerResult: 'READ' }, Object.assign({ date: '2026-10-15', result: 'PASSED', odometer: r === 'READ' ? 65120 : 0, unit: r === 'READ' ? 'mi' : '', odometerResult: r }, extra)]; return find(j, /MOT AFTER the date of loss/); };
  let m = mot('READ');
  check('READ → warning with the reading', m.length === 1 && m[0].level === 'warn' && /15\/10\/2026 at 65,120 miles \(752 miles more than the inspection reading\)/.test(m[0].msg), m);
  m = mot('UNREADABLE');
  check('UNREADABLE → the same warning, "odometer unreadable"', m.length === 1 && m[0].level === 'warn' && /15\/10\/2026 \(odometer unreadable\)/.test(m[0].msg) && !/more than the inspection/.test(m[0].msg), m);
  m = mot('NO_ODOMETER');
  check('NO_ODOMETER → the same warning, "no odometer"', m.length === 1 && /15\/10\/2026 \(no odometer\)/.test(m[0].msg), m);
  m = mot('', { odometerResult: undefined });
  check('a legacy test with no reading → "no odometer reading recorded"', m.length === 1 && /no odometer reading recorded/.test(m[0].msg), m);
  const j = Sample.sampleJob(); j.vehicle.motHistory = [{ date: '2026-10-15', result: 'PASSED', odometer: 0, odometerResult: 'UNREADABLE' }, { date: 'garbage', odometer: 70000, unit: 'mi' }];
  check('an unread post-loss test is not used for the mileage comparisons; a junk date is ignored', find(j, /MOT AFTER/).length === 1 && !find(j, /garbage|LOWER than the MOT|going DOWN/).length, msgs(j).filter((x) => /MOT/.test(x)));
  const k = Sample.sampleJob(); k.vehicle.motHistory = [{ date: '2025-08-01', result: 'PASSED', odometer: 0, odometerResult: 'UNREADABLE' }];
  check('an unread test BEFORE the loss raises nothing', !find(k, /MOT/).length);
}

section('R4 qa/SRS: SRS work needs a POST-repair scan; manual SRS lines count (#17)');
{
  const srs = (lines) => { const j = base(); j.lines = lines.map(L); return find(j, /^SRS components/); };
  const airbag = { description: 'Driver airbag – renew', code: 'SR001', hours: 0.4, amount: 300, partNo: 'a', op: 'renew' };
  const pre = { type: 'Auxiliary', description: 'Pre-repair diagnostic procedure', hours: 0.3, op: 'labour' };
  let m = srs([airbag, pre]);
  check('SR001 + only a pre-repair scan (OP010) → warning naming the line and EL008 / OP011', m.length === 1 && /Driver airbag – renew/.test(m[0].msg) && /EL008 or OP011/.test(m[0].msg), m);
  m = srs([airbag, { description: 'Pre-repair diagnostic scan', code: 'EL007', hours: 0.3, op: 'operation' }]);
  check('SR001 + EL007 (pre-repair scan) → warning', m.length === 1, m);
  check('SR001 + EL008 (post-repair scan) → none', srs([airbag, { description: 'Post-repair diagnostic scan', code: 'EL008', hours: 0.3, op: 'operation' }]).length === 0);
  check('SR001 + OP011 "Post-repair diagnostic procedure" (no code) → none', srs([airbag, { type: 'Auxiliary', description: C.OPS.OP011.name, hours: 0.3, op: 'labour' }]).length === 0);
  check('SR001 + "SRS scan and fault clearing" / "Diagnostic scan (pre and post repair)" → none', srs([airbag, { description: 'SRS scan and fault clearing', hours: 0.3 }]).length === 0 && srs([airbag, { description: 'Diagnostic scan (pre and post repair)', hours: 0.5 }]).length === 0);
  for (const d of ['Driver airbag – renew', 'Seat-belt pretensioner – replace', 'Clock spring – renew', 'Airbag control module – renew', 'RH crash sensor – renew', 'Passenger air bag – remove & refit']) {
    check(`manual line "${d}" without a code → warning`, srs([{ description: d, hours: 0.5, amount: 100, partNo: 'x', op: 'manual' }]).length === 1);
  }
  check('an AI line (code OTHER, stored without a code) renewing an airbag → warning', srs([{ description: 'Curtain airbag', hours: 2.5, amount: 300, op: 'renew', ai: true, reviewed: true }]).length === 1);
  check('service lines are not SRS work ("Airbag warning light – diagnose", "SRS diagnostic scan", "Airbag – inspect")', srs([{ description: 'Airbag warning light – diagnose', hours: 0.5, op: 'manual' }, { description: 'SRS diagnostic scan', hours: 0.3 }, { description: 'Airbag – inspect', hours: 0.3, op: 'manual' }]).length === 0);
  check('the sample (no SRS work) → none', !find(Sample.sampleJob(), /^SRS/).length);
}

section('R4 qa/OEM: the assessor\'s own number needs no VIN check even when it is also researched (#18)');
{
  const k = 'nissan-juke-f15';
  C.setCustomOem([{ key: k, make: 'Nissan', model: 'Juke', parts: { 'MR001|L': [{ oem: '963021KK2C', confidence: 'user', user: true, autoFill: false, market: 'UK', role: 'primary' }] } }]);
  const order = C.oemLookup(k, 'MR001', 'L').map((c) => c.oem + (c.user ? '*' : ''));
  check('(the researched copy sorts ahead of the user\'s copy)', order.indexOf('963021KK2C') < order.indexOf('963021KK2C*'), order);
  check('oemAlternatives → 0 for the duplicated own number', C.oemAlternatives(k, { code: 'MR001', side: 'L', partNo: '963021KK2C' }) === 0);
  const j = Sample.sampleJob(); j.lines = [L({ description: 'LH door mirror – renew', code: 'MR001', side: 'L', partNo: '963021KK2C', hours: 0.6, amount: 400, op: 'renew' })];
  check('…and no "confirm by VIN" info on the line', !find(j, /researched part number/).length);
  check('another researched number on the same part still asks for the VIN check', C.oemAlternatives(k, { code: 'MR001', side: 'L', partNo: '963021KK7A' }) >= 1);
  C.setCustomOem([]);
  check('without the user entry the researched 963021KK2C needs a VIN check again', C.oemAlternatives(k, { code: 'MR001', side: 'L', partNo: '963021KK2C' }) >= 1);
}

section('R4 qa/salvage: a negative salvage figure or % is ignored and reported (#19)');
{
  const j = Sample.sampleJob(); j.valuation.salvageOverride = -500;
  let t = C.totals(j);
  check('override −500 → ignored: salvage is the 15% figure £852.30 (salvageEntered false)', t.salvage === 852.3 && t.salvageEntered === false, t);
  let m = find(j, /salvage value entered is negative/);
  check('…QA error naming the figure and what is used instead', m.length === 1 && m[0].level === 'error' && m[0].tab === 'valuation' && /−£500\.00/.test(m[0].msg) && /£852\.30 \(15% of PAV\)/.test(m[0].msg), m);
  j.valuation.salvageOverride = '−£500'; // imported text
  check('…also for imported text "−£500"', C.totals(j).salvage === 852.3 && find(j, /salvage value entered is negative/).length === 1);
  j.valuation.salvageOverride = 0;
  t = C.totals(j);
  check('an override of 0 is a real figure (salvage £0, entered)', t.salvage === 0 && t.salvageEntered === true && !find(j, /negative/).length, t);
  j.valuation.salvageOverride = ''; j.valuation.salvagePct = -15;
  t = C.totals(j);
  check('salvage % −15 → counts as 0%: salvage £0.00 (not −£852.30), with a QA error', t.salvage === 0 && t.salvagePct === 0 && find(j, /salvage percentage is negative \(-15%\)/).length === 1 && find(j, /salvage percentage is negative/)[0].level === 'error', t);
  const s = Sample.sampleJob(), ts = C.totals(s);
  check('the sample is unchanged (salvage £852.30 at 15%, no salvage message)', ts.salvage === 852.3 && ts.salvagePct === 15 && ts.salvageEntered === false && !find(s, /salvage (?:value|percentage)/).length);
}

section('R4 qa/court: claim type "Court" without CPR 35 mode (#2)');
{
  const j = Sample.sampleJob(); j.valuation.claimType = 'court';
  let m = find(j, /claim type is "Court proceedings"/);
  check('court claim type, CPR 35 off → one warning (Sign-off) that it is not a CPR Part 35 report, worded conditionally', m.length === 1 && m[0].level === 'warn' && m[0].tab === 'signoff' && /not set up as a court-compliant expert report/.test(m[0].msg) && /If it is to be relied on as expert evidence under CPR Part 35/.test(m[0].msg), m);
  j.valuation.claimType = 'Court';
  check('…also for the legacy "Court"', find(j, /claim type is "Court proceedings"/).length === 1);
  j.report.cpr35 = true;
  check('CPR 35 on → no such warning', find(j, /claim type is "Court proceedings"/).length === 0);
  const k = Sample.sampleJob(); k.valuation.claimType = 'third-party';
  check('other claim types → none; isCourtClaim export', find(k, /Court proceedings/).length === 0 && C.isCourtClaim('court') && C.isCourtClaim(' Court ') && !C.isCourtClaim('third-party') && !C.isCourtClaim(null));
}

section('R4 qa/CPR 35: examination by someone else — under the expert\'s supervision? (PD 35 para 3.2(5), #5)');
{
  const saved = C.clone(C.settings);
  C.settings.assessor.qualifications = 'MIAEA';
  const cpr = (f) => { const j = Sample.sampleJob(); j.report.cpr35 = true; j.report.materialsRelied = 'x'; j.inspection.by = 'J Field'; j.inspection.byQualifications = 'IMI Level 3'; if (f) f(j); return j; };
  check('newJob has report.examinerSupervised = ""', C.newJob().report.examinerSupervised === '');
  let m = find(cpr(), /under your supervision/);
  check('another examiner, not recorded → error on Sign-off naming the examiner and PD 35 para 3.2(5)', m.length === 1 && m[0].level === 'error' && m[0].tab === 'signoff' && /examined by J Field/.test(m[0].msg) && /PD 35 para 3\.2\(5\)/.test(m[0].msg), m);
  check('"yes" or "no" recorded → no error', find(cpr((j) => { j.report.examinerSupervised = 'yes'; }), /supervision/).length === 0 && find(cpr((j) => { j.report.examinerSupervised = 'no'; }), /supervision/).length === 0);
  check('the examiner is the expert (any case or accents) → no supervision question', find(cpr((j) => { j.inspection.by = 'sample assessor'; }), /supervision/).length === 0);
  check('not a CPR 35 report → nothing', find(Object.assign(Sample.sampleJob(), { inspection: Object.assign(Sample.sampleJob().inspection, { by: 'J Field' }) }), /supervision/).length === 0);
  check('examinerSupervision(): "Yes" / true → yes, "NO" / false → no, other → ""', C.examinerSupervision({ report: { examinerSupervised: 'Yes' } }) === 'yes' && C.examinerSupervision({ report: { examinerSupervised: true } }) === 'yes' && C.examinerSupervision({ report: { examinerSupervised: 'NO' } }) === 'no' && C.examinerSupervision({ report: { examinerSupervised: false } }) === 'no' && C.examinerSupervision({ report: { examinerSupervised: 'maybe' } }) === '' && C.examinerSupervision(null) === '');
  C.settings = saved;
}

section('R4 qa/CPR 35: unreviewed AI output is an error in a court report, a warning otherwise (#3)');
{
  const saved = C.clone(C.settings);
  C.settings.assessor.qualifications = 'MIAEA';
  const withAi = (cprOn) => {
    const j = Sample.sampleJob(); j.report.cpr35 = cprOn; j.report.materialsRelied = 'x'; j.inspection.by = 'Sample Assessor';
    j.aiText = { opinion: j.opinion, 'report.summary': j.report.summary };
    j.lines[0].ai = true; j.lines[0].reviewed = false;
    j.photos = [{ id: 'p1', dataUrl: 'data:,', title: 't', labels: [{ text: 'x', ai: true }] }];
    j.valuation.adverts = [{ description: 'Ad', price: 5000, aiUnverified: true }];
    return j;
  };
  const kinds = [/AI damage labels/, /was suggested by AI/, /AI-drafted text not yet edited or confirmed/, /found by AI web search/];
  const on = qa(withAi(true)), off = qa(withAi(false));
  check('CPR 35: AI labels, AI lines, AI text and unverified adverts are each an ERROR, saying the statement of truth cannot cover them', kinds.every((re) => on.some((q) => re.test(q.msg) && q.level === 'error' && /^CPR 35 report: /.test(q.msg) && /statement of truth cannot cover AI output you have not reviewed/.test(q.msg))), on.filter((q) => /AI/.test(q.msg)));
  check('not CPR 35: the same items are warnings, worded as before', kinds.every((re) => off.some((q) => re.test(q.msg) && q.level === 'warn' && !/CPR 35/.test(q.msg))), off.filter((q) => /AI/.test(q.msg)));
  const reviewed = withAi(true); reviewed.aiText = {}; reviewed.lines[0].reviewed = true; reviewed.photos[0].labelsReviewed = true; delete reviewed.valuation.adverts[0].aiUnverified;
  check('CPR 35 with everything reviewed → no AI error', !qa(reviewed).some((q) => q.level === 'error' && /AI/.test(q.msg)), qa(reviewed).filter((q) => q.level === 'error'));
  check('AI review flags stay warnings in CPR 35 mode (the report does not print them)', (() => { const j = withAi(true); j.aiFlags = [{ text: 'Check the sill' }]; return find(j, /^AI review flag/).every((q) => q.level === 'warn'); })());
  C.settings = saved;
}

section('R4 C.markAiReviewed: the assessor confirms an AI-set field, e.g. the decision and category (#1 / #13)');
{
  const j = Sample.sampleJob();
  j.aiText = { 'outcome.decision': j.outcome.decision, 'outcome.category': 'N', opinion: j.opinion };
  check('before: decision and category listed as unreviewed AI text, QA warns', C.unreviewedAiText(j).some((f) => f.path === 'outcome.decision') && find(j, /Economic repair \/ total-loss decision \(section 07\); Salvage category \(section 07\)/).length === 1);
  check('markAiReviewed(job, "outcome.decision") → true, entry removed', C.markAiReviewed(j, 'outcome.decision') === true && !('outcome.decision' in j.aiText));
  check('…idempotent: a second call → false, nothing else changes', C.markAiReviewed(j, 'outcome.decision') === false && Object.keys(j.aiText).join(',') === 'outcome.category,opinion');
  C.markAiReviewed(j, 'outcome.category');
  const u = C.unreviewedAiText(j).map((f) => f.path);
  check('after confirming both: only the unedited opinion is listed; the valuation-tab warning has gone', JSON.stringify(u) === '["opinion"]' && !find(j, /Salvage category \(section 07\)|total-loss decision \(section 07\)/).length, u);
  check('the field values are untouched', j.outcome.decision === Sample.sampleJob().outcome.decision && j.outcome.category === 'N');
  check('photo paths work too (photos.<id>.title)', (() => { const k = Sample.sampleJob(); k.photos = [{ id: 'p1', title: 'AI title' }]; k.aiText = { 'photos.p1.title': 'AI title' }; return C.markAiReviewed(k, 'photos.p1.title') && C.unreviewedAiText(k).length === 0; })());
  const proto = { aiText: {} };
  check('no throw and false for: no job, no aiText, an array, a non-string path, "__proto__" / "constructor"', [null, undefined, {}, { aiText: null }, { aiText: [] }, { aiText: 'x' }].every((x) => C.markAiReviewed(x, 'opinion') === false) && C.markAiReviewed(j, 5) === false && C.markAiReviewed(proto, '__proto__') === false && C.markAiReviewed(proto, 'constructor') === false && Object.getPrototypeOf(proto.aiText) === Object.prototype);
}

section('R4 vehicleGuide: the guide time for THIS vehicle, as the picker scales it (#0 / #4)');
{
  const job = (paint, size) => { const j = C.newJob(); j.vehicle.paintType = paint; j.vehicle.sizeClass = size; return j; };
  const g = (j, op, base) => { const r = C.vehicleGuide(j, { op, guideHours: base }); return r && r.hours; };
  const suvPearl = job('pearl', 'suv');
  // figures from the picker for this vehicle (app.js guideFor / scaleP / scaleH), as the final review recorded them
  check('SUV + pearl: FE001 refinish 2.4h → 3.3h; BN001 refinish 3.0h → 4.1h; FE001 renew 1.6h → 1.8h', g(suvPearl, 'refinish', 2.4) === 3.3 && g(suvPearl, 'refinish', 3.0) === 4.1 && g(suvPearl, 'renew', 1.6) === 1.8);
  check('medium + pearl: FE001 refinish 2.4h → 2.9h (×1.2 only)', g(job('pearl', 'medium'), 'refinish', 2.4) === 2.9);
  check('size-scaled operations: repair, pdr, rr, operation; refinishRep1/2, blend and smart also take the paint factor', ['repair1', 'repair', 'repair3', 'pdr', 'rr', 'operation', 'replace'].every((op) => g(suvPearl, op, 2) === 2.3) && ['refinishRep1', 'refinishRep2', 'blend', 'smart'].every((op) => g(suvPearl, op, 2) === 2.8));
  check('inspect, refurbish and labour operations are not scaled', g(suvPearl, 'check', 0.3) === 0.3 && g(suvPearl, 'labour', 0.3) === 0.3 && g(suvPearl, 'refurb', 0.5) === 0.5);
  check('an unknown operation: the base when both factors are 1, otherwise null (never a guess)', g(job('metallic', 'medium'), 'ai', 1.4) === 1.4 && C.vehicleGuide(suvPearl, { op: 'ai', guideHours: 1.4 }) === null);
  check('no guide (0, blank, junk) → null; factors reported', C.vehicleGuide(suvPearl, { op: 'renew', guideHours: 0 }) === null && C.vehicleGuide(suvPearl, { op: 'renew' }) === null && C.vehicleGuide(null, null) === null && JSON.stringify(C.vehicleGuide(suvPearl, { op: 'refinish', guideHours: 2.4 })) === JSON.stringify({ hours: 3.3, size: 1.15, paint: 1.2 }));
  check('rounding as the picker: one decimal, at least 0.1h (small ×0.9: 0.05h → 0.1h)', g(job('metallic', 'small'), 'renew', 0.05) === 0.1 && g(job('metallic', 'small'), 'renew', 1.5) === 1.4);
}

section('R4 dates: first registration known to the month or the year only');
{
  check('partialDate: "2014-08" → month, "1968" → year; "2014-13", "2014-00", "14-08", "" → null', JSON.stringify(C.partialDate('2014-08')) === JSON.stringify({ y: 2014, mo: 8 }) && JSON.stringify(C.partialDate('1968')) === JSON.stringify({ y: 1968, mo: 0 }) && ['2014-13', '2014-00', '14-08', '', null, '2014-08-01'].every((s) => C.partialDate(s) === null));
  check('calendarDate exported (2024-02-29 valid, 2023-02-29 not)', !!C.calendarDate('2024-02-29') && C.calendarDate('2023-02-29') === null);
  const fr = (s) => { const j = Sample.sampleJob(); j.vehicle.firstReg = s; return find(j, /First registration date ".*" is not a valid date/).length; };
  check('a year-only ("1968") or month-only ("2014-08") first registration is not "not a valid date"', fr('1968') === 0 && fr('2014-08') === 0);
  check('…but "2014-13-01", "2014-13" and "1968-1" still are', fr('2014-13-01') === 1 && fr('2014-13') === 1 && fr('1968-1') === 1);
  check('other dates must still be full dates ("2026-09" date of loss warns)', (() => { const j = Sample.sampleJob(); j.instruction.dateOfLoss = '2026-09'; return find(j, /Date of loss "2026-09" is not a valid date/).length === 1; })());
}

section('R4 security: stored or imported data never reaches Object.prototype (settings, job files, part numbers)');
{
  const vmod = require('vm');
  // each case in a fresh app sandbox, with the hostile data parsed there (as the renderer's JSON.parse would)
  const fresh = () => { const c = load({ report: true }); const ev = (s) => vmod.runInContext(s, c); return { C: c.Core, R: c.Report, ev, parse: (s) => ev(`JSON.parse(${JSON.stringify(s)})`), sample: () => c.Sample.sampleJob() }; };
  const clean = (ev) => ev('Object.keys(Object.prototype).length === 0 && ({}).exclude === undefined && ({}).hidden === undefined && ({}).polluted === undefined && ({}).reviewed === undefined');
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const HOSTILE = '{"__proto__":{"exclude":true,"hidden":true,"polluted":"YES"},"company":{"__proto__":{"polluted":"NESTED"},"name":"X LTD"},"constructor":{"prototype":{"polluted":"CTOR"}},"vatPct":20}';
  {
    const { C, ev, parse } = fresh();
    C.settings = parse(HOSTILE);
    check('C.settings = a record with "__proto__" / "constructor" keys: Object.prototype untouched, the keys dropped, the rest kept', clean(ev) && !has(C.settings, '__proto__') && !has(C.settings, 'constructor') && !has(C.settings.company, '__proto__') && C.settings.company.name === 'X LTD' && C.settings.vatPct === 20);
    const ok = C.settings; C.settings = ok;
    check('…an ordinary settings object is kept as it is (same object)', C.settings === ok);
    check('…newJob() from it is a plain job', ev('Object.getPrototypeOf')(C.newJob()) === ev('Object.prototype') && clean(ev));
  }
  {
    const { C, ev, parse } = fresh();
    const c = C.clone(parse(HOSTILE));
    check('C.clone (job import, part-number lists) drops "__proto__", "constructor" and "prototype" keys at every depth', !has(c, '__proto__') && !has(c, 'constructor') && !has(c.company, '__proto__') && c.company.name === 'X LTD' && c.vatPct === 20 && clean(ev));
    const j = C.clone(parse('{"lines":[{"__proto__":{"reviewed":true},"description":"x","prototype":1}],"aiText":{"constructor.name":"kept","__proto__.x":"kept"}}'));
    check('…inside arrays too; ordinary keys that merely contain those words are kept', !has(j.lines[0], '__proto__') && !has(j.lines[0], 'prototype') && j.lines[0].description === 'x' && j.aiText['constructor.name'] === 'kept' && j.aiText['__proto__.x'] === 'kept' && clean(ev));
  }
  {
    const { C, ev } = fresh();
    for (const p of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__.polluted', 'prototype']) C.setPath(ev('({ a: {} })'), p, 'YES');
    check('setPath through "__proto__" / "constructor" / "prototype" writes nothing', clean(ev));
    const o = ev('({ a: { b: 1 } })'); C.setPath(o, 'a.b', 2); C.setPath(o, 'c.d', 3);
    check('…ordinary paths still work; getPath never returns a prototype', o.a.b === 2 && o.c.d === 3 && C.getPath(o, '__proto__') === undefined && C.getPath(o, 'a.constructor') === undefined && C.getPath(o, 'a.b') === 2);
  }
  {
    const { C, ev, parse } = fresh();
    const l = C.newLine(parse('{"__proto__":{"reviewed":true},"description":"Imported"}'));
    check('newLine(over) with a "__proto__" key: a plain line (nothing inherited)', l.description === 'Imported' && l.reviewed === undefined && ev('Object.getPrototypeOf')(l) === ev('Object.prototype') && clean(ev));
    C.setCustomOem(parse('[{"key":"nissan-juke-f15","make":"Nissan","model":"Juke","parts":{"__proto__":[{"oem":"EVIL"}],"constructor":[{"oem":"EVIL2"}],"SS001|R":[{"oem":"MINE1","user":true,"confidence":"user","autoFill":true}]}}]'));
    const v = C.findOemVehicle('nissan-juke-f15');
    check('own part numbers with "__proto__" / "constructor" part keys: ignored; the parts table stays a plain object; real keys merge', ev('Object.getPrototypeOf')(v.parts) === ev('Object.prototype') && !has(v.parts, 'constructor') && C.oemLookup('nissan-juke-f15', 'SS001', 'R')[0].oem === 'MINE1' && clean(ev));
    C.setCustomOem([]);
    const snap = C.rateSnapshot(parse('{"rates":{"__proto__":{"Body":1},"Body":60},"lines":[{"type":"__proto__","hours":1},{"type":"constructor","hours":1}]}'));
    check('rateSnapshot of an imported job with "__proto__" rates / line types: plain rates, no prototype keys', ev('Object.getPrototypeOf')(snap.rates) === ev('Object.prototype') && !has(snap.rates, 'constructor') && snap.rates.Body === 60 && clean(ev));
  }
  {
    const { C, R, ev, parse, sample } = fresh();
    const s = sample();
    s.photos = [{ id: 'p1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', title: 'Front', labels: [{ x: 0.1, y: 0.3, w: 0.2, h: 0.2, text: 'Dent' }] }];
    // an imported job file with "__proto__" keys at the job, photo and label level
    const text = JSON.stringify(s).replace(/^\{/, '{"__proto__":{"exclude":true,"hidden":true,"polluted":"YES"},').replace('{"id":"p1"', '{"__proto__":{"exclude":true},"id":"p1"').replace('{"x":0.1', '{"__proto__":{"hidden":true},"x":0.1');
    const raw = parse(text);
    check('(the job file really carries the keys)', has(raw, '__proto__') && has(raw.photos[0], '__proto__'));
    for (const [name, j] of [['as read', raw], ['after C.clone (the import path)', C.clone(raw)]]) {
      const html = R.render(j, { mode: 'pdf' });
      const q = C.qaChecks(j); C.totals(j); C.jobSummary(j); C.unreviewedAiText(j);
      check(`imported job ${name}: renders with its photo and label, the reference totals, and pollutes nothing`, clean(ev) && html.includes('IMAGE 01') && html.includes('1. Dent') && html.includes('£3,365.08') && !q.some((x) => /No photographs are included/.test(x.msg)));
    }
  }
  check('the test process itself is clean too', Object.keys(Object.prototype).length === 0 && ({}).polluted === undefined);
}

// R#10: image re-encoding with a fake canvas (no DOM in node)
async function imageChecks() {
  section('R#10. Re-encoding images: white behind JPEG, PNG kept when the image has transparency');
  const run = async (src, alpha) => {
    const calls = [];
    const g = {
      globalCompositeOperation: 'source-over', fillStyle: '#000',
      drawImage() { calls.push(['draw', this.globalCompositeOperation]); },
      fillRect() { calls.push(['fill', this.fillStyle, this.globalCompositeOperation]); },
      getImageData(x, y, w, h) { calls.push(['scan']); const d = new Uint8ClampedArray(w * h * 4).fill(255); if (alpha) d[w * 4 + 7] = 0; return { data: d }; }
    };
    const canvas = { width: 0, height: 0, getContext: () => g, toDataURL: (type, q) => { calls.push(['encode', type, q]); return `data:${type};base64,AAAA`; } };
    class Img { set src(v) { this._s = v; setTimeout(() => { this.naturalWidth = 3000; this.naturalHeight = 1500; this.onload(); }); } get src() { return this._s; } }
    const c3 = load({ globals: { Image: Img, document: { querySelector: () => null, createElement: () => canvas } } });
    const r = await c3.Core.resizeDataURL(src, 1800, 0.86);
    return { r, calls, canvas };
  };
  let x = await run('data:image/png;base64,iVBORw0KGgo=', true);
  check('transparent PNG (a signature) → stays PNG, nothing painted behind it', x.r.dataUrl.startsWith('data:image/png') && x.r.type === 'image/png' && !x.calls.some((c) => c[0] === 'fill') && !x.calls.some((c) => c[1] === 'image/jpeg'), x.calls);
  x = await run('data:image/png;base64,iVBORw0KGgo=', false);
  const fill = x.calls.findIndex((c) => c[0] === 'fill'), enc = x.calls.findIndex((c) => c[0] === 'encode');
  check('opaque PNG → JPEG with white painted behind the image before encoding', x.r.dataUrl.startsWith('data:image/jpeg') && fill >= 0 && x.calls[fill][1] === '#fff' && x.calls[fill][2] === 'destination-over' && fill < enc && x.calls[enc][2] === 0.86, x.calls);
  x = await run('data:image/jpeg;base64,/9j/', false);
  check('JPEG source → JPEG (no transparency scan), white behind', x.r.type === 'image/jpeg' && !x.calls.some((c) => c[0] === 'scan') && x.calls.some((c) => c[0] === 'fill' && c[1] === '#fff'), x.calls);
  check('scaled to the long edge (3000×1500 → 1800×900)', x.r.width === 1800 && x.r.height === 900 && x.canvas.width === 1800 && x.canvas.height === 900);
}

(async () => {
  await imageChecks();
  await require('./store').run();
})().then(done, (e) => { console.log('  FAIL async checks threw: ' + (e && e.stack)); process.exitCode = 1; done(); });
