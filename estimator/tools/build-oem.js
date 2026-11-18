#!/usr/bin/env node
/*
 * Compiles research/*.json (plus any extra JSON files passed as arguments) into app/data/oem.js.
 *
 * Research entry fields: code, side, oem, description, notes, price_gbp, price_basis ('inc_vat' | 'ex_vat'),
 * price_source, source_url, confidence ('confirmed' | 'single-source'), and optionally
 *   role: 'primary' (default) | 'variant'  (variant-only numbers are never the default)
 *   autoFill: false                        (offered in the picker but never auto-filled; single-source and
 *                                           variant entries are never auto-filled whatever this says)
 *   market: 'UK' | 'unknown' | 'EU-LHD' | 'US'
 *
 * `node tools/build-oem.js --validate [extra.json ...]` checks the research (and any extra files) and writes nothing.
 *
 * Output prices are EX VAT (estimate lines are ex VAT; the app adds VAT once). Researched shop prices are
 * UK retail prices including 20% VAT, so they are divided by 1.2; the original is kept as priceIncVat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'research');
const VAT = 1.2;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// catalogue (for code/side validation)
const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'app', 'data', 'catalogue.js'), 'utf8'), sb);
const CAT = Object.fromEntries(sb.window.CATALOGUE.map((r) => [r[0], { sided: !!r[3] }]));
// parts fitted per corner/side but not handed: a blank side means "fits either side"
const NOT_HANDED = new Set(['WT001', 'WT002', 'WT003', 'WT004', 'WT005', 'WT006', 'WT007', 'WT008', 'BN003', 'TG003']);
const MARKET_RANK = { UK: 0, unknown: 1, 'EU-LHD': 2, US: 3 };

const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// An extra file named like a research file replaces it (e.g. validating an extended copy of research/vw-golf-mk7.json).
const extraKeys = new Set(extra.map((f) => path.basename(f, '.json')));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !extraKeys.has(path.basename(f, '.json'))).map((f) => path.join(dir, f)).concat(extra);
if (extraKeys.size !== extra.length) { console.error('Two extra files have the same name.'); process.exit(1); }
const errors = [];
const vehicles = [];
const FIELDS = new Set(['code', 'side', 'oem', 'description', 'notes', 'price_gbp', 'price_basis', 'price_source', 'source_url', 'confidence', 'role', 'autoFill', 'market']);
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u);
for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errors.push(`${path.basename(f)}: not valid JSON (${e.message})`); continue; }
  const key = path.basename(f, '.json');
  const veh = d && d.vehicle;
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(key)) errors.push(`${key}: file name must be lower-case words joined by hyphens (e.g. ford-fiesta-mk8.json)`);
  if (!veh || !veh.make || !veh.model || !veh.generation) { errors.push(`${key}: vehicle.make, vehicle.model and vehicle.generation are required`); continue; }
  if (!/^\d{4}-(\d{4})?$/.test(String(veh.years || ''))) errors.push(`${key}: vehicle.years must look like "2017-2023" or "2019-"`);
  if (!Array.isArray(d.parts) || !d.parts.length) { errors.push(`${key}: parts must be a non-empty array`); continue; }
  const parts = {};
  const seen = new Set();
  d.parts.forEach((p, idx) => {
    const side = p.side || '';
    const at = `${key} parts[${idx}] ${p.code || '?'} ${p.oem || '?'}`;
    for (const k of Object.keys(p)) if (!FIELDS.has(k)) errors.push(`${at}: unknown field "${k}"`);
    if (typeof p.oem !== 'string' || !/^[A-Z0-9][A-Z0-9 .\-/]{3,30}$/i.test(p.oem.trim())) errors.push(`${at}: oem must be a part number (letters, digits, spaces, . - /)`);
    if (typeof p.description !== 'string' || !p.description.trim()) errors.push(`${at}: description is required`);
    if (!isUrl(p.source_url)) errors.push(`${at}: source_url must be the http(s) address the number was found at`);
    if (!['confirmed', 'single-source'].includes(p.confidence)) errors.push(`${at}: confidence must be "confirmed" or "single-source"`);
    if (p.role != null && !['primary', 'variant'].includes(p.role)) errors.push(`${at}: role must be "primary" or "variant"`);
    if (p.autoFill != null && typeof p.autoFill !== 'boolean') errors.push(`${at}: autoFill must be true or false`);
    if (p.market != null && !['', 'UK', 'unknown', 'EU-LHD', 'US'].includes(p.market)) errors.push(`${at}: market must be UK, unknown, EU-LHD or US`);
    if (!['', 'L', 'R'].includes(side)) errors.push(`${at}: side must be "L", "R" or blank`);
    if (p.price_gbp != null && p.price_gbp !== '') {
      const v = Number(p.price_gbp);
      if (!(v > 0 && v < 50000)) errors.push(`${at}: price_gbp must be a positive number of pounds`);
      if (!['inc_vat', 'ex_vat'].includes(p.price_basis)) errors.push(`${at}: price_basis "inc_vat" or "ex_vat" is required with a price`);
      if (!isUrl(p.price_source)) errors.push(`${at}: price_source must be the http(s) address the price was found at`);
    }
    const dup = `${p.code}|${side}|${String(p.oem).replace(/[\s.\-/]/g, '').toUpperCase()}`;
    if (seen.has(dup)) errors.push(`${at}: the same number is listed twice for this part and side`);
    seen.add(dup);
    if (!CAT[p.code]) errors.push(`${key}: unknown catalogue code ${p.code} (${p.oem})`);
    else if (!CAT[p.code].sided && side) errors.push(`${key}: ${p.code} is not a sided part but has side "${side}" (${p.oem})`);
    else if (CAT[p.code].sided && !side && !NOT_HANDED.has(p.code)) errors.push(`${key}: ${p.code} is a handed part but ${p.oem} has no side`);
    let confidence = p.confidence || 'single-source';
    if (p.market && p.market !== 'UK' && p.market !== 'unknown' && confidence === 'confirmed') confidence = 'single-source';
    let price = null, priceIncVat = null;
    if (p.price_gbp != null && p.price_gbp !== '') {
      const v = Number(p.price_gbp);
      if (p.price_basis === 'ex_vat') { price = round2(v); priceIncVat = round2(v * VAT); } else { price = round2(v / VAT); priceIncVat = round2(v); }
    }
    const k = p.code + '|' + side;
    (parts[k] = parts[k] || []).push({
      oem: p.oem, description: p.description, notes: p.notes || '', price, priceIncVat, priceSource: p.price_source || '',
      // Only numbers confirmed by two sources (or the manufacturer's UK shop) and not variant-specific are ever filled in
      // automatically; everything else is offered in the picker for the assessor to choose by VIN.
      source: p.source_url || '', confidence, role: p.role === 'variant' ? 'variant' : 'primary',
      autoFill: p.autoFill !== false && confidence === 'confirmed' && p.role !== 'variant',
      market: p.market || '', _i: idx
    });
  });
  // default order: primary before variant, auto-fill candidates first, UK market first, confirmed first, then research order
  for (const list of Object.values(parts)) {
    list.sort((a, b) => (a.role === 'variant') - (b.role === 'variant') || (b.autoFill - a.autoFill) ||
      (MARKET_RANK[a.market || 'unknown'] - MARKET_RANK[b.market || 'unknown']) ||
      ((a.confidence === 'confirmed' ? 0 : 1) - (b.confidence === 'confirmed' ? 0 : 1)) || (a._i - b._i));
    list.forEach((x) => { delete x._i; });
  }
  vehicles.push({ key, make: d.vehicle.make, model: d.vehicle.model, generation: d.vehicle.generation, years: d.vehicle.years, notes: d.vehicle.notes || '', researched: d.researched || '', parts });
}
if (errors.length) { console.error('Research data errors:\n - ' + errors.join('\n - ')); process.exit(1); }
if (process.argv.includes('--validate')) {
  // Check research files (all of research/*.json plus any given as arguments) without writing anything.
  for (const v of vehicles.filter((x) => !extra.length || extra.some((f) => path.basename(f, '.json') === x.key))) {
    const list = Object.values(v.parts).flat();
    console.log(`✓ ${v.key}: ${list.length} numbers (${list.filter((x) => x.confidence === 'confirmed').length} confirmed, ${list.filter((x) => x.price != null).length} priced)`);
  }
  process.exit(0);
}
vehicles.sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model));
const out = `/* GENERATED by tools/build-oem.js from research/*.json. Do not edit by hand.\n   Prices are EX VAT (UK retail shop prices / 1.2); priceIncVat holds the shop price. */\nwindow.OEM_VEHICLES = ${JSON.stringify(vehicles, null, 1)};\n`;
const target = path.join(root, 'app', 'data', 'oem.js');
if (process.argv.includes('--check')) {
  // CI: verify the committed oem.js matches research/*.json (and that the research validates)
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== out.replace(/\r\n/g, '\n')) { console.error('app/data/oem.js is out of date: run `npm run build:oem`.'); process.exit(1); }
  console.log('✓ app/data/oem.js is in sync with research/*.json');
  process.exit(0);
}
fs.writeFileSync(target, out);
const all = vehicles.flatMap((v) => Object.values(v.parts).flat());
console.log(`Wrote ${vehicles.length} vehicles, ${all.length} part numbers (${all.filter((x) => x.confidence === 'confirmed').length} confirmed, ${all.filter((x) => !x.autoFill).length} not auto-filled, ${all.filter((x) => x.price != null).length} priced ex VAT).`);
