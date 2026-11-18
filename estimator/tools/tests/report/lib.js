/* Shared helpers for the report.js checks: vm-loads the app scripts the way tools/selftest.js does.
 * Contract exports that core.js does not provide yet are stubbed HERE (never in report.js). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', '..', '..', 'app');
const DIR = __dirname;

function load() {
  const ctx = { console, window: {}, document: { querySelector: () => null }, indexedDB: null, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['data/catalogue.js', 'data/oem.js', 'data/variants.js', 'js/core.js']) {
    vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), ctx, { filename: f });
  }
  const C = ctx.Core;
  const stubs = [];
  const num = C.num;
  if (typeof C.photoNumbers !== 'function') {
    stubs.push('photoNumbers');
    C.photoNumbers = (job) => { const m = new Map(); let k = 0; for (const p of job.photos || []) if (!p.exclude) m.set(p.id, ++k); return m; };
  }
  if (typeof C.lineLabour !== 'function') {
    stubs.push('lineLabour');
    C.lineLabour = (hours, rate) => Math.round(Math.round(num(hours) * 100) * Math.round(num(rate) * 100) / 100) / 100;
  }
  if (typeof C.vatPctFor !== 'function') {
    stubs.push('vatPctFor');
    C.vatPctFor = (job) => (job.vatPct != null && job.vatPct !== '' ? num(job.vatPct) : num(C.settings.vatPct));
  }
  if (!/^−£/.test(C.gbp(-1))) {
    stubs.push('gbp/gbp0 negatives');
    const r2 = C.round2;
    C.gbp = (n) => { const v = r2(num(n)); return (v < 0 ? '−£' : '£') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    C.gbp0 = (n) => { const v = Math.round(num(n)); return (v < 0 ? '−£' : '£') + Math.abs(v).toLocaleString('en-GB'); };
  }
  for (const f of ['js/report.js', 'js/sample.js']) vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), ctx, { filename: f });
  return { ctx, C: ctx.Core, R: ctx.Report, sample: () => ctx.Sample.sampleJob(), stubs };
}

// ---- test images (made once with PIL, cached as data URLs) ----
function images() {
  const cache = path.join(DIR, 'images.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const py = `
import base64, io, json
from PIL import Image, ImageDraw
def jpg(w, h, col, text):
    im = Image.new('RGB', (w, h), col); d = ImageDraw.Draw(im)
    for i in range(0, w, 80): d.line([(i, 0), (i, h)], fill=(255, 255, 255), width=2)
    d.rectangle([w*0.3, h*0.4, w*0.7, h*0.7], outline=(0, 0, 0), width=8); d.text((40, 40), text, fill=(0, 0, 0))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=70); return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
def png(w, h):
    im = Image.new('RGBA', (w, h), (31, 51, 73, 255)); d = ImageDraw.Draw(im); d.text((10, 10), 'LOGO', fill=(255, 255, 255, 255))
    b = io.BytesIO(); im.save(b, 'PNG'); return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()
print(json.dumps({'land': jpg(1600, 1200, (120, 140, 160), 'landscape'), 'port': jpg(1200, 1600, (160, 120, 100), 'portrait'), 'logo': png(400, 120), 'sig': png(300, 90)}))
`;
  const out = execFileSync('python3', ['-I', '-c', py]).toString();
  fs.writeFileSync(cache, out);
  return JSON.parse(out);
}

// ---- HTML helpers ----
const headings = (html) => [...html.matchAll(/<h2><span class="n">(\d+)<\/span> ([^<]*)<\/h2>/g)].map((m) => m[1] + ' ' + m[2]);
const uniqueHeadings = (html) => [...new Set(headings(html))];
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
// The HTML of one numbered section (from its h2 to the next different h2).
function section(html, nn) {
  const re = new RegExp(`<h2><span class="n">${String(nn).padStart(2, '0')}</span>`);
  const i = html.search(re);
  if (i < 0) return '';
  const next = html.slice(i + 10).search(new RegExp(`<h2><span class="n">(?!${String(nn).padStart(2, '0')}<)`));
  return next < 0 ? html.slice(i) : html.slice(i, i + 10 + next);
}

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  ✓ ' + name); } else { failures++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}
const summary = () => { console.log(`\n${passes} passed, ${failures} failed`); return failures; };

module.exports = { load, images, headings, uniqueHeadings, text, section, check, summary, DIR };
