/* Report renderer: builds the full engineering report as a standalone HTML document. */
(function () {
  'use strict';
  const C = window.Core;
  const { esc, gbp, gbp0, hrs, ukDate, longDate, num } = C;

  const CATEGORY_TEXT = {
    N: 'Category N — Non-Structural',
    S: 'Category S — Structural',
    A: 'Category A — Scrap',
    B: 'Category B — Break'
  };
  const CATEGORY_NAME = { N: 'Non-Structural', S: 'Structural', A: 'Scrap', B: 'Break' };
  // Cover headline for each decision the app offers; any other decision is printed as entered.
  const HEADLINES = {
    'repair': 'REPAIR RECOMMENDED',
    'beyond economical repair / total loss recommended': 'TOTAL LOSS RECOMMENDED',
    'total loss — uneconomical to repair': 'TOTAL LOSS RECOMMENDED',
    'further investigation required': 'FURTHER INVESTIGATION REQUIRED'
  };
  const PAINT_FINISH = { solid: 'Solid', metallic: 'Metallic', pearl: 'Pearlescent', 'three-stage': '3-stage / tri-coat', matt: 'Matt' };
  const ODOMETER_RESULT = { NO_ODOMETER: 'No odometer', UNREADABLE: 'Unreadable' };
  const BAR_COLOURS = ['#2e9a5a', '#2f4bb5', '#f2a20c', '#6b62e0', '#d0473b', '#1497a8'];
  const DEFAULT_ACCENT = '#1a6fb5';
  const DEFAULT_NAVY = '#1f3349';
  const DEFAULT_LABEL = '#ff3b30';
  // Page margins of the Electron PDF in mm: the single source for the pdf-mode @page rule, the header/footer templates and
  // pdfTemplates().marginsMm (which the renderer forwards to main.js's printToPDF).
  const PDF_MARGINS_MM = Object.freeze({ top: 25, right: 16, bottom: 26, left: 16 });
  const marginCss = (m) => `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`;
  // Claim type → what it means for the valuation (the standard the AI valuation applies for that type, see ai.js).
  const CLAIM_TYPES = {
    'own-insurer': ['Own-insurer (first-party) total loss', 'the Financial Ombudsman Service approach (the highest recognised retail trade-guide figure is the starting point; a lower figure is adopted only on evidence about this vehicle)'],
    'third-party': ['Third-party claim', 'market value, the cost of buying a replacement vehicle of the same kind and condition at the valuation date, in the assessor\'s reasoned opinion (the Financial Ombudsman Service highest-guide approach is persuasive, not binding)'],
    court: ['Court proceedings', 'market value, the cost of buying a replacement vehicle of the same kind and condition at the valuation date, in the assessor\'s independent, reasoned opinion']
  };
  // The court claim type in a court-compliant expert report (CPR 35 mode) only: never claimed for a report without the CPR content.
  const COURT_CPR = ['Court proceedings (CPR Part 35)', 'market value, the cost of buying a replacement vehicle of the same kind and condition at the valuation date, given as the expert\'s independent opinion within the range of reasonable opinion'];
  const claimKey = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_]+/g, '-');

  // ---------- validation of values that end up in attributes, CSS or URLs ----------
  // Only inline raster images are allowed (no SVG, no remote or file URLs).
  const IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
  const safeImage = (u) => (typeof u === 'string' && IMAGE_RE.test(u) ? u : '');
  const COLOUR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const safeColour = (c, fallback) => (typeof c === 'string' && COLOUR_RE.test(c.trim()) ? c.trim() : fallback);
  // CSS string literal; every character that could end the string or the <style> element is hex-escaped.
  const cssStr = (s) => '"' + String(s == null ? '' : s).replace(/[\\"'<>&\u0000-\u001f\u007f\u2028\u2029]/g, (ch) => '\\' + ch.charCodeAt(0).toString(16) + ' ') + '"';
  // Text colour (white or near-black) giving the higher contrast ratio on a validated #hex background.
  function inkFor(bg) {
    let h = bg.slice(1);
    if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
    const lin = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.0556 ? '#fff' : '#111';
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  // lookup that ignores inherited keys ("constructor", "__proto__" …) coming from job data
  const own = (map, key) => (map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
  const obj = (x) => (x && typeof x === 'object' ? x : {});

  // ---------- text helpers ----------
  const nl2br = (s) => esc(s).replace(/\r\n?|\n/g, '<br>');
  function para(text) {
    if (text == null || !String(text).trim()) return '<p class="muted">—</p>';
    return String(text).replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  }
  function richPara(text) {
    // allow **bold** in narrative text
    return para(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  function field(label, value, cls) {
    return `<div class="f ${cls || ''}"><div class="fl">${esc(label)}</div><div class="fv">${value == null || value === '' ? '—' : value}</div></div>`;
  }
  // Plain text for a field value; line breaks entered in textareas are kept.
  const t = (v) => (v == null || v === '' ? '' : nl2br(v));
  function h2(n, title) { return `<h2><span class="n">${String(n).padStart(2, '0')}</span> ${esc(title)}</h2>`; }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const andList = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  const pctText = (x) => String(Math.round(num(x) * 100) / 100);

  // ---------- dates ----------
  // "August 2014" from "2014-08" or a real calendar date ("2014-08-01"); anything else is printed as entered (never a month
  // rolled into another year: "2014-13-01" stays as it is, as the QA check says).
  const calendarDate = (s) => (typeof C.calendarDate === 'function' ? C.calendarDate(s) : null);
  const partialDate = (s) => (typeof C.partialDate === 'function' ? C.partialDate(s) : null);
  function monthYear(iso) {
    const s = String(iso == null ? '' : iso).trim();
    const c = calendarDate(s), p = c ? null : partialDate(s);
    const y = c ? c.y : p && p.mo ? p.y : 0, mo = c ? c.mo : p ? p.mo : 0;
    if (!y || !mo) return String(iso == null ? '' : iso);
    const d = new Date(Date.UTC(2000, mo - 1, 15));
    d.setUTCFullYear(y);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  // A first-registration date as precisely as it is known: "05 August 2014" (precision 'day'), "August 2014" ('month': DVLA
  // gives the month only) or "2014" ('year', or a year alone: never "January 2014" for a month nobody gave). Text that is
  // not a date is printed as entered.
  function regDate(s, precision) {
    const str = String(s == null ? '' : s).trim();
    if (!str) return '';
    const p = partialDate(str);
    if (p) return p.mo && precision !== 'year' ? monthYear(str) : str.slice(0, 4);
    const c = calendarDate(str);
    if (!c) return String(s);
    return precision === 'year' ? c.text[1] : precision === 'month' ? monthYear(str) : longDate(str);
  }
  // "dd/mm/yyyy" or "dd/mm/yyyy hh:mm"; times without a zone are printed as entered, zoned times in UK time.
  function dateTime(s) {
    const str = String(s == null ? '' : s).trim();
    if (!str) return '';
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(str);
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
    const d = new Date(str);
    if (isNaN(d)) return str;
    try {
      return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function dayOf(at) {
    const d = new Date(at);
    if (!at || isNaN(d)) return '';
    try { return d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }); } catch (e) { return ukDate(d.toISOString()); }
  }

  // ---------- issued snapshot (job.issued) or live settings ----------
  let lastJob = null; // the job most recently rendered; pdfTemplates() falls back to it
  const issuedOf = (job) => (job && job.issued && typeof job.issued === 'object' ? job.issued : null);
  function companyFor(job) {
    const iss = issuedOf(job);
    return obj((iss && iss.company && typeof iss.company === 'object') ? iss.company : C.settings.company);
  }

  const catOf = (job) => String(obj(job.outcome).category || '').trim().toUpperCase().replace(/^CAT(EGORY)?\.?\s*/, '');
  const catText = (cat) => (cat ? own(CATEGORY_TEXT, cat) || 'Category ' + cat : '');

  function outcomeText(job) {
    const d = String(obj(job.outcome).decision || '').trim();
    const rep = obj(job.report);
    const cat = catOf(job);
    const isTL = typeof C.isTotalLoss === 'function' ? C.isTotalLoss(d) : /total|\bber\b|beyond/i.test(d);
    const auto = own(HEADLINES, d.toLowerCase().replace(/\s+/g, ' ')) || (isTL ? 'TOTAL LOSS RECOMMENDED' : d.toUpperCase());
    const name = own(CATEGORY_NAME, cat);
    return {
      isTL,
      category: cat,
      headline: rep.headline || auto,
      sub: rep.subHeadline || (isTL && cat ? `CATEGORY ${cat} - RECOMMENDATION` : ''),
      sectionTitle: isTL && cat ? `Category ${cat}${name ? ' — ' + name : ''} Total Loss` : (isTL ? 'Total Loss' : 'Assessment Summary')
    };
  }

  const isPreExisting = (l) => /^\s*no\b/i.test(String(l.accidentRelated || ''));
  const visibleLabels = (p) => arr(p.labels).filter((l) => l && typeof l === 'object' && !l.hidden);

  // Where a label's tag goes, so that it never runs past the photo (or off the page): anchored at the box's left edge for a
  // box on the left half and at its right edge (right-aligned) on the right half, at most 60% of the photo wide and never
  // wider than the room on that side (long text wraps); above the box, or inside it at the top when the box is at the top.
  const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));
  const pc = (f) => (f * 100).toFixed(2) + '%';
  function labelGeometry(l) {
    const x = clamp01(l.x), y = clamp01(l.y);
    const w = Math.min(clamp01(l.w), 1 - x), h = Math.min(clamp01(l.h), 1 - y);
    const right = x + w / 2 > 0.5;
    const room = right ? x + w : 1 - x;
    const up = y >= 0.15; // room above for a wrapped tag
    const tag = [right ? `right:${pc(1 - (x + w))}` : `left:${pc(x)}`, up ? `bottom:${pc(1 - y)}` : `top:${pc(y)}`, `max-width:${pc(Math.min(0.6, room))}`].join(';');
    return { box: `left:${pc(x)};top:${pc(y)};width:${pc(w)};height:${pc(h)}`, tag, cls: (up ? 'up' : 'in') + (right ? ' r' : '') };
  }

  function photoFigure(p, no, tight) {
    const src = safeImage(p.dataUrl);
    const boxes = src ? visibleLabels(p).map((l, k) => {
      const colour = safeColour(l.colour, DEFAULT_LABEL);
      const pre = isPreExisting(l);
      const g = labelGeometry(l);
      const tag = `<div class="ptag ${g.cls}" style="${g.tag};background:${colour};color:${inkFor(colour)}">${k + 1}. ${esc(l.text)}${pre ? ' (pre-existing)' : ''}${l.ai ? ' <span class="ai">AI</span>' : ''}</div>`;
      return `<div class="pbox${pre ? ' pre' : ''}" style="${g.box};border-color:${colour}"></div>${tag}`;
    }).join('') : '';
    const taken = dateTime(p.takenAt);
    return `<figure class="photo${tight ? ' tight' : ''}">
      ${src ? `<div class="pwrap"><img src="${src}" alt="">${boxes}</div>` : '<div class="pmissing">Image not shown: the stored file is not a PNG, JPEG, GIF or WebP image.</div>'}
      <figcaption><div class="pt">IMAGE ${String(no).padStart(2, '0')} &nbsp;|&nbsp; ${esc(p.title || 'Photograph')}</div>
      ${p.caption ? `<div class="pc">${nl2br(p.caption)}</div>` : ''}
      <div class="ps">Source: ${esc(p.source || '') || '—'}${taken ? ` &nbsp;·&nbsp; Taken: ${esc(taken)}` : ''}</div></figcaption>
    </figure>`;
  }

  function render(job, opts) {
    opts = opts || {};
    lastJob = job;
    const S = C.settings;
    const iss = issuedOf(job);
    const co = companyFor(job);
    const tt = C.totals(job);
    const o = outcomeText(job);
    const rep = obj(job.report);
    const v = obj(job.vehicle);
    const ins = obj(job.instruction);
    const insp = obj(job.inspection);
    const circ = obj(job.circumstances);
    const a = obj(job.assessment);
    const val = obj(job.valuation);
    const as = obj(job.assessor);
    const lines = arr(job.lines).filter((l) => l && typeof l === 'object');
    const photos = arr(job.photos).filter((p) => p && typeof p === 'object');
    const cat = o.category;
    const cpr = !!rep.cpr35;
    const accent = safeColour(co.accent, DEFAULT_ACCENT);
    const navy = safeColour(co.navy, DEFAULT_NAVY);
    const printMode = opts.mode === 'print' || opts.mode === 'pdf' ? opts.mode : 'preview';
    const logoSrc = safeImage(co.logo);
    // The logo is defined once (CSS rule .lg) and reused by the cover and the section headers.
    const logo = logoSrc ? '<div class="logo lg" role="img" aria-label="logo"></div>' : `<div class="logo-text">${esc(co.name)}</div>`;
    const footerLine = `${esc(co.name)}${co.companyNo ? ' | Company No. ' + esc(co.companyNo) : ''} | ${esc(co.tradingName || '')}<br>${esc(co.address)} |<br>T: ${esc(co.phone)} | E: ${esc(co.email)} &nbsp;| PRIVATE &amp; CONFIDENTIAL`;
    let n = 0;
    const sec = (title) => h2(++n, title);

    // ---------- valuation chart (named sources only) ----------
    const srcs = C.namedSources(job);
    const maxV = Math.max(1, ...srcs.map((s) => num(s.amount)));
    const highestNamed = srcs.length ? Math.max(...srcs.map((s) => num(s.amount))) : 0;
    const hasPav = tt.pav > 0;
    const chart = srcs.length ? `<div class="valbox"><div class="valhead"><div class="vh1">Individual Valuations</div><div class="vh2">Breakdown by valuation source</div></div>
      <div class="vt">Valuation Comparison</div>
      ${srcs.map((s, i) => `<div class="bar"><div class="bl">${esc(s.name)}</div><div class="bt"><div class="bf" style="width:${(num(s.amount) / maxV * 100).toFixed(1)}%;background:${BAR_COLOURS[i % BAR_COLOURS.length]}">${gbp0(s.amount)}</div></div></div>`).join('')}
      <div class="valgrid">${srcs.map((s) => `<div class="vcell${hasPav && num(s.amount) === tt.pav ? ' adopted' : ''}"><div class="vn">${esc(s.name)}</div><div class="vl">Valuation Amount</div><div class="va">${gbp0(s.amount)}</div></div>`).join('')}</div></div>` : '';

    // ---------- estimate table ----------
    const h1 = (x) => (Math.round(num(x) * 10) / 10).toFixed(1) + 'h';
    let guideNotes = 0;
    const lineRows = lines.map((l) => {
      const rate = C.lineRate(job, l);
      const h = num(l.hours);
      const pending = l.ai && !l.reviewed ? ' <span title="AI-suggested line not yet reviewed by the assessor">†</span>' : '';
      // an AI line whose hours were adjusted from the guide time shows the guide time FOR THIS VEHICLE (the catalogue guide
      // scaled for its size class and paint finish, as the picker adds it), on the same basis as the line's hours
      const vg = l.ai && l.hoursBasis === 'adjusted' && typeof C.vehicleGuide === 'function' ? C.vehicleGuide(job, l) : null;
      const g = vg ? num(vg.hours) : 0;
      const guide = h && g > 0 && Math.abs(g - h) >= 0.05 ? `<br><span class="gh">(guide ${h1(g)})</span>` : '';
      if (guide) guideNotes++;
      return `<tr><td class="ct">${esc(l.type)}</td><td>${esc(l.description)}${pending}</td><td>${esc(l.partNo) || '—'}</td>
        <td>${h ? gbp(rate) + '/hr' : '—'}</td><td>${h ? hrs(h) + guide : '—'}</td><td>${h ? gbp(C.lineLabour(h, rate)) : '—'}</td><td>${num(l.amount) ? gbp(l.amount) : '—'}</td></tr>`;
    }).join('');

    const zones = arr(job.zones);
    const zonesText = zones.length ? `<p class="small"><strong>Damage zones recorded:</strong> ${esc(zones.join(', '))}</p>` : '';

    // ---------- photographs ----------
    const figNos = C.photoNumbers(Object.assign({}, job, { photos }));
    const included = photos.filter((p) => !p.exclude);
    const figOf = (p, i) => (figNos && typeof figNos.get === 'function' && figNos.get(p.id)) || i + 1;
    const figName = (p) => 'IMAGE ' + String(figOf(p, included.indexOf(p))).padStart(2, '0');
    const aiPhotos = included.filter((p) => safeImage(p.dataUrl) && visibleLabels(p).some((l) => l.ai));
    const unreviewedPhotos = aiPhotos.filter((p) => !p.labelsReviewed);
    const anyPreExisting = included.some((p) => safeImage(p.dataUrl) && visibleLabels(p).some(isPreExisting));
    const aiNote = aiPhotos.length ? `<p class="small muted">Damage labels marked "AI" were generated with AI-assisted image analysis${unreviewedPhotos.length ? '' : ' and reviewed by the assessor before issue'}.${unreviewedPhotos.length ? ` The AI labels on ${andList(unreviewedPhotos.map(figName))} had not been reviewed by the assessor when this report was produced.` : ''} Unless changed by the assessor, AI label colours give the AI's severity rating (red severe, orange moderate, yellow minor). The assessor's findings take precedence over any automated labelling.</p>` : '';
    const preNote = anyPreExisting ? '<p class="small muted">Labels drawn with a dashed outline and marked "(pre-existing)" show damage identified as pre-existing or wear, not attributed to this accident.</p>' : '';

    // ---------- signature, declaration, qualifications: issued snapshot when the report is finalised ----------
    const sigRaw = iss && iss.signature != null ? iss.signature : (as.signature || (as.useDefaultSignature ? S.assessor.signature : ''));
    const sig = safeImage(sigRaw);
    const declaration = iss && iss.declaration != null ? iss.declaration : S.assessor.declaration;
    const qualifications = iss && iss.qualifications != null ? iss.qualifications : (as.qualifications || S.assessor.qualifications);
    const aqpId = iss && iss.aqpId != null ? iss.aqpId : (as.aqpId || S.assessor.aqpId);

    const pdf = printMode === 'pdf';
    const preview = printMode === 'preview';
    const footLines = [
      `${co.name || ''}${co.companyNo ? ' | Company No. ' + co.companyNo : ''} | ${co.tradingName || ''}`,
      `${co.address || ''} |`,
      `T: ${co.phone || ''} | E: ${co.email || ''}  | PRIVATE & CONFIDENTIAL`
    ];
    // Browser printing: running footer and page numbers in the page margin (Electron PDFs use pdfTemplates()).
    const marginBoxes = printMode === 'print' ? `
        @bottom-left { content: ${footLines.map(cssStr).join(' "\\A " ')}; white-space: pre-wrap; font-family: Arial, Helvetica, sans-serif; font-size: 6.5pt; font-weight: bold; color: ${navy}; vertical-align: top; padding-top: 3mm; }
        @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #6b7785; vertical-align: top; padding-top: 3mm; }` : '';

    const css = `
      @page { size: A4; margin: ${pdf ? marginCss(PDF_MARGINS_MM) : printMode === 'print' ? '14mm 16mm 22mm 16mm' : '14mm 16mm 16mm 16mm'};${marginBoxes} }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { font-family: Arial, Helvetica, sans-serif; color: #2a3340; font-size: 10.5pt; line-height: 1.42; margin: 0; background: ${preview ? '#e9edf2' : '#fff'}; }
      .page { background: #fff; ${preview ? 'width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 16mm 24mm; box-shadow: 0 2px 10px rgba(0,0,0,.15); position: relative;' : ''} page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      ${logoSrc ? `.lg { content: url("${logoSrc}"); }` : ''}
      .phead { display: ${pdf ? 'none' : 'flex'}; justify-content: space-between; align-items: center; border-bottom: 1px solid #d5dbe2; padding-bottom: 6px; margin-bottom: 14px; }
      .phead .hlogo { display: block; height: 44px; width: auto; } .phead .rt { font-weight: bold; font-size: 8.5pt; color: ${navy}; letter-spacing: .02em; }
      .pfoot { display: ${preview ? 'block' : 'none'}; position: absolute; left: 16mm; right: 16mm; bottom: 8mm; border-top: 1px solid #d5dbe2; padding-top: 5px; font-size: 7pt; font-weight: bold; color: ${navy}; }
      .logo { display: inline-block; max-height: 120px; max-width: 70%; } .logo-text { font-size: 28pt; font-weight: 900; color: ${navy}; }
      .cover { text-align: center; padding-top: 18mm; }
      .cover h1 { font-size: 26pt; line-height: 1.2; color: ${navy}; margin: 26px 40px 8px; }
      .cover .sub { color: #66717e; font-size: 10pt; margin-bottom: 30px; }
      .cover .grid { text-align: left; }
      .cover .court { color: ${navy}; font-weight: bold; font-size: 11pt; margin-top: 20px; }
      .cover .verdict { color: ${accent}; font-weight: bold; font-size: 15pt; margin-top: 26px; }
      .cover .verdict2 { color: ${navy}; font-weight: bold; font-size: 11pt; margin-top: 6px; }
      .cover .co { margin-top: 26px; font-size: 10pt; color: #44505c; } .cover .co b { font-size: 12pt; color: ${navy}; }
      h2 { color: ${navy}; font-size: 15pt; border-bottom: 1px solid #d5dbe2; padding-bottom: 8px; margin: 4px 0 16px; break-after: avoid; }
      h2 .n { color: ${accent}; margin-right: 4px; }
      h3 { color: ${navy}; font-size: 10.5pt; margin: 16px 0 6px; break-after: avoid; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 28px; }
      .f { border-bottom: 1px solid #dde2e8; padding: 6px 0 5px; break-inside: avoid; }
      .f.full { grid-column: 1 / -1; }
      .fl { font-size: 8.5pt; color: #6b7785; font-weight: bold; margin-bottom: 2px; }
      .fv { font-size: 10pt; color: #2a3340; }
      .fv p { margin: 0 0 6px; } .fv p:last-child { margin-bottom: 0; }
      .box { border: 1px solid #d5dbe2; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid-page; }
      .box p { margin: 0 0 9px; } .box p:last-child { margin-bottom: 0; }
      .muted { color: #8a95a2; } .small { font-size: 8.5pt; }
      .hl { background: #eef3f8; padding: 12px; font-weight: bold; color: ${navy}; margin-bottom: 10px; }
      table.est { width: 100%; border-collapse: collapse; font-size: 8.6pt; }
      table.est th { text-align: left; color: ${navy}; padding: 6px 5px; border-bottom: 1px solid #d5dbe2; vertical-align: bottom; }
      table.est td { padding: 5px; vertical-align: top; }
      table.est tr { break-inside: avoid; }
      table.est tbody tr:nth-child(odd) td { background: #f1f3f6; }
      table.est tbody.totals { break-inside: avoid; }
      table.est .ct { font-weight: bold; color: ${navy}; }
      table.est tr.tot td { font-weight: bold; color: ${navy}; background: #fff !important; }
      table.est tr.grand td { background: #8a8a8a !important; color: #fff; font-size: 12pt; font-weight: bold; padding: 8px 5px; }
      table.est td.url { word-break: break-all; }
      table.mot td.adv { font-size: 7.5pt; color: #44505c; }
      table.est .gh { font-size: 7pt; color: #8a95a2; white-space: nowrap; }
      table.est .unv { font-size: 7.5pt; font-weight: bold; color: #a4471b; }
      table.sum { width: 100%; border-collapse: collapse; font-size: 10pt; }
      table.sum th { text-align: left; color: ${navy}; padding: 6px 8px; border-bottom: 1px solid #d5dbe2; }
      table.sum td { padding: 6px 8px; font-weight: bold; color: #3b4652; }
      table.sum tr { break-inside: avoid; }
      table.sum tr:nth-child(even) td { background: #f1f3f6; }
      table.sum tr.grand td { background: #8a8a8a; color: #fff; font-size: 14pt; }
      .valbox { border: 1px solid #d5dbe2; padding: 8px; margin-bottom: 14px; break-inside: avoid; }
      .valhead { background: #2c3e50; color: #fff; padding: 8px 12px; } .vh1 { font-size: 13pt; font-weight: bold; } .vh2 { font-size: 7.5pt; }
      .vt { font-weight: bold; color: ${navy}; margin: 10px 4px 6px; }
      .bar { display: flex; align-items: center; margin: 4px 0; } .bl { width: 150px; text-align: right; padding-right: 8px; font-weight: bold; font-size: 9pt; }
      .bt { flex: 1; background: #f1f3f6; height: 30px; } .bf { height: 30px; color: #fff; font-weight: bold; font-size: 9pt; padding: 3px 8px; }
      .valgrid { display: grid; grid-template-columns: 1fr 1fr; margin-top: 12px; border-top: 2px solid #2c3e50; }
      .vcell { padding: 10px 12px; border: 1px solid #e1e5ea; } .vcell.adopted { background: #dbe8c7; }
      .vn { font-weight: bold; color: ${navy}; font-size: 11pt; margin-bottom: 8px; } .vl { font-size: 8.5pt; color: #6b7785; } .va { font-size: 15pt; font-weight: bold; }
      .verdict-lines p { font-size: 11.5pt; font-weight: bold; margin: 10px 0; }
      figure.photo { margin: 0 0 12px; break-inside: avoid; text-align: left; }
      .pwrap { position: relative; display: block; margin: 0 auto; width: fit-content; max-width: 100%; }
      .pwrap img { display: block; max-width: 100%; max-height: 85mm; }
      figure.photo.tight .pwrap img { max-height: 68mm; }
      .pmissing { border: 1px dashed #c5ccd5; padding: 28px 12px; text-align: center; color: #8a95a2; font-size: 9pt; }
      .pbox { position: absolute; border: 2.5px solid ${DEFAULT_LABEL}; border-radius: 2px; }
      .pbox.pre { border-style: dashed; }
      .ptag { position: absolute; color: #fff; font-size: 7pt; line-height: 1.25; font-weight: bold; padding: 1px 4px; white-space: normal; overflow-wrap: anywhere; word-break: break-word; border-radius: 2px 2px 0 0; }
      .ptag.in { border-radius: 0 0 2px 2px; } .ptag.r { text-align: right; }
      .ptag .ai { display: inline-block; margin-left: 2px; padding: 0 2px; border: 1px solid currentColor; border-radius: 2px; font-size: 5.5pt; line-height: 1.2; vertical-align: 1px; }
      figcaption { margin-top: 5px; } .pt { font-weight: bold; color: ${navy}; font-size: 9.5pt; } .pc { font-size: 8.5pt; margin-top: 2px; } .ps { font-size: 7pt; color: #8a95a2; }
      .inote h3 { margin: 10px 0 4px; } .inote p { margin: 0 0 4px; }
      .sigimg { max-height: 60px; max-width: 220px; }
      .nobreak { break-inside: avoid; }
      @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; width: auto; min-height: 0; padding: 0; } .pfoot { display: none !important; } }
    `;

    // Section headers are hidden in the Electron PDF (pdfTemplates() supplies the running header), so none is emitted there.
    const head = () => (pdf ? '' : `<div class="phead">${logoSrc ? '<span class="hlogo lg" role="img" aria-label="logo"></span>' : `<b>${esc(co.name)}</b>`}<div class="rt">${esc(co.reportTitle)}</div></div>`);
    const foot = preview ? `<div class="pfoot">${footerLine}</div>` : '';
    const page = (body, cls) => `<section class="page ${cls || ''}">${head()}${body}${foot}</section>`;

    // ---------- MOT history: every DVSA test ----------
    const motRows = arr(v.motHistory).filter((m) => m && typeof m === 'object');
    // a reading when DVSA recorded one; otherwise the odometer result type (e.g. unreadable, no odometer)
    const odometer = (m) => {
      const r = String(m.odometerResult || '').trim().toUpperCase();
      if (num(m.odometer) > 0 || (r === 'READ' && m.odometer !== '' && m.odometer != null)) return `${num(m.odometer).toLocaleString('en-GB')} ${esc(String(m.unit || '').toLowerCase())}`.trim();
      return esc(own(ODOMETER_RESULT, r) || (r && r !== 'READ' ? r.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Not recorded'));
    };
    const shortDefects = (m) => {
      const d = arr(m.defects).filter((x) => x != null && String(x).trim()).map((x) => { const s = String(x).trim(); return s.length > 110 ? s.slice(0, 107) + '…' : s; });
      return d.length ? esc(d.slice(0, 3).join('; ')) + (d.length > 3 ? ` <span class="muted">(+${d.length - 3} more)</span>` : '') : '—';
    };
    // the DVSA test number (to look the test up) when the data has it
    const testNo = (m) => String(m.testNumber == null ? '' : m.testNumber).trim();
    const hasTestNo = motRows.some((m) => testNo(m));
    const motTable = motRows.length ? `<h3>MOT test history (DVSA)</h3><table class="est mot"><thead><tr><th style="width:13%">Test date</th><th style="width:10%">Result</th><th style="width:13%">Odometer</th><th style="width:12%">Expiry</th>${hasTestNo ? '<th style="width:14%">Test number</th>' : ''}<th>Advisories / defects</th></tr></thead><tbody>${motRows.map((m) => `<tr><td>${esc(ukDate(m.date))}</td><td>${esc(m.result)}</td><td>${odometer(m)}</td><td>${esc(ukDate(m.expiry || '')) || '—'}</td>${hasTestNo ? `<td>${esc(testNo(m)) || '—'}</td>` : ''}<td class="adv">${shortDefects(m)}</td></tr>`).join('')}</tbody></table>` : '';
    // Adverts: those the assessor entered or checked are market evidence; those reported by an AI web search and not yet
    // checked (aiUnverified) are listed apart, marked as not verified, and never as like-for-like market evidence.
    const ads = arr(val.adverts).filter((x) => x && typeof x === 'object' && (x.description || x.price));
    const verifiedAds = ads.filter((x) => !x.aiUnverified), unverifiedAds = ads.filter((x) => x.aiUnverified);
    const adHead = '<thead><tr><th>Vehicle</th><th>Year</th><th>Mileage</th><th>Asking price</th><th>Source</th></tr></thead>';
    const adCells = (x) => `<td>${esc(x.description)}</td><td>${esc(x.year)}</td><td>${x.mileage ? num(x.mileage).toLocaleString('en-GB') : '—'}</td><td>${x.price ? gbp(x.price) : '—'}</td>`;
    const advertTable = verifiedAds.length ? `<h3>Like-for-like market evidence</h3><table class="est">${adHead}<tbody>${verifiedAds.map((x) => `<tr>${adCells(x)}<td class="url">${esc(x.source || '')}${x.source && x.url ? '<br>' : ''}${esc(x.url || '')}${x.source || x.url ? '' : '—'}</td></tr>`).join('')}</tbody></table>` : '';
    const unverifiedTable = unverifiedAds.length ? `<h3>Adverts found by AI search (link not verified)</h3><table class="est unverified">${adHead}<tbody>${unverifiedAds.map((x) => {
      // a link the assessor entered is not attributed to the AI; neither is presented as checked
      const url = String(x.url || '').trim(), claimed = String(x.claimedUrl || '').trim();
      const link = url ? `Link (not verified): ${esc(url)}` : claimed ? `Link given by the AI, not verified: ${esc(claimed)}` : '';
      return `<tr>${adCells(x)}<td class="url">${esc(x.source || 'AI web search')}<br><span class="unv">Not verified</span>${link ? `<br><span class="muted">${link}</span>` : ''}</td></tr>`;
    }).join('')}</tbody></table><p class="small muted">These adverts were reported by an AI web search. The assessor has not verified that they exist at the prices shown, so they are not presented as like-for-like market evidence.</p>` : '';

    // ---------- use of AI and data tools ----------
    const log = arr(job.aiLog).filter((x) => x && typeof x === 'object');
    const isDataEntry = (x) => x.ai === false || (x.ai == null && /\b(DVLA|DVSA)\b/i.test(`${x.model || ''} ${x.action || ''}`));
    const aiEntries = log.filter((x) => !isDataEntry(x));
    const dataEntries = log.filter(isDataEntry);
    const aiLines = lines.filter((l) => l.ai);
    const unreviewedLines = aiLines.filter((l) => !l.reviewed);
    // fields still holding AI-drafted text exactly as the AI wrote it (job.aiText), in report order
    const aiTextFields = typeof C.unreviewedAiText === 'function' ? arr(C.unreviewedAiText(job)) : [];
    const usedAI = aiEntries.length > 0 || aiLines.length > 0 || aiPhotos.length > 0 || aiTextFields.length > 0 || unverifiedAds.length > 0;
    const logItem = (x, kind) => { const day = dayOf(x.at); return `<li>${esc(x.action || (kind === 'ai' ? 'AI-assisted step' : 'Data lookup'))} (${esc(x.model || (kind === 'ai' ? 'AI' : 'data service'))})${day ? ' on ' + esc(day) : ''}</li>`; };
    const aiItems = aiEntries.length ? aiEntries.map((x) => logItem(x, 'ai')) : [
      aiLines.length ? `<li>AI-suggested estimate lines (${aiLines.length})</li>` : '',
      aiPhotos.length ? `<li>AI damage labelling of ${plural(aiPhotos.length, 'photograph')}</li>` : '',
      aiTextFields.length ? `<li>AI-drafted text (${plural(aiTextFields.length, 'field')})</li>` : '',
      unverifiedAds.length ? `<li>AI web search for comparable adverts (${unverifiedAds.length})</li>` : ''
    ].filter(Boolean);
    let reviewText = '';
    if (usedAI) {
      const open = [];
      if (unreviewedLines.length) {
        const names = unreviewedLines.slice(0, 5).map((l) => `“${esc(l.description || 'untitled line')}”`);
        open.push(`${plural(unreviewedLines.length, 'AI-suggested estimate line')} had not been marked as reviewed by the assessor when this report was produced: ${names.join('; ')}${unreviewedLines.length > 5 ? `; and ${unreviewedLines.length - 5} more` : ''}.`);
      }
      if (unreviewedPhotos.length) open.push(`The AI damage labels on ${andList(unreviewedPhotos.map(figName))} had not been reviewed by the assessor.`);
      if (aiTextFields.length) {
        const isPhoto = (f) => /^photos\./.test(String(f.path));
        const figs = (kind) => aiTextFields.filter((f) => isPhoto(f) && String(f.path).endsWith('.' + kind)).map((f) => String(f.label).replace(/^(?:Title|Caption) of /, ''));
        const titles = figs('title'), captions = figs('caption');
        const parts = aiTextFields.filter((f) => !isPhoto(f)).map((f) => String(f.label));
        if (titles.length) parts.push(`the ${titles.length === 1 ? 'title' : 'titles'} of ${andList(titles)}`);
        if (captions.length) parts.push(`the ${captions.length === 1 ? 'caption' : 'captions'} of ${andList(captions)}`);
        open.push(`The following text is AI-drafted and had not been edited or confirmed by the assessor when this report was produced: ${esc(parts.join('; '))}.`);
      }
      if (unverifiedAds.length) open.push(`${plural(unverifiedAds.length, 'advert')} found by AI web search had not been verified by the assessor; ${unverifiedAds.length === 1 ? 'it is' : 'they are'} listed separately in the valuation section and not presented as market evidence.`);
      reviewText = open.length
        ? `${open.join(' ')} The assessor takes full responsibility for the findings and opinions expressed in this report.`
        : 'All AI output was reviewed, edited where necessary and adopted by the assessor, who takes full responsibility for the findings and opinions expressed.';
    }
    const aiUse = usedAI || dataEntries.length ? `<h3>Use of AI and data tools</h3><p class="small">The following software assistance was used in preparing this report.</p>
      ${aiItems.length ? `<div class="small"><strong>AI assistance</strong></div><ul class="small">${aiItems.join('')}</ul>` : ''}
      ${dataEntries.length ? `<div class="small"><strong>Data services</strong></div><ul class="small">${dataEntries.map((x) => logItem(x, 'data')).join('')}</ul>` : ''}
      ${reviewText ? `<p class="small">${reviewText}</p>` : ''}
      ${dataEntries.length ? '<p class="small">Information from the data services listed is reproduced as supplied and has not been independently verified unless stated.</p>' : ''}` : '';

    // ---------- vehicle: paint finish, size class, DVLA / DVSA status ----------
    const dv = v.dvla && typeof v.dvla === 'object' ? v.dvla : null;
    const ms = v.motSummary && typeof v.motSummary === 'object' ? v.motSummary : null;
    // DVLA gives the month of first registration (or only the year), never the day
    const fromDvla = !!dv && !!dv.firstRegistration && dv.firstRegistration === v.firstReg;
    const precision = v.firstRegPrecision === 'year' ? 'year' : v.firstRegPrecision === 'month' || (!v.firstRegPrecision && fromDvla) ? 'month' : 'day';
    const firstRegText = regDate(v.firstReg, precision);
    // names only here: the size-class and paint-finish factors are this software's own guide-time factors, not vehicle
    // facts, so the labels say so and section 08 states the factors used
    const paintKey = String(v.paintType || 'metallic');
    const paintText = own(PAINT_FINISH, paintKey) || paintKey;
    const sizeKey = String(v.sizeClass || 'medium');
    const size = Array.isArray(own(C.SIZE_CLASSES, sizeKey)) ? C.SIZE_CLASSES[sizeKey] : null;
    const sizeText = size ? String(size[0]) : sizeKey;
    // section 08: the basis of the guide times, with each factor this vehicle's guide times are scaled by (when it is not 1)
    const factorOf = (x) => { const f = num(x); return f > 0 ? f : 1; };
    const fx = (f) => { const r = Math.round(f * 1000) / 1000; return '×' + (Math.abs(r * 100 - Math.round(r * 100)) < 1e-6 ? r.toFixed(2) : String(r)); };
    const sizeF = factorOf(C.sizeFactor(job)), paintF = factorOf(C.paintFactor(job));
    const scaling = [sizeF !== 1 ? `size class ${esc(sizeText)} ${fx(sizeF)}` : '', paintF !== 1 ? `paint finish ${esc(paintText)} ${fx(paintF)} (refinish work)` : ''].filter(Boolean);
    const guideBasis = (lines.length && scaling.length ? ` Guide times are scaled for this vehicle: ${scaling.join('; ')}.` : '') +
      (guideNotes ? ' Where an AI-suggested time was adjusted from the guide, the guide time for this vehicle is shown in brackets.' : '');
    const present = (x) => x != null && String(x).trim() !== '';
    // a DVLA flag as DVLA gave it; a flag DVLA did not give (null, missing) is never printed as "No"
    const flag = (b) => (b === true ? '<strong>Yes</strong>' : b === false ? 'No' : 'Not stated by DVLA');
    const withNote = (main, note) => [main, note].filter(Boolean).join(' — ');
    let statusBlock = '';
    if (dv || ms) {
      const fs = [];
      if (dv) {
        fs.push(field('Vehicle tax (DVLA)', t(withNote(dv.taxStatus, dv.taxDueDate ? 'due ' + ukDate(dv.taxDueDate) : ''))));
        fs.push(field('MOT status (DVLA)', t(withNote(dv.motStatus, dv.motExpiry ? 'expires ' + ukDate(dv.motExpiry) : ''))));
        fs.push(field('Marked for export (DVLA)', flag(dv.markedForExport)));
        fs.push(field('Marked as scrapped (DVLA)', flag(dv.markedAsScrapped)));
        // DVLA's registration dates have the month (or the year) only: printed so, never with an invented day
        const regAt = [dv.firstRegistration ? `first registered ${regDate(dv.firstRegistration, fromDvla && precision === 'year' ? 'year' : 'month')}` : '',
          dv.firstRegistrationWithDvla ? `first registered with DVLA ${regDate(dv.firstRegistrationWithDvla, 'month')}` : ''].filter(Boolean).join(', ');
        fs.push(field('Imported / re-registered (DVLA)', dv.importedOrReRegistered === true ? `<strong>Yes</strong>${regAt ? ' — ' + t(regAt) : ''}` : flag(dv.importedOrReRegistered)));
        if (dv.dateOfLastV5CIssued) fs.push(field('Last V5C issued (DVLA)', t(ukDate(dv.dateOfLastV5CIssued))));
        if (present(dv.yearOfManufacture)) fs.push(field('Year of manufacture (DVLA)', t(dv.yearOfManufacture)));
        if (present(dv.euroStatus)) fs.push(field('Euro status (DVLA)', t(dv.euroStatus)));
        if (present(dv.co2Emissions)) fs.push(field('CO₂ emissions (DVLA)', t(`${String(dv.co2Emissions).trim()} g/km`)));
        if (present(dv.wheelPlan)) fs.push(field('Wheel plan (DVLA)', t(dv.wheelPlan)));
      }
      if (ms) {
        fs.push(field('Outstanding safety recall (DVSA)', /^yes$/i.test(String(ms.recall || '')) ? '<strong>Yes</strong>' : t(ms.recall || 'Unknown')));
        if (ms.motTestDueDate) fs.push(field('MOT test due (DVSA)', t(ukDate(ms.motTestDueDate))));
      }
      // the UK calendar day of the lookup (a UTC timestamp sliced to 10 characters is the previous day just after midnight BST)
      const seen = (x) => { const day = x.lookedUpAt ? C.localISODate(x.lookedUpAt) : ''; return day ? ', looked up ' + ukDate(day) : ''; };
      const from = [dv && 'DVLA Vehicle Enquiry Service' + seen(dv), ms && 'DVSA MOT History' + seen(ms)].filter(Boolean).join('; ');
      statusBlock = `<h3>DVLA / DVSA status</h3><div class="grid">${fs.join('')}</div><p class="small muted">Source: ${esc(from)}. Status as recorded at the time of the lookup.</p>`;
    }

    const pages = [];

    // Cover
    pages.push(`<section class="page cover">
      ${logo}
      <h1>${esc(co.coverTitle).replace(/ &amp; /, ' &amp;<br>')}</h1>
      <div class="sub">${esc(co.coverSubtitle)}</div>
      <div class="grid">
        ${field('Vehicle make / model / derivative', t([v.make, v.model, v.derivative].filter(Boolean).join(' ')))}
        ${field('Registration', t(v.reg))}
        ${field('Report reference', t(rep.ref))}
        ${field('Date of loss', t(longDate(ins.dateOfLoss)))}
        ${field('Report date', t(longDate(rep.date)))}
        ${field('Version', t(rep.version))}
        ${field('Report status', t(rep.status))}
        ${field('Instructing party', t(ins.instructingParty))}
      </div>
      ${cpr ? '<div class="court">This report is addressed to the Court.</div>' : ''}
      ${o.headline ? `<div class="verdict">${esc(o.headline)}</div>` : ''}
      ${o.sub ? `<div class="verdict2">${esc(o.sub)}</div>` : ''}
      <div class="co"><b>${esc(co.name)}</b><br>${esc(co.tradingName)}<br>${esc(co.address)}<br><span class="small">T: ${esc(co.phone)} | E: ${esc(co.email)}</span></div>
      ${foot}
    </section>`);

    // 01 Summary
    pages.push(page(`${sec(o.sectionTitle)}${richPara(rep.summary)}`));

    // 02 Instruction, 03 Vehicle
    pages.push(page(`${sec('INSTRUCTION & CLAIM DETAILS')}
      <div class="grid">
        ${field('Instructing party', t(ins.instructingParty))}${field('Claimant / vehicle owner', t(obj(job.customer).name))}
        ${field('Own insurer', t(ins.ownInsurer))}${field('Own insurer claim reference', t(ins.ownRef))}
        ${field('Third-party insurer', t(ins.tpInsurer))}${field('Third-party claim reference', t(ins.tpRef))}
        ${field('Date of loss', t(ukDate(ins.dateOfLoss)))}${field('Location of loss', t(ins.locationOfLoss))}
        ${field('Third-party vehicle', t(ins.tpVehicle))}${field('Third-party registration', t(ins.tpReg))}
        ${field('Date instructions received', t(ukDate(ins.dateInstructed)))}${field('Instruction / file reference', t(ins.fileRef))}
      </div>
      <h3>Purpose of instruction</h3><div class="box">${para(ins.purpose)}</div>
      ${sec('VEHICLE DETAILS')}
      <div class="grid">
        ${field('Registration', t(v.reg))}${field('VIN / chassis number', t(v.vin))}
        ${field('Make', t(v.make))}${field('Model', t([v.model, v.derivative].filter(Boolean).join(' ')))}
        ${field('Mileage at inspection / units', v.mileage ? t(num(v.mileage).toLocaleString('en-GB') + ' ' + (v.mileageUnit || 'miles')) : '')}${field('Body type / number of doors', t(v.body))}
        ${field('Fuel type', t(v.fuel))}${field('Transmission', t(v.transmission))}
        ${field('Engine size', v.engineSize ? t(num(v.engineSize).toLocaleString('en-GB') + ' cc') : '')}${field('Engine code', t(v.engineCode))}
        ${field('Colour / paint code', t([v.colour, v.paintCode].filter(Boolean).join(' / ')))}${field('First registration date', t(firstRegText))}
        ${field('Paint finish (refinish-time basis)', t(paintText))}${field('Size class (guide-time basis)', t(sizeText))}
        ${field('ADAS / driver-assistance systems fitted', present(v.adas) ? t(v.adas) : 'Not recorded', 'full')}
      </div>
      ${statusBlock}`));

    // 04 Inspection
    const showExaminer = !!(insp.by || insp.byQualifications || cpr);
    // who examined the vehicle; in a CPR 35 report, when it was not the expert, whether under the expert's supervision
    // (PD 35 para 3.2(5); job.report.examinerSupervised 'yes' | 'no' | '')
    const fold = (s) => (typeof C.fold === 'function' ? C.fold(s) : String(s == null ? '' : s).trim().toLowerCase());
    const examiner = String(insp.by || '').trim();
    const examinerQuals = String(insp.byQualifications || '').trim();
    const examinerIsAuthor = !!examiner && !!fold(as.name) && fold(examiner) === fold(as.name);
    const supervised = typeof C.examinerSupervision === 'function' ? C.examinerSupervision(job) : '';
    const showSupervision = cpr && !!examiner && !examinerIsAuthor;
    pages.push(page(`${sec('INSPECTION DETAILS')}
      <div class="grid">
        ${field('Inspection date', t(ukDate(insp.date)))}${field('Inspection time', t(insp.time))}
        ${field('Inspection location', t(insp.location), 'full')}
        ${showExaminer ? field('Examined by', t(insp.by)) + field('Qualifications of examiner', t(insp.byQualifications)) : ''}
        ${showSupervision ? field("Examined under the expert's supervision", supervised === 'yes' ? 'Yes' : supervised === 'no' ? 'No' : 'Not recorded', 'full') : ''}
        ${field('Inspection type', t(insp.type))}${field('Vehicle condition at inspection', para(insp.condition))}
        ${field('Dismantling carried out', para(insp.dismantling))}${field('Photographs taken / source', t(insp.photos))}
        ${field('Diagnostic scan / tool', para(insp.diagnostic))}${field('Road test / reason if not completed', para(insp.roadTest))}
        ${field('Warning lamps', para(insp.warningLamps))}
      </div>`));

    // 05 Circumstances. A field still holding AI text (filled from the photo analysis, unedited) is the AI's assessment of
    // the photographs, not the account given, so it is never labelled "Reported".
    const aiPaths = new Set(aiTextFields.map((f) => String(f.path)));
    const circLabel = (key, reported, what) => (aiPaths.has('circumstances.' + key) ? 'Assessed from photographs (AI-assisted): ' + what : reported);
    pages.push(page(`${sec('ACCIDENT CIRCUMSTANCES')}
      <h3>Account provided by</h3><div class="box"><strong>${t(circ.providedBy) || '—'}</strong></div>
      <h3>Circumstances as reported</h3><div class="box">${para(circ.narrative)}</div>
      <div class="grid">
        ${field(circLabel('impactType', 'Reported impact type', 'impact type'), t(circ.impactType))}${field(circLabel('primaryArea', 'Reported primary impact area', 'primary impact area'), t(circ.primaryArea))}
        ${field(circLabel('secondaryArea', 'Reported secondary contact area', 'secondary contact area'), t(circ.secondaryArea))}${field(circLabel('direction', 'Reported direction of contact', 'direction of contact'), t(circ.direction))}
        ${field(circLabel('symptoms', 'Post-impact symptoms reported', 'post-impact symptoms'), t(circ.symptoms), 'full')}
      </div>
      ${circ.liabilityNote ? `<p class="small muted"><strong>${nl2br(circ.liabilityNote)}</strong></p>` : ''}`));

    // 06 Structural / mechanical
    pages.push(page(`${sec('STRUCTURAL, MECHANICAL & ROADWORTHINESS ASSESSMENT')}
      ${zonesText}
      <h3>Structural and Body/Panel Assessment</h3><div class="box">${para(a.structural)}</div>
      <h3>Mechanical assessment</h3><div class="box">${para(a.mechanical)}</div>
      <h3>Wheels &amp; tyres</h3><div class="box">${para(a.wheels)}</div>
      <h3>Wheel alignment / geometry</h3><div class="box">${para(a.geometry)}</div>
      <h3>Diagnostics &amp; warning lamps</h3><div class="box">${para(a.diagnostics)}</div>
      <h3>Roadworthiness</h3><div class="box">${para(a.roadworthiness)}</div>`));

    // 07 Valuation
    // as totals() works it out: the figure entered (a negative one is an input error and is ignored), else the % of PAV
    const salvageSet = tt.salvageEntered != null ? !!tt.salvageEntered : val.salvageOverride !== '' && val.salvageOverride != null;
    const salvagePct = tt.salvagePct != null ? tt.salvagePct : val.salvagePct;
    const salvageText = hasPav || salvageSet
      ? `${gbp(tt.salvage)} <span class="small muted">(${salvageSet ? 'specific figure entered' : pctText(salvagePct) + '% of PAV'})</span>`
      : 'Not assessed';
    const ratioText = hasPav
      ? `Excl. VAT: ${gbp(tt.net)} — ${tt.pctNet.toFixed(2)}%<br>Incl. VAT: ${gbp(tt.gross)} — ${tt.pctGross.toFixed(2)}%`
      : `Excl. VAT: ${gbp(tt.net)} — Not assessed<br>Incl. VAT: ${gbp(tt.gross)} — Not assessed<br><span class="small muted">No pre-accident value has been adopted.</span>`;
    const belowReason = String(val.belowHighestReason || '').trim();
    const claimK = claimKey(val.claimType);
    const claim = claimK === 'court' && cpr ? COURT_CPR : own(CLAIM_TYPES, claimK);
    // a salvage category belongs to a total loss only; beside any other decision it is "Not applicable"
    const decision = String(obj(job.outcome).decision || '').trim();
    const categoryText = o.isTL ? (catText(cat) || 'Not assessed') : /repair/i.test(decision) ? 'Not applicable (repairable)' : cat ? 'Not applicable (no total-loss decision)' : 'Not assessed';
    pages.push(page(`${sec('VALUATION')}
      <div class="grid">
        ${field('Valuation date / date assessed', t(val.date))}${field('Mileage used for valuation', val.mileage ? t(num(val.mileage).toLocaleString('en-GB') + ' ' + (v.mileageUnit || 'miles')) : '')}
        ${field('Cost at new', t(val.costNew || 'N/A'))}${field('Pre-accident condition', t(val.condition))}
        ${field('Claim type / valuation standard', t(claim ? `${claim[0]}. Valuation standard: ${claim[1]}.` : 'Not specified'), 'full')}
      </div>
      ${chart ? `<h3>Valuation evidence</h3>${chart}` : ''}
      <h3>Assessed value</h3><div class="hl">ASSESSED PRE-ACCIDENT VALUE - ${hasPav ? gbp(tt.pav) : 'Not assessed'}</div>
      ${belowReason && hasPav && highestNamed > tt.pav ? `<h3>Adopted value below the highest guide figure (${gbp0(highestNamed)})</h3><div class="box">${para(belowReason)}</div>` : ''}
      <div class="grid">
        ${field('Provisional salvage value (£)', salvageText)}${field('Salvage category, if assessed', t(categoryText))}
        ${field('Repair cost / value (%)', ratioText)}
        ${field('Economic repair / total-loss assessment', t(obj(job.outcome).decision))}
      </div>
      ${val.historyNotes && String(val.historyNotes).trim() ? `<h3>History notes</h3><div class="box">${para(val.historyNotes)}</div>` : ''}
      ${val.optionsNotes && String(val.optionsNotes).trim() ? `<h3>Condition, options &amp; service history</h3><div class="box">${para(val.optionsNotes)}</div>` : ''}
      ${motTable}${advertTable}${unverifiedTable}
      <h3>Valuation comments</h3><div class="box">${richPara(val.comments || '')}
      ${o.isTL ? `<div class="verdict-lines"><p>${esc(String(obj(job.outcome).decision).toUpperCase())}</p>${cat ? `<p>SALVAGE CATEGORY: ${esc(catText(cat).toUpperCase())}</p>` : ''}</div>` : ''}
      ${cat && o.isTL ? `<p class="small muted">Categorisation reference: ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage. Category N is a repairable non-structural salvage category; Category S is a repairable structural category. Neither is a roadworthiness certificate.${cat === 'A' || cat === 'B' ? ' Category A (scrap) and Category B (break) vehicles must not be returned to the road.' : ''}</p>` : ''}
      </div>`));

    // 08 Repair estimate + 09 summary
    pages.push(page(`${sec('REPAIR ESTIMATE')}
      <table class="est"><thead><tr><th>Cost Type</th><th>Description</th><th>Part No. / Ref</th><th>Labour Rate</th><th>Labour Hours</th><th>Labour Value</th><th>Parts / Materials / Service</th></tr></thead>
      <tbody>${lineRows || '<tr><td colspan="7" class="muted">No estimate lines.</td></tr>'}</tbody>
      <tbody class="totals">
        <tr class="tot"><td></td><td>TOTAL LABOUR</td><td></td><td></td><td>${hrs(tt.labourHours)} hrs</td><td>${gbp(tt.labour)}</td><td></td></tr>
        <tr class="tot"><td></td><td>REPLACEMENT PARTS TOTAL</td><td colspan="4"></td><td>${gbp(tt.parts)}</td></tr>
        <tr class="tot"><td></td><td>PAINT MATERIALS</td><td colspan="4"></td><td>${gbp(tt.paint)}</td></tr>
        <tr class="tot"><td></td><td>OTHER SERVICES / MATERIALS</td><td colspan="4"></td><td>${gbp(tt.other)}</td></tr>
        ${tt.discount ? `<tr class="tot"><td></td><td>LESS DISCOUNT</td><td colspan="4"></td><td>${gbp(-tt.discount)}</td></tr>` : ''}
        <tr class="grand"><td></td><td colspan="5">ESTIMATE SUBTOTAL EXCL. VAT</td><td>${gbp(tt.net)}</td></tr>
      </tbody></table>
      <p class="small muted">Labour times are the assessor's figures, entered or adjusted from this software's own guide times; they are not manufacturer- or Thatcham-published times unless stated in the line.${guideBasis} Part prices are exclusive of VAT.${lines.some((l) => l.ai && !l.reviewed) ? ' † AI-suggested line not yet reviewed by the assessor.' : ''}</p>
      <h3>Estimate notes</h3><div class="box">${para(job.estimateNotes)}</div>`));

    pages.push(page(`${sec('REPAIR COSTS SUMMARY')}
      <table class="sum"><thead><tr><th>Cost Heading</th><th style="width:35%">Amount</th></tr></thead><tbody>
        <tr><td>Parts Cost</td><td>${gbp(tt.parts)}</td></tr>
        <tr><td>Labour Cost</td><td>${gbp(tt.labour)}</td></tr>
        <tr><td>Paint Cost</td><td>${gbp(tt.paint)}</td></tr>
        <tr><td>Other Cost</td><td>${gbp(tt.other)}</td></tr>
        <tr><td>Discounts</td><td>${gbp(tt.discount ? -tt.discount : 0)}</td></tr>
        <tr><td>Net Cost</td><td>${gbp(tt.net)}</td></tr>
        <tr><td>VAT @ ${pctText(C.vatPctFor(job))}%</td><td>${gbp(tt.vat)}</td></tr>
        <tr class="grand"><td>TOTAL REPAIR COST</td><td>${gbp(tt.gross)}</td></tr>
      </tbody></table>`));

    // 10 Opinion
    pages.push(page(`${sec("REPORT COMMENTS / ENGINEER'S OPINION")}<div class="box">${richPara(job.opinion)}</div>`));

    // 11 Images (2 per page); always present so the later sections keep their numbers
    // (with no photographs, section 11 is a single sentence printed at the top of the section 12 page)
    const noPhotos = included.length ? '' : `${sec('IMAGES / PHOTOGRAPHIC EVIDENCE')}<p>No photographs are included in this report.</p>`;
    if (included.length) {
      const n11 = ++n;
      const sourceNote = `<div class="nobreak inote"><h3>Image source / date</h3><p class="small">Inspection and supporting photographs supplied for ${esc(v.reg)}. Capture dates/times and photographers are not independently verified by this document unless stated. Maintain the original uncropped files with the claim.</p>${preNote}${aiNote}</div>`;
      for (let i = 0; i < included.length; i += 2) {
        const pair = included.slice(i, i + 2);
        const last = i + 2 >= included.length;
        // the last page also carries the source note, so two photos there are drawn a little smaller
        const figs = pair.map((p, k) => photoFigure(p, figOf(p, i + k), last && pair.length === 2)).join('');
        pages.push(page(`${h2(n11, 'IMAGES / PHOTOGRAPHIC EVIDENCE')}${figs}${last ? sourceNote : ''}`));
      }
    }

    // 12 Customer
    const c = obj(job.customer);
    pages.push(page(`${noPhotos}${sec('CUSTOMER / CLIENT INFORMATION')}
      <div class="grid">
        ${field('Customer / Client full name', t(c.name))}${field('Company name, if applicable', t(c.company || 'N/A'))}
        ${field('Business representative, if applicable', t(c.representative))}${field('Relationship to vehicle', t(c.relationship))}
        ${field('Postal address', t(c.address), 'full')}
        ${field('Town / county', t(c.town))}${field('Postcode / country', t(c.postcode))}
        ${field('Telephone', t(c.telephone || 'Not provided'))}${field('Mobile', t(c.mobile || 'Not provided'))}
        ${field('Email address', t(c.email))}${field('VAT status, if relevant', t(c.vat || 'N/A'))}
      </div>
      <h3>Customer notes</h3><div class="box">${para(c.notes)}</div>`));

    // 13 Sign-off
    const supervision = !showSupervision ? '' : supervised === 'yes' ? ', under my supervision' : supervised === 'no' ? ', not under my supervision' : '';
    const examination = examiner
      ? `The examination of the vehicle described in section 04 was carried out by ${examinerIsAuthor ? 'me' : esc(examiner)}${examinerQuals && !examinerIsAuthor ? ` (${esc(examinerQuals)})` : ''}${supervision}.${showSupervision && !supervision ? ' Whether it was carried out under my supervision has not been recorded.' : ''}`
      : 'The person who carried out the examination of the vehicle described in section 04 has not been recorded.';
    const cprBlock = cpr ? `<h3>Expert's duty and statement of truth (CPR Part 35)</h3>
        <p>I understand that my duty is to help the court on matters within my expertise, and that this duty overrides any obligation to those instructing or paying me. I have complied with that duty and will continue to do so. I am aware of the requirements of CPR Part 35, Practice Direction 35 and the Guidance for the Instruction of Experts in Civil Claims 2014.</p>
        <p>${examination}</p>
        <p>I confirm that I have made clear which facts and matters referred to in this report are within my own knowledge and which are not. Those that are within my own knowledge I confirm to be true. The opinions I have expressed represent my true and complete professional opinions on the matters to which they refer.</p>
        <p>I understand that proceedings for contempt of court may be brought against anyone who makes, or causes to be made, a false statement in a document verified by a statement of truth without an honest belief in its truth.</p>` : '';
    // CPR 35 / PD 35 para 3.2(2): details of any literature or other material relied on in making the report
    const materials = cpr ? `<h3>Material relied on</h3><div class="box">${para(rep.materialsRelied)}</div>` : '';
    pages.push(page(`${sec('ASSESSOR DETAILS & SIGN-OFF')}
      <div class="grid">${field('Assessor name', `<strong>${t(as.name)}</strong>`)}${field('Professional role / title', `<strong>${t(as.title)}</strong>`)}
        ${field('Qualifications', t(qualifications))}${field('AQP ID (salvage categorisation)', t(aqpId))}</div>
      ${materials}
      ${aiUse}
      <div class="nobreak">
        <h3>Assessor declaration</h3>${para(declaration)}
        ${rep.conflicts ? `<p>${nl2br(rep.conflicts)}</p>` : ''}
        ${cprBlock}
        <div class="grid">
          ${field('Assessor signature', sig ? `<img class="sigimg" src="${sig}" alt="signature">` : '')}${field('Date signed', t(ukDate(as.dateSigned)))}
          ${field('Report reference', t(rep.ref))}${field('Report version / status', t([rep.version && 'Version ' + rep.version, rep.status].filter(Boolean).join(' — ')))}
        </div>
      </div>`));

    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(rep.ref || 'Engineering report')}</title><style>${css}</style></head><body>${pages.join('\n')}</body></html>`;
  }

  // Header/footer templates for Electron printToPDF (page numbers), and the page margins (mm) of the pdf-mode @page rule.
  // Uses the job's issued company details when finalised; without a job argument, the job most recently passed to render().
  function pdfTemplates(job) {
    const co = companyFor(job || lastJob);
    const navy = safeColour(co.navy, DEFAULT_NAVY);
    const logo = safeImage(co.logo);
    const side = `margin:0 ${PDF_MARGINS_MM.right}mm 0 ${PDF_MARGINS_MM.left}mm`;
    const header = `<div style="width:100%;${side};padding-bottom:4px;border-bottom:1px solid #d5dbe2;display:flex;justify-content:space-between;align-items:center;font-family:Arial;">
      ${logo ? `<img src="${logo}" style="height:34px" alt="">` : `<b style="font-size:10px;color:${navy}">${esc(co.name)}</b>`}
      <span style="font-size:8px;font-weight:bold;color:${navy}">${esc(co.reportTitle)}</span></div>`;
    const footer = `<div style="width:100%;${side};border-top:1px solid #d5dbe2;padding-top:4px;display:flex;justify-content:space-between;align-items:flex-end;font-family:Arial;font-size:6.5px;font-weight:bold;color:${navy}">
      <div>${esc(co.name)}${co.companyNo ? ' | Company No. ' + esc(co.companyNo) : ''} |<br>${esc(co.tradingName || '')}<br>${esc(co.address)} |<br>T: ${esc(co.phone)} | E: ${esc(co.email)} &nbsp;| PRIVATE &amp; CONFIDENTIAL</div>
      <div style="font-size:8px;font-weight:normal;color:#6b7785">Page <span class="pageNumber" style="font-size:11px;color:${navy}"></span> of <span class="totalPages" style="font-size:11px;color:${navy}"></span></div></div>`;
    const m = PDF_MARGINS_MM;
    return { header, footer, marginsMm: { top: m.top, bottom: m.bottom, left: m.left, right: m.right } };
  }

  window.Report = { render, pdfTemplates, outcomeText, CATEGORY_TEXT, safeImage, safeColour, PDF_MARGINS_MM };
})();
