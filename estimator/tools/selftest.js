#!/usr/bin/env node
/* Self-test: loads the app's own scripts in a sandbox and checks the sample job reproduces the reference report's figures. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const app = path.join(__dirname, '..', 'app');
const ctx = { console, window: {}, document: { querySelector: () => null }, indexedDB: null, setTimeout, clearTimeout };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['data/catalogue.js', 'data/oem.js', 'data/variants.js', 'js/core.js', 'js/report.js', 'js/sample.js']) {
  vm.runInContext(fs.readFileSync(path.join(app, f), 'utf8'), ctx, { filename: f });
}
const C = ctx.Core;
const job = ctx.Sample.sampleJob();
const t = C.totals(job);
const expect = { labourHours: 20.2, labour: 1464.5, parts: 1003.58, paint: 350, other: 547, net: 3365.08, vat: 673.02, gross: 4038.1, salvage: 852.3, pctNet: 59.22, pctGross: 71.07 };
for (const [k, v] of Object.entries(expect)) assert.strictEqual(t[k], v, `${k}: expected ${v}, got ${t[k]}`);
console.log('✓ totals match the reference report (net £3,365.08, gross £4,038.10, 59.22% / 71.07%)');

const codes = new Set(ctx.CATALOGUE.map((r) => r[0]));
assert.strictEqual(codes.size, ctx.CATALOGUE.length, 'duplicate catalogue codes');
for (const v of ctx.OEM_VEHICLES) for (const k of Object.keys(v.parts)) assert(codes.has(k.split('|')[0]), `${v.key}: unknown code ${k}`);
console.log(`✓ catalogue: ${codes.size} parts, ${ctx.OEM_VEHICLES.length} OEM vehicles, all codes valid`);

const juke = C.guessOemVehicle(job.vehicle);
assert(juke && juke.key === 'nissan-juke-f15', 'Juke should map to nissan-juke-f15');
assert.strictEqual(C.oemLookup('nissan-juke-f15', 'SS001', 'R')[0].oem, '768501KA6A');
console.log('✓ OEM lookup: Juke RH sill moulding → 768501KA6A');

// generation-safe OEM matching
assert.strictEqual((C.guessOemVehicle({ make: 'Mercedes-Benz', model: 'E-Class (W213)', firstReg: '2019-03-01' }) || {}).key, 'mercedes-e-class-w213');
assert.strictEqual(C.guessOemVehicle({ make: 'Mercedes-Benz', model: 'E-Class (W214)', firstReg: '2024-05-01' }), null, 'W214 must not get W213 part numbers');
assert.strictEqual(C.guessOemVehicle({ make: 'Mercedes-Benz', model: 'E-Class', firstReg: '2024-05-01' }), null, 'out-of-range year must not match');
console.log('✓ OEM matching is generation-safe (W213 ≠ W214)');

// variants
const V = ctx.VARIANTS;
assert(V.length >= 50, 'variant generations loaded');
const w213 = V.find((m) => m.make === 'Mercedes-Benz' && m.model === 'E-Class' && /W213/.test(m.generation));
assert(w213 && w213.engines.some((e) => /E 220 d/.test(e.badge)), 'E 220 d present');
assert([...w213.trims, ...Object.values(w213.trims_by_period || {}).flat()].some((t) => /AMG Line Premium Plus/.test(t)), 'AMG Line Premium Plus present');
for (const m of V) { assert(m.make && m.model && Array.isArray(m.engines) && m.engines.length, `variant ${m.make} ${m.model} has engines`); }
console.log(`✓ variants: ${V.length} model generations, ${V.reduce((n, m) => n + m.engines.length, 0)} engines (E 220 d AMG Line Premium Plus available)`);

const vin = C.decodeVin(job.vehicle.vin);
assert(vin.valid && /Nissan/.test(vin.manufacturer), 'VIN decode');
assert(C.decodeVin('ABC').issues.length > 0);
console.log('✓ VIN decode');

const qa = C.qaChecks(job);
assert(!qa.some((q) => q.level === 'error'), 'sample job should have no QA errors: ' + JSON.stringify(qa));
console.log(`✓ QA checks: ${qa.length} notes, no errors`);

for (const mode of ['preview', 'print', 'pdf']) {
  const html = ctx.Report.render(job, { mode });
  assert(html.includes('£3,365.08') && html.includes('£4,038.10') && html.includes('59.22%') && html.includes('TOTAL LOSS RECOMMENDED') && html.includes('Category N'), 'report content (' + mode + ')');
}
const out = path.join(__dirname, '..', 'dist-test');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'sample-report.html'), ctx.Report.render(job, { mode: 'print' }));
console.log('✓ report renders (preview / print / pdf) → dist-test/sample-report.html');

// AI module loads, schemas are strict-valid (every object has additionalProperties:false and all keys required)
const ai = require('../ai');
function checkSchema(s, p) {
  if (s.type === 'object') {
    assert.strictEqual(s.additionalProperties, false, p + ' additionalProperties');
    assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort(), p + ' required');
    for (const [k, v] of Object.entries(s.properties)) checkSchema(v, p + '.' + k);
  } else if (s.type === 'array') checkSchema(s.items, p + '[]');
}
checkSchema(ai.PHOTO_SCHEMA, 'photo');
checkSchema(ai.NARRATIVE_SCHEMA, 'narrative');
assert(ai.SYSTEM.includes('SS001 | Sill exterior moulding'));
console.log('✓ AI module loads; structured-output schemas are valid; catalogue is in the system prompt');
console.log('All self-tests passed.');
