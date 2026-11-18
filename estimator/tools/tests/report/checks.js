#!/usr/bin/env node
/* Functional checks for estimator/app/js/report.js (round 1). Run: node checks.js */
'use strict';
const { load, images, uniqueHeadings, text, section, check, summary } = require('./lib');

const { C, R, sample, stubs } = load();
const IMG = images();
console.log(stubs.length ? `core.js contract exports stubbed in this check only: ${stubs.join(', ')}` : 'core.js provides every contract export used by report.js');
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const heads = (html) => uniqueHeadings(html).map(unesc);
const TITLES = ['INSTRUCTION & CLAIM DETAILS', 'VEHICLE DETAILS', 'INSPECTION DETAILS', 'ACCIDENT CIRCUMSTANCES', 'STRUCTURAL, MECHANICAL & ROADWORTHINESS ASSESSMENT', 'VALUATION', 'REPAIR ESTIMATE', 'REPAIR COSTS SUMMARY', "REPORT COMMENTS / ENGINEER'S OPINION", 'IMAGES / PHOTOGRAPHIC EVIDENCE', 'CUSTOMER / CLIENT INFORMATION', 'ASSESSOR DETAILS & SIGN-OFF'];
const expectHeads = (first) => [first, ...TITLES].map((x, i) => String(i + 1).padStart(2, '0') + ' ' + x);
const photo = (id, extra) => Object.assign({ id, dataUrl: IMG.land, w: 1600, h: 1200, title: 'Photo ' + id, caption: 'Caption ' + id, source: 'CarFlex', labels: [] }, extra || {});
const sumRows = (html) => {
  const tot = /<tbody class="totals">([\s\S]*?)<\/tbody>/.exec(section(html, 8))[1];
  const cells = [...tot.matchAll(/<tr class="tot">[\s\S]*?<\/tr>/g)].map((m) => [...m[0].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((x) => x[1]));
  const money = (s) => { const m = /(−?)£([\d,]+\.\d\d)/.exec(s || ''); return m ? (m[1] ? -1 : 1) * parseFloat(m[2].replace(/,/g, '')) : 0; };
  const rows = cells.map((r) => ({ label: r[1], amount: money(r[r.length - 1]) || money(r[5]) }));
  const grand = money(/<tr class="grand">[\s\S]*?<\/tr>/.exec(tot)[0]);
  return { rows, grand };
};

// ---------------------------------------------------------------- 1. sample job
console.log('\n1. Sample job');
{
  const job = sample();
  const t = C.totals(job);
  check('totals: net 3365.08 / gross 4038.10 / 59.22% / 71.07%', t.net === 3365.08 && t.gross === 4038.1 && t.pctNet === 59.22 && t.pctGross === 71.07, JSON.stringify(t));
  for (const mode of ['preview', 'print', 'pdf']) {
    const html = R.render(job, { mode });
    const ok = ['£3,365.08', '£4,038.10', '59.22%', '71.07%', 'TOTAL LOSS RECOMMENDED', 'Category N'].every((s) => html.includes(s));
    check(`${mode}: selftest strings present`, ok);
    check(`${mode}: 13 sections in CarFlex order`, JSON.stringify(heads(html)) === JSON.stringify(expectHeads('Category N — Non-Structural Total Loss')), JSON.stringify(heads(html)));
    check(`${mode}: CSP meta`, html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`));
    check(`${mode}: print-color-adjust: exact`, /print-color-adjust: exact/.test(html) && /-webkit-print-color-adjust: exact/.test(html));
  }
  const html = R.render(job, { mode: 'pdf' });
  check('pdf mode: no section header markup', !html.includes('class="phead"'));
  check('preview mode: section headers present', R.render(job, { mode: 'preview' }).includes('class="phead"'));
  check('print mode: page-number margin box', /@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\)/.test(R.render(job, { mode: 'print' })));
  check('sign-off shows version and status', section(html, 13).includes('Version 1.2 — Final Engineering Assessment'));
  check('no "RECOMMENDED RECOMMENDED"', !/RECOMMENDED RECOMMENDED|REQUIRED RECOMMENDED/.test(html));
  check('section 11 present with no photos', section(html, 11).includes('No photographs are included in this report.'));
  check('first registration printed to the day when no precision is recorded', section(html, 3).includes('05 August 2014'));
  check('paint finish and size class in section 03', section(html, 3).includes('Paint finish') && section(html, 3).includes('Metallic') && section(html, 3).includes('Medium (hatch / saloon) ×1.00'));
  check('multi-line inspection location keeps line breaks', section(html, 4).includes('CarFlex Secure Storage Gleneagles Farm<br>Gleneagles Close Stanwell<br>Staines-upon-Thames TW19 7PD'));
  check('no AI statement for a job with no AI or data use', !html.includes('Use of AI and data tools'));
  check('VAT @ 20%', section(html, 9).includes('VAT @ 20%'));
  check('no discount row when there is no discount', !html.includes('LESS DISCOUNT'));
  check('section 09 discount reads £0.00', /<td>Discounts<\/td><td>£0\.00<\/td>/.test(html));
  const { rows, grand } = sumRows(html);
  const labourCells = [...section(html, 8).matchAll(/<td>(£[\d,.]+)<\/td><td>(?:—|£[\d,.]+)<\/td><\/tr>/g)];
  check('estimate totals rows add up to the subtotal', Math.abs(rows.reduce((s, r) => s + r.amount, 0) - grand) < 0.005, JSON.stringify({ rows, grand }));
  check('totals in their own unbreakable tbody', /<tbody class="totals">/.test(html) && /tbody\.totals \{ break-inside: avoid; \}/.test(html));
  check('per-line labour printed (labour column)', labourCells.length > 0);
  check('signature block kept together with the declaration', /<div class="nobreak">\s*<h3>Assessor declaration<\/h3>[\s\S]*Assessor signature[\s\S]*<\/div>\s*<\/div>\s*<\/section>/.test(section(html, 13)));
}

// ---------------------------------------------------------------- 2. photos: 0, 3 with one excluded, 4, all excluded
console.log('\n2. Photographs and figure numbers');
{
  const job = sample();
  job.photos = [];
  let html = R.render(job, { mode: 'pdf' });
  check('0 photos: numbering 01-13', JSON.stringify(heads(html)) === JSON.stringify(expectHeads('Category N — Non-Structural Total Loss')));
  check('0 photos: "No photographs are included in this report."', section(html, 11).includes('No photographs are included in this report.'));

  job.photos = [photo('a', { exclude: true, title: 'Excluded duplicate' }), photo('b', { takenAt: '2026-09-01T10:42:00.000Z' }), photo('c', { dataUrl: IMG.port, takenAt: '2026-09-01T11:05' })];
  html = R.render(job, { mode: 'pdf' });
  const nums = C.photoNumbers(job);
  check('3 photos, first excluded: numbering 01-13', JSON.stringify(heads(html)) === JSON.stringify(expectHeads('Category N — Non-Structural Total Loss')));
  check('excluded photo not printed', !html.includes('Excluded duplicate'));
  check('figure numbers follow C.photoNumbers', html.includes(`IMAGE 0${nums.get('b')} &nbsp;|&nbsp; Photo b`) && html.includes(`IMAGE 0${nums.get('c')} &nbsp;|&nbsp; Photo c`) && nums.get('b') === 1 && nums.get('c') === 2);
  check('takenAt (UTC ISO) printed in UK time in the figcaption', html.includes('Taken: 01/09/2026 11:42'));
  check('takenAt (local, no zone) printed as entered', html.includes('Taken: 01/09/2026 11:05'));
  check('last page with two photos uses the tighter image size', (html.match(/<figure class="photo tight">/g) || []).length === 2);

  job.photos.push(photo('d'));
  html = R.render(job, { mode: 'pdf' });
  check('3 included photos: one photo page per pair, heading 11 repeated', (html.match(/<span class="n">11<\/span>/g) || []).length === 2);
  check('3 included photos: last page (single photo) not tightened', (html.match(/<figure class="photo tight">/g) || []).length === 0);
  check('numbering continues 12 / 13 after photos', heads(html).slice(-2).join('|') === '12 CUSTOMER / CLIENT INFORMATION|13 ASSESSOR DETAILS & SIGN-OFF');

  job.photos.forEach((p) => { p.exclude = true; });
  html = R.render(job, { mode: 'pdf' });
  check('all photos excluded: section 11 still present and says none included', section(html, 11).includes('No photographs are included in this report.') && heads(html).length === 13);
}

// ---------------------------------------------------------------- 3. labels: AI marker, pre-existing, ink colour
console.log('\n3. Photo labels');
{
  const job = sample();
  job.photos = [photo('p1', {
    aiLabelled: true,
    labels: [
      { x: 0.1, y: 0.2, w: 0.2, h: 0.2, text: 'Scuff', colour: '#ffcc00', ai: true, accidentRelated: 'no - pre-existing / wear' },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2, text: 'Dent', colour: '#ff3b30', ai: true, accidentRelated: 'yes' },
      { x: 0.6, y: 0.1, w: 0.1, h: 0.1, text: 'White label', colour: '#ffffff' },
      { x: 0.7, y: 0.7, w: 0.1, h: 0.1, text: 'Hidden', hidden: true }
    ]
  })];
  let html = R.render(job, { mode: 'pdf' });
  check('AI label carries the AI marker', /1\. Scuff \(pre-existing\) <span class="ai">AI<\/span>/.test(html));
  check('pre-existing label drawn dashed', /class="pbox pre"/.test(html) && /\.pbox\.pre \{ border-style: dashed; \}/.test(html));
  check('accident-related AI label not marked pre-existing', /2\. Dent <span class="ai">AI<\/span>/.test(html));
  check('hidden label not printed', !html.includes('Hidden'));
  check('yellow tag gets dark text', /background:#ffcc00;color:#111/.test(html));
  check('white tag gets dark text', /background:#ffffff;color:#111/.test(html));
  check('dark tag gets white text', R.render(Object.assign(sample(), { photos: [photo('q', { labels: [{ x: 0, y: 0, w: 0.1, h: 0.1, text: 'x', colour: '#1f3349' }] })] }), { mode: 'pdf' }).includes('background:#1f3349;color:#fff'));
  check('legend for dashed labels printed', html.includes('marked "(pre-existing)"'));
  check('AI note says the labels were NOT reviewed (labelsReviewed missing)', html.includes('The AI labels on IMAGE 01 had not been reviewed by the assessor') && !html.includes('reviewed by the assessor before issue'));
  job.photos[0].labelsReviewed = true;
  html = R.render(job, { mode: 'pdf' });
  check('AI note says reviewed once labelsReviewed is true', html.includes('and reviewed by the assessor before issue'));
}

// ---------------------------------------------------------------- 4. discount
console.log('\n4. Discount');
{
  const job = sample();
  job.discount = 100;
  const html = R.render(job, { mode: 'pdf' });
  const t = C.totals(job);
  check('LESS DISCOUNT −£100.00 row in section 08', /<td>LESS DISCOUNT<\/td><td colspan="4"><\/td><td>−£100\.00<\/td>/.test(section(html, 8)));
  const { rows, grand } = sumRows(html);
  check('section 08 rows add up to the subtotal with a discount', Math.abs(rows.reduce((s, r) => s + r.amount, 0) - grand) < 0.005 && Math.abs(grand - t.net) < 0.005, JSON.stringify({ rows, grand, net: t.net }));
  check('section 09 prints the discount negative', /<td>Discounts<\/td><td>−£100\.00<\/td>/.test(section(html, 9)));
  check('discount row precedes the subtotal row', section(html, 8).indexOf('LESS DISCOUNT') < section(html, 8).indexOf('ESTIMATE SUBTOTAL EXCL. VAT'));
}

// ---------------------------------------------------------------- 5. no PAV
console.log('\n5. No pre-accident value');
{
  const job = sample();
  job.valuation.adopted = '';
  job.outcome.decision = 'Repair';
  job.outcome.category = '';
  let html = R.render(job, { mode: 'pdf' });
  const s7 = section(html, 7);
  check('PAV "Not assessed"', s7.includes('ASSESSED PRE-ACCIDENT VALUE - Not assessed'));
  check('no £0.00 or 0.00% in section 07', !s7.includes('£0.00') && !s7.includes('0.00%'), (s7.match(/.{40}(£0\.00|0\.00%).{20}/) || [''])[0]);
  check('salvage "Not assessed"', /Provisional salvage value \(£\)<\/div><div class="fv">Not assessed/.test(s7));
  check('headline REPAIR RECOMMENDED', html.includes('<div class="verdict">REPAIR RECOMMENDED</div>'));
  job.valuation.sources = [];
  html = R.render(job, { mode: 'pdf' });
  check('no "Valuation evidence" heading without a chart', !section(html, 7).includes('Valuation evidence'));
}

// ---------------------------------------------------------------- 6. categories and decisions
console.log('\n6. Categories and decision headlines');
{
  for (const cat of ['B', 'b', 'A', 'S', 'n', 'X', ' s ']) {
    const job = sample();
    job.outcome.category = cat;
    let html = '';
    let err = null;
    try { html = R.render(job, { mode: 'pdf' }); } catch (e) { err = e; }
    const k = cat.trim().toUpperCase();
    const want = { A: 'Category A — Scrap', B: 'Category B — Break', S: 'Category S — Structural', N: 'Category N — Non-Structural', X: 'Category X' }[k];
    check(`category ${JSON.stringify(cat)} renders without throwing`, !err && html.includes(want) && html.includes(`SALVAGE CATEGORY: ${want.toUpperCase()}`), err && err.message);
  }
  const DECISIONS = ['', 'Repair', 'Beyond Economical Repair / Total Loss Recommended', 'Total Loss — Uneconomical to Repair', 'Further investigation required'];
  const WANT = ['', 'REPAIR RECOMMENDED', 'TOTAL LOSS RECOMMENDED', 'TOTAL LOSS RECOMMENDED', 'FURTHER INVESTIGATION REQUIRED'];
  DECISIONS.forEach((d, i) => {
    const job = sample();
    job.outcome.decision = d;
    const o = R.outcomeText(job);
    check(`decision ${JSON.stringify(d)} → ${JSON.stringify(WANT[i])}`, o.headline === WANT[i], o.headline);
  });
  const job = sample();
  job.report.headline = 'CUSTOM HEADLINE';
  check('headline override kept', R.outcomeText(job).headline === 'CUSTOM HEADLINE');
}

// ---------------------------------------------------------------- 7. HTML injection
console.log('\n7. HTML injection and attribute validation');
{
  const X = '"><script>alert(1)</script><div class="spoof" style="position:fixed">INJECTED</div><img src=x onerror=alert(2)><x a="';
  const job = sample();
  C.settings.company.name = 'ACME' + X;
  C.settings.company.reportTitle = 'TITLE' + X;
  C.settings.company.address = 'ADDR' + X;
  C.settings.company.accent = 'red;background:url(https://evil.example/x)';
  C.settings.company.navy = '#123456"><b>';
  C.settings.company.logo = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+';
  job.vehicle.reg = 'AB' + X;
  job.report.ref = 'REF' + X;
  job.report.summary = 'Summary **bold' + X + '**';
  job.inspection.location = 'Loc' + X + '\nline2';
  job.customer.notes = X;
  job.lines[0].description = 'Line' + X;
  job.lines[0].partNo = 'P' + X;
  job.valuation.sources[0].name = 'Src' + X;
  job.valuation.adverts = [{ description: 'Ad' + X, year: '2014', mileage: 60000, price: 5000, source: 'AutoTrader' + X, url: 'javascript:alert(1)' + X }];
  job.vehicle.motHistory = [{ date: '2025-08-01', result: 'PASSED' + X, odometer: 60000, unit: 'mi' + X, defects: ['ADVISORY: ' + X] }];
  job.aiLog = [{ at: '2026-09-01T10:00:00Z', action: 'Act' + X, model: 'M' + X, ai: true }];
  job.assessor.signature = 'javascript:alert(1)';
  job.assessor.name = 'Name' + X;
  job.photos = [
    photo('i1', { dataUrl: 'data:image/png;base64,AAAA" onerror="alert(1)', title: 'T' + X, caption: 'C' + X, source: 'S' + X, takenAt: X }),
    photo('i2', { labels: [{ x: '0.1;background:url(https://evil.example/)', y: 0.1, w: 0.2, h: 0.2, text: 'L' + X, colour: 'red"></div><div class="spoof" style="position:fixed">REPAIR COST AGREED £99.00</div><div x="' }] }),
    photo('i3', { dataUrl: 'https://evil.example/x.png' }),
    photo('i4', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
  ];
  let html = '';
  let err = null;
  try { html = R.render(job, { mode: 'pdf' }) + R.render(job, { mode: 'preview' }) + R.render(job, { mode: 'print' }); } catch (e) { err = e; }
  check('renders without throwing', !err, err && err.stack);
  const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  check('no injected <script>', !/<script/i.test(html));
  check('no injected element/attribute (spoof div, onerror, img src=x)', !/class="spoof"|<[^>]*\bonerror=|<img src=x|<x a=/i.test(body));
  check('no remote URLs anywhere', !/https?:\/\/evil|url\(https?:/i.test(html));
  check('injected text appears escaped', body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  check('invalid accent colour → default', /h2 \.n \{ color: #1a6fb5;/.test(html));
  check('invalid navy colour → default', /h3 \{ color: #1f3349;/.test(html));
  check('SVG logo dropped (company name shown instead)', !/svg\+xml/.test(html) && html.includes('<div class="logo-text">ACME&quot;&gt;'));
  check('label colour injection falls back to default #ff3b30', /background:#ff3b30;color:/.test(html));
  check('label geometry is numeric only', !/left:0\.1;background/.test(html));
  check('invalid photo data URLs are not emitted', !/AAAA" onerror|evil\.example\/x\.png|data:image\/svg/.test(html) && (html.match(/Image not shown/g) || []).length === 9);
  check('figure numbering unaffected by dropped images', html.includes('IMAGE 04'));
  check('javascript: signature dropped', !/javascript:alert\(1\)" alt="signature"|src="javascript:/.test(html));
  check('advert URL printed as escaped text only', body.includes('javascript:alert(1)&quot;&gt;&lt;script&gt;') && !/href=/.test(body));
  const tpl = R.pdfTemplates(job);
  const tplAll = tpl.header + tpl.footer;
  check('pdfTemplates: no raw markup from company fields', !/<script|class="spoof"|<[^>]*\bonerror=|<x a=/i.test(tplAll) && tplAll.includes('ACME&quot;&gt;&lt;script&gt;'));
  global.INJECT = { job, tpl };
  check('pdfTemplates: invalid navy → default, SVG logo dropped', tplAll.includes('color:#1f3349') && !/svg\+xml/.test(tplAll));
  check('CSS margin-box strings cannot close <style>', (() => { const css = /<style>([\s\S]*?)<\/style>/.exec(R.render(job, { mode: 'print' }))[1]; return !/<\/?[a-z]/i.test(css); })());
  // restore settings for later checks
  Object.assign(C.settings.company, C.clone(C.DEFAULT_SETTINGS.company));
}

// ---------------------------------------------------------------- 8. CPR 35
console.log('\n8. CPR Part 35');
{
  const job = sample();
  job.report.cpr35 = true;
  job.inspection.by = 'Jane Smith';
  job.inspection.byQualifications = 'IMI accredited assessor';
  let html = R.render(job, { mode: 'pdf' });
  check('"This report is addressed to the Court"', html.includes('This report is addressed to the Court.'));
  check('Guidance title includes 2014', html.includes('Guidance for the Instruction of Experts in Civil Claims 2014'));
  check('who carried out the examination (statement)', html.includes('The examination of the vehicle described in section 04 was carried out by Jane Smith (IMI accredited assessor).'));
  check('section 04 shows examiner and qualifications', /Examined by<\/div><div class="fv">Jane Smith/.test(section(html, 4)) && section(html, 4).includes('IMI accredited assessor'));
  check('contempt wording kept', html.includes('proceedings for contempt of court may be brought'));
  job.inspection.by = 'sample assessor';
  html = R.render(job, { mode: 'pdf' });
  check('examiner = assessor → "carried out by me"', html.includes('was carried out by me.'));
  job.inspection.by = '';
  html = R.render(job, { mode: 'pdf' });
  check('no examiner recorded → says so', html.includes('has not been recorded'));
  job.inspection.byQualifications = '';
  job.report.cpr35 = false;
  html = R.render(job, { mode: 'pdf' });
  check('CPR off: no court wording, no examiner fields', !html.includes('addressed to the Court') && !html.includes('Examined by'));
}

// ---------------------------------------------------------------- 9. AI / data-use statement
console.log('\n9. Use of AI and data tools');
{
  let job = sample();
  job.aiLog = [{ at: '2026-09-01T09:00:00Z', action: 'DVLA Vehicle Enquiry Service lookup', model: 'DVLA', ai: false }, { at: '2026-09-01T09:01:00Z', action: 'DVSA MOT History lookup (9 tests)', model: 'DVSA', ai: false }];
  let s13 = section(R.render(job, { mode: 'pdf' }), 13);
  check('data-only: statement printed with Data services list', s13.includes('Use of AI and data tools') && s13.includes('<strong>Data services</strong>') && s13.includes('DVLA Vehicle Enquiry Service lookup (DVLA) on 01/09/2026'));
  check('data-only: no AI assistance list and no review claim', !s13.includes('AI assistance') && !s13.includes('All AI output was reviewed'));

  job = sample();
  job.aiLog = [{ at: '2026-09-01T09:00:00Z', action: 'Photo damage labelling & repair suggestions (8 photos)', model: 'claude-opus-5-5', ai: true }, { at: '2026-09-01T09:05:00Z', action: 'DVLA Vehicle Enquiry Service lookup', model: 'DVLA', ai: false }];
  job.lines[0].ai = true; job.lines[0].reviewed = false;
  job.lines[1].ai = true; job.lines[1].reviewed = false;
  job.lines[2].ai = true; job.lines[2].reviewed = true;
  s13 = section(R.render(job, { mode: 'pdf' }), 13);
  check('AI + unreviewed lines: both lists', s13.includes('<strong>AI assistance</strong>') && s13.includes('<strong>Data services</strong>'));
  check('AI + unreviewed lines: states the count, no review claim', s13.includes('2 AI-suggested estimate lines had not been marked as reviewed') && !s13.includes('All AI output was reviewed'));
  job.lines.forEach((l) => { if (l.ai) l.reviewed = true; });
  s13 = section(R.render(job, { mode: 'pdf' }), 13);
  check('AI, all reviewed: "All AI output was reviewed"', s13.includes('All AI output was reviewed, edited where necessary and adopted by the assessor'));
  check('AI statement above the declaration', s13.indexOf('Use of AI and data tools') < s13.indexOf('Assessor declaration'));
  job = sample();
  job.lines[0].ai = true; job.lines[0].reviewed = false;
  s13 = section(R.render(job, { mode: 'pdf' }), 13);
  check('AI line with an empty log still disclosed', s13.includes('AI-suggested estimate lines (1)') && s13.includes('1 AI-suggested estimate line had not'));
  check('report.js does not read report.aiDisclosure', !require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'app', 'js', 'report.js'), 'utf8').includes('aiDisclosure'));
}

// ---------------------------------------------------------------- 10. vehicle data, valuation extras, MOT, adverts
console.log('\n10. Vehicle data, valuation extras, MOT and adverts');
{
  const job = sample();
  job.vehicle.firstReg = '2014-08-01';
  job.vehicle.firstRegPrecision = 'month';
  job.vehicle.paintType = 'pearl';
  job.vehicle.sizeClass = 'premium';
  job.vehicle.dvla = { taxStatus: 'Taxed', taxDueDate: '2027-03-01', motStatus: 'Valid', motExpiry: '2027-08-04', markedForExport: true, markedAsScrapped: false, importedOrReRegistered: true, firstRegistration: '2014-08-01', firstRegistrationWithDvla: '2016-02-01', dateOfLastV5CIssued: '2024-05-10', lookedUpAt: '2026-09-01T10:00:00Z' };
  job.vehicle.motSummary = { recall: 'Yes', lookedUpAt: '2026-09-01T10:01:00Z' };
  job.vehicle.motHistory = [
    { date: '2025-08-01', result: 'PASSED', odometer: 61000, unit: 'mi', odometerResult: 'READ', expiry: '2026-08-04', defects: ['ADVISORY: Nearside front tyre worn close to legal limit', 'ADVISORY: Offside rear brake disc pitted', 'MINOR: Number plate lamp inoperative', 'ADVISORY: Oil leak'] },
    { date: '2024-08-01', result: 'FAILED', odometer: 0, unit: '', odometerResult: 'UNREADABLE', expiry: '', defects: ['MAJOR (DANGEROUS): Offside front tyre has a cut'] },
    { date: '2023-08-01', result: 'PASSED', odometer: 0, unit: '', odometerResult: 'NO_ODOMETER', expiry: '2024-08-04', defects: [] }
  ];
  job.valuation.adopted = 5395;
  job.valuation.belowHighestReason = 'Glass\'s figure assumes full service history; none supplied.';
  job.valuation.historyNotes = 'Previous Cat S recorded in 2019.\n\nFinance outstanding.';
  job.valuation.optionsNotes = 'Panoramic roof.';
  job.valuation.sources.push({ name: '', amount: 9999 });
  job.valuation.adverts = [{ description: 'Nissan Juke Acenta CVT', year: '2014', mileage: 62000, price: 5600, source: 'AutoTrader', url: 'https://www.autotrader.co.uk/car-details/123' }];
  const html = R.render(job, { mode: 'pdf' });
  const s3 = section(html, 3), s7 = section(html, 7);
  check('firstRegPrecision month → "August 2014"', s3.includes('First registration date</div><div class="fv">August 2014'));
  check('paint finish pearl with factor', s3.includes('Pearlescent (refinish-time factor ×1.20)'));
  check('size class premium ×1.20', s3.includes('Large premium / luxury ×1.20'));
  check('DVLA / DVSA block: tax, MOT, flags, recall', s3.includes('DVLA / DVSA status') && s3.includes('Taxed — due 01/03/2027') && s3.includes('Valid — expires 04/08/2027') && /Marked for export \(DVLA\)<\/div><div class="fv"><strong>Yes/.test(s3) && /Marked as scrapped \(DVLA\)<\/div><div class="fv">No/.test(s3) && s3.includes('first registered with DVLA 01/02/2016') && /Outstanding safety recall \(DVSA\)<\/div><div class="fv"><strong>Yes/.test(s3));
  check('below-highest reason printed', s7.includes('Adopted value below the highest guide figure (£5,682)') && s7.includes('full service history; none supplied'));
  check('history and options notes printed', s7.includes('<h3>History notes</h3>') && s7.includes('Previous Cat S recorded in 2019.</p><p>Finance outstanding.') && s7.includes('Panoramic roof.'));
  check('unnamed £9,999 source not in the chart', !s7.includes('£9,999'));
  check('MOT table lists every test', (s7.match(/<tr><td>\d\d\/\d\d\/\d{4}<\/td><td>(PASSED|FAILED)/g) || []).length === 3);
  check('unread odometers show the result type', s7.includes('<td>Unreadable</td>') && s7.includes('<td>No odometer</td>'));
  check('advisories column, short (+1 more)', s7.includes('Advisories / defects') && s7.includes('(+1 more)') && s7.includes('MAJOR (DANGEROUS): Offside front tyre has a cut'));
  check('advert source and URL both printed', s7.includes('AutoTrader<br>https://www.autotrader.co.uk/car-details/123'));
  check('salvage % shown', s7.includes('15% of PAV'));
}

// ---------------------------------------------------------------- 11. issued snapshot + pdfTemplates
console.log('\n11. Issued snapshot and pdfTemplates');
{
  const job = sample();
  job.issued = {
    at: '2026-09-06T12:00:00Z',
    company: Object.assign(C.clone(C.settings.company), { name: 'ISSUED CO LTD', logo: IMG.logo, navy: '#102030' }),
    declaration: 'Issued declaration text.',
    signature: IMG.sig,
    qualifications: 'IMI AE (issued)',
    aqpId: 'AQP-ISSUED'
  };
  C.settings.company.name = 'LIVE CO LTD';
  C.settings.assessor.declaration = 'Live declaration text.';
  C.settings.assessor.signature = '';
  const html = R.render(job, { mode: 'preview' });
  check('issued company name used', html.includes('ISSUED CO LTD') && !html.includes('LIVE CO LTD'));
  check('issued declaration used', html.includes('Issued declaration text.') && !html.includes('Live declaration text.'));
  check('issued signature used', html.includes(`<img class="sigimg" src="${IMG.sig}"`));
  check('issued qualifications / AQP', html.includes('IMI AE (issued)') && html.includes('AQP-ISSUED'));
  check('logo data URL emitted exactly once (preview mode, 13 headers)', html.split(IMG.logo).length - 1 === 1, String(html.split(IMG.logo).length - 1));
  check('logo used on cover and in headers via .lg', (html.match(/class="logo lg"/g) || []).length === 1 && (html.match(/class="hlogo lg"/g) || []).length === 11);
  const pdfHtml = R.render(job, { mode: 'pdf' });
  check('pdf mode: logo once, no header markup', pdfHtml.split(IMG.logo).length - 1 === 1 && !pdfHtml.includes('class="hlogo') && !pdfHtml.includes('class="phead"'));
  const tplJob = R.pdfTemplates(job);
  check('pdfTemplates(job) uses the issued company', tplJob.footer.includes('ISSUED CO LTD') && tplJob.header.includes(IMG.logo) && tplJob.header.includes('#102030'));
  const tplLast = R.pdfTemplates();
  check('pdfTemplates() falls back to the last rendered job', tplLast.footer.includes('ISSUED CO LTD'));
  const live = sample();
  R.render(live, { mode: 'pdf' });
  check('pdfTemplates() for a live job uses live settings', R.pdfTemplates().footer.includes('LIVE CO LTD'));
  Object.assign(C.settings.company, C.clone(C.DEFAULT_SETTINGS.company));
  C.settings.assessor.declaration = C.DEFAULT_SETTINGS.assessor.declaration;
}

// ---------------------------------------------------------------- 12. robustness
console.log('\n12. Robustness');
{
  const job = sample();
  job.zones = 'not-an-array';
  job.aiLog = null;
  job.photos = [null, photo('z', { labels: 'bad' })];
  job.valuation.adverts = null;
  job.vehicle.motHistory = null;
  let err = null;
  try { R.render(job, { mode: 'pdf' }); } catch (e) { err = e; }
  check('malformed arrays do not throw', !err, err && err.stack);
  const j2 = sample();
  j2.lines.push(C.newLine({ type: 'Other', description: 'Betterment contribution', amount: -56.34, costClass: 'other' }));
  check('negative amount prints with a leading minus (core gbp)', R.render(j2, { mode: 'pdf' }).includes('−£56.34'));
}

// ---------------------------------------------------------------- 13. extra edge cases
console.log('\n13. Edge cases');
{
  const job = sample();
  job.photos = [photo('only')];
  const html = R.render(job, { mode: 'pdf' });
  check('1 photo: numbering 01-13, IMAGE 01, not tightened', JSON.stringify(heads(html)) === JSON.stringify(expectHeads('Category N — Non-Structural Total Loss')) && html.includes('IMAGE 01 &nbsp;|&nbsp; Photo only') && !html.includes('photo tight'));
  const j2 = sample();
  j2.vehicle.motHistory = [{ date: '2024-01-01', result: 'PASSED', odometer: 0, unit: 'mi', odometerResult: 'READ' }, { date: '2023-01-01', result: 'PASSED', odometer: 0 }, { date: '2022-01-01', result: 'PASSED', odometer: 41000, unit: 'km' }];
  const s7 = section(R.render(j2, { mode: 'pdf' }), 7);
  check('MOT READ with 0 prints "0 mi"; legacy unread prints "Not recorded"; km unit kept', s7.includes('<td>0 mi</td>') && s7.includes('<td>Not recorded</td>') && s7.includes('<td>41,000 km</td>'));
  const j3 = sample();
  j3.vatPct = 17.5;
  check('VAT % from the job snapshot (C.vatPctFor)', section(R.render(j3, { mode: 'pdf' }), 9).includes('VAT @ 17.5%'));
  const j4 = sample();
  j4.outcome.decision = 'Repair';
  j4.outcome.category = '';
  const h4 = R.render(j4, { mode: 'pdf' });
  check('repair decision: section 01 title "Assessment Summary", no verdict lines', heads(h4)[0] === '01 Assessment Summary' && !h4.includes('class="verdict-lines"'));
}

process.exitCode = summary() ? 1 : 0;
