// Mangles random fields of the sample job (delete / null / wrong type) and checks totals(), qaChecks(), unreviewedAiText(), markAiReviewed(), vehicleGuide(),
// jobSummary(), rateSnapshot() and (every 10th job) Report.render() never throw.
'use strict';
const { load } = require('./harness');
const ctx = load({ report: true });
const C = ctx.Core;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const junk = [undefined, null, 0, 1, -5, '', 'x', 'abc def', [], [null], {}, { a: 1 }, true, NaN, '2026-13-45', [{}], [1, 'a']];
function paths(o, pre, out) {
  if (o && typeof o === 'object') for (const k of Object.keys(o)) { const p = pre.concat(k); out.push(p); if (out.length < 4000) paths(o[k], p, out); }
  return out;
}
let fails = 0, runs = 0;
for (let n = 0; n < 3000; n++) {
  const j = ctx.Sample.sampleJob();
  if (n % 3 === 0) { j.aiLog = [{ ai: true }, { ai: false }]; j.photos = [{ id: 'a', labels: [{ ai: true }], title: 'VIN' }, { id: 'b', exclude: true }]; j.report.cpr35 = true; j.vehicle.motHistory = [{ date: '2025-01-01', odometer: 1000, unit: 'km', testNumber: 'T1' }]; j.issued = { at: '2026-09-06T00:00:00Z', rates: { Body: 70 }, vatPct: 20 }; }
  if (n % 3 === 1) { j.aiText = { opinion: j.opinion, 'photos.a.title': 'VIN', 'circumstances.impactType': j.circumstances.impactType, 'x.y.z': 'q' }; j.aiFlags = [{ section: 'Opinion', text: 'Check', at: '2026-09-06T00:00:00Z' }]; j.valuation.adverts = [{ description: 'Ad', price: '£5,000', aiUnverified: true, claimedUrl: 'https://x' }]; j.vehicle.adas = 'camera'; j.valuation.claimType = 'third-party'; j.vehicle.dvla = { co2Emissions: 0, euroStatus: 'EURO 6', lookedUpAt: 'x' }; }
  if (n % 3 === 2) { // round 4: guide notes, supervision, court claim type, DVLA flags not given, year-only dates, negative salvage, unread MOTs, SRS
    j.vehicle.paintType = 'pearl'; j.vehicle.sizeClass = 'suv'; j.vehicle.firstReg = '1968'; j.vehicle.firstRegPrecision = 'year';
    j.vehicle.dvla = { markedForExport: null, markedAsScrapped: null, importedOrReRegistered: true, firstRegistration: '', firstRegistrationYear: 1968, firstRegistrationWithDvla: '1975-06-01' };
    j.vehicle.motHistory = [{ date: '2026-10-15', result: 'PASSED', odometer: 0, odometerResult: 'UNREADABLE' }, { date: '2025-08-01', odometer: 61000, unit: 'mi', odometerResult: 'READ' }];
    j.report.cpr35 = true; j.report.examinerSupervised = 'yes'; j.inspection.by = 'J Field'; j.valuation.claimType = 'court'; j.valuation.salvageOverride = -500; j.valuation.salvagePct = -15;
    j.lines.push(C.newLine({ type: 'Painting', description: 'Front bumper – refinish', code: 'FE001', op: 'refinish', hours: 3, guideHours: 2.4, hoursBasis: 'adjusted', ai: true, pfApplied: 1.2, costClass: 'paint' }), C.newLine({ description: 'Driver airbag – renew', op: 'manual', hours: 0.4, amount: 300 }));
    j.rates.Body = ''; j.aiText = { 'outcome.decision': j.outcome.decision };
  }
  const ps = paths(j, [], []);
  const k = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < k; i++) {
    const p = ps[Math.floor(rnd() * ps.length)];
    let o = j; for (let q = 0; q < p.length - 1; q++) { o = o && o[p[q]]; }
    if (!o || typeof o !== 'object') continue;
    const r = rnd();
    if (r < 0.3) delete o[p[p.length - 1]]; else o[p[p.length - 1]] = junk[Math.floor(rnd() * junk.length)];
  }
  runs++;
  try {
    C.totals(j); C.qaChecks(j); C.photoNumbers(j); C.guessOemVehicle(j.vehicle); C.decodeVin(j.vehicle && j.vehicle.vin);
    C.unreviewedAiText(j); C.jobSummary(j); C.rateSnapshot(j); C.examinerSupervision(j);
    for (const l of (Array.isArray(j.lines) ? j.lines : []).slice(0, 5)) C.vehicleGuide(j, l);
    C.markAiReviewed(j, 'outcome.decision');
    if (n % 10 === 0) ctx.Report.render(j, { mode: n % 20 ? 'pdf' : 'print' });
  }
  catch (e) { fails++; if (fails <= 5) console.log('THROW', e.message, '\n', e.stack.split('\n').slice(0, 3).join('\n')); }
}
console.log(`${runs} mangled jobs, ${fails} threw`);
process.exitCode = fails ? 1 : 0;
