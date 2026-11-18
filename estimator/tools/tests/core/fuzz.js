// Mangles random fields of the sample job (delete / null / wrong type) and checks totals() and qaChecks() never throw.
'use strict';
const { load } = require('./harness');
const ctx = load();
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
  if (n % 3 === 0) { j.aiLog = [{ ai: true }, { ai: false }]; j.photos = [{ id: 'a', labels: [{ ai: true }], title: 'VIN' }, { id: 'b', exclude: true }]; j.report.cpr35 = true; j.vehicle.motHistory = [{ date: '2025-01-01', odometer: 1000, unit: 'km' }]; j.issued = { at: '2026-09-06T00:00:00Z' }; }
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
  try { C.totals(j); C.qaChecks(j); C.photoNumbers(j); C.guessOemVehicle(j.vehicle); C.decodeVin(j.vehicle && j.vehicle.vin); }
  catch (e) { fails++; if (fails <= 5) console.log('THROW', e.message, '\n', e.stack.split('\n').slice(0, 3).join('\n')); }
}
console.log(`${runs} mangled jobs, ${fails} threw`);
process.exitCode = fails ? 1 : 0;
