// Loads the renderer data + core (+ sample) in a vm sandbox, like tools/selftest.js. Read-only.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const APP = path.join(__dirname, '..', '..', '..', 'app');
// opts.report: also load report.js; opts.indexedDB: an IndexedDB factory for Core.Store (default none); opts.globals: more globals.
function load(opts) {
  const ctx = Object.assign({ console, window: {}, document: { querySelector: () => null }, indexedDB: (opts && opts.indexedDB) || null, setTimeout, clearTimeout, DOMException, structuredClone }, (opts && opts.globals) || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  const files = ['data/catalogue.js', 'data/oem.js', 'data/variants.js', 'js/core.js', 'js/sample.js'];
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), ctx, { filename: f });
  if (opts && opts.report) {
    try { vm.runInContext(fs.readFileSync(path.join(APP, 'js/report.js'), 'utf8'), ctx, { filename: 'js/report.js' }); } catch (e) { ctx.__reportError = e; }
  }
  return ctx;
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function section(t) { console.log('\n## ' + t); }
function done() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1; }
module.exports = { load, check, section, done, APP };
