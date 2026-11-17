/* Report renderer: builds the full engineering report as a standalone HTML document. */
(function () {
  'use strict';
  const C = window.Core;
  const { esc, gbp, gbp0, hrs, ukDate, longDate, num } = C;

  const CATEGORY_TEXT = {
    N: 'Category N — Non-Structural',
    S: 'Category S — Structural'
  };
  const BAR_COLOURS = ['#2e9a5a', '#2f4bb5', '#f2a20c', '#6b62e0', '#d0473b', '#1497a8'];

  function para(text) {
    if (!text) return '<p class="muted">—</p>';
    return String(text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  }
  function richPara(text) {
    // allow **bold** in narrative text
    return para(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  function field(label, value, cls) {
    return `<div class="f ${cls || ''}"><div class="fl">${esc(label)}</div><div class="fv">${value == null || value === '' ? '—' : value}</div></div>`;
  }
  const t = (v) => esc(v == null || v === '' ? '' : v);
  function h2(n, title) { return `<h2><span class="n">${String(n).padStart(2, '0')}</span> ${esc(title)}</h2>`; }

  function outcomeText(job) {
    const d = job.outcome.decision || '';
    const cat = job.outcome.category;
    const isTL = /total|ber|beyond/i.test(d);
    return {
      isTL,
      headline: job.report.headline || (isTL ? 'TOTAL LOSS RECOMMENDED' : d ? d.toUpperCase() + ' RECOMMENDED' : ''),
      sub: job.report.subHeadline || (isTL && cat ? `CATEGORY ${cat} - RECOMMENDATION` : ''),
      sectionTitle: isTL && cat ? `Category ${cat} — ${cat === 'S' ? 'Structural' : 'Non-Structural'} Total Loss` : (isTL ? 'Total Loss' : 'Assessment Summary')
    };
  }

  function photoFigure(p, i) {
    const labels = (p.labels || []).filter((l) => !l.hidden);
    const boxes = labels.map((l, k) => {
      const colour = l.colour || '#ff3b30';
      const tag = `<div class="ptag" style="left:${(l.x * 100).toFixed(2)}%;top:${(l.y * 100).toFixed(2)}%;background:${colour}">${k + 1}. ${esc(l.text)}</div>`;
      return `<div class="pbox" style="left:${(l.x * 100).toFixed(2)}%;top:${(l.y * 100).toFixed(2)}%;width:${(l.w * 100).toFixed(2)}%;height:${(l.h * 100).toFixed(2)}%;border-color:${colour}"></div>${tag}`;
    }).join('');
    return `<figure class="photo">
      <div class="pwrap"><img src="${p.dataUrl}" alt="">${boxes}</div>
      <figcaption><div class="pt">IMAGE ${String(i + 1).padStart(2, '0')} &nbsp;|&nbsp; ${esc(p.title || 'Photograph')}</div>
      ${p.caption ? `<div class="pc">${esc(p.caption)}</div>` : ''}
      <div class="ps">Source: ${esc(p.source || '')}</div></figcaption>
    </figure>`;
  }

  function render(job, opts) {
    opts = opts || {};
    const S = C.settings;
    const co = S.company;
    const tt = C.totals(job);
    const o = outcomeText(job);
    const v = job.vehicle;
    const ins = job.instruction;
    const insp = job.inspection;
    const circ = job.circumstances;
    const a = job.assessment;
    const val = job.valuation;
    const accent = co.accent || '#1a6fb5';
    const navy = co.navy || '#1f3349';
    const printMode = opts.mode || 'preview'; // preview | print | pdf
    const logo = co.logo ? `<img class="logo" src="${co.logo}" alt="">` : `<div class="logo-text">${esc(co.name)}</div>`;
    const footerLine = `${esc(co.name)}${co.companyNo ? ' | Company No. ' + esc(co.companyNo) : ''} | ${esc(co.tradingName || '')}<br>${esc(co.address)} |<br>T: ${esc(co.phone)} | E: ${esc(co.email)} &nbsp;| PRIVATE &amp; CONFIDENTIAL`;
    let n = 0;
    const sec = (title) => h2(++n, title);

    // ---------- valuation chart ----------
    const srcs = val.sources.filter((s) => s.name && num(s.amount) > 0);
    const maxV = Math.max(1, ...srcs.map((s) => num(s.amount)));
    const chart = srcs.length ? `<div class="valbox"><div class="valhead"><div class="vh1">Individual Valuations</div><div class="vh2">Breakdown by valuation source</div></div>
      <div class="vt">Valuation Comparison</div>
      ${srcs.map((s, i) => `<div class="bar"><div class="bl">${esc(s.name)}</div><div class="bt"><div class="bf" style="width:${(num(s.amount) / maxV * 100).toFixed(1)}%;background:${BAR_COLOURS[i % BAR_COLOURS.length]}">${gbp0(s.amount)}</div></div></div>`).join('')}
      <div class="valgrid">${srcs.map((s) => `<div class="vcell${num(s.amount) === tt.pav ? ' adopted' : ''}"><div class="vn">${esc(s.name)}</div><div class="vl">Valuation Amount</div><div class="va">${gbp0(s.amount)}</div></div>`).join('')}</div></div>` : '';

    // ---------- estimate table ----------
    const lineRows = job.lines.map((l) => {
      const rate = C.lineRate(job, l);
      const h = num(l.hours);
      return `<tr><td class="ct">${esc(l.type)}</td><td>${esc(l.description)}</td><td>${esc(l.partNo) || '—'}</td>
        <td>${h ? gbp(rate) + '/hr' : '—'}</td><td>${h ? hrs(h) : '—'}</td><td>${h ? gbp(h * rate) : '—'}</td><td>${num(l.amount) ? gbp(l.amount) : '—'}</td></tr>`;
    }).join('');

    const zonesText = (job.zones || []).length ? `<p class="small"><strong>Damage zones recorded:</strong> ${esc(job.zones.join(', '))}</p>` : '';
    const aiNote = job.photos.some((p) => p.aiLabelled)
      ? '<p class="small muted">Damage labels on photographs marked "AI" were generated with AI-assisted image analysis and reviewed by the assessor before issue. The assessor\'s findings in this report take precedence over any automated labelling.</p>' : '';

    const sig = job.assessor.signature || (job.assessor.useDefaultSignature ? S.assessor.signature : '');

    const css = `
      @page { size: A4; margin: ${printMode === 'pdf' ? '25mm 16mm 26mm 16mm' : '14mm 16mm 16mm 16mm'}; }
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; color: #2a3340; font-size: 10.5pt; line-height: 1.42; margin: 0; background: ${printMode === 'preview' ? '#e9edf2' : '#fff'}; }
      .page { background: #fff; ${printMode === 'preview' ? 'width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 16mm 24mm; box-shadow: 0 2px 10px rgba(0,0,0,.15); position: relative;' : ''} page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      .phead { display: ${printMode === 'pdf' ? 'none' : 'flex'}; justify-content: space-between; align-items: center; border-bottom: 1px solid #d5dbe2; padding-bottom: 6px; margin-bottom: 14px; }
      .phead img { height: 44px; } .phead .rt { font-weight: bold; font-size: 8.5pt; color: ${navy}; letter-spacing: .02em; }
      .pfoot { display: ${printMode === 'preview' ? 'block' : 'none'}; position: absolute; left: 16mm; right: 16mm; bottom: 8mm; border-top: 1px solid #d5dbe2; padding-top: 5px; font-size: 7pt; font-weight: bold; color: ${navy}; }
      .logo { max-height: 120px; max-width: 70%; } .logo-text { font-size: 28pt; font-weight: 900; color: ${navy}; }
      .cover { text-align: center; padding-top: 18mm; }
      .cover h1 { font-size: 26pt; line-height: 1.2; color: ${navy}; margin: 26px 40px 8px; }
      .cover .sub { color: #66717e; font-size: 10pt; margin-bottom: 30px; }
      .cover .grid { text-align: left; }
      .cover .verdict { color: ${accent}; font-weight: bold; font-size: 15pt; margin-top: 26px; }
      .cover .verdict2 { color: ${navy}; font-weight: bold; font-size: 11pt; margin-top: 6px; }
      .cover .co { margin-top: 26px; font-size: 10pt; color: #44505c; } .cover .co b { font-size: 12pt; color: ${navy}; }
      h2 { color: ${navy}; font-size: 15pt; border-bottom: 1px solid #d5dbe2; padding-bottom: 8px; margin: 4px 0 16px; break-after: avoid; }
      h2 .n { color: ${accent}; margin-right: 4px; }
      h3 { color: ${navy}; font-size: 10.5pt; margin: 16px 0 6px; break-after: avoid; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 28px; }
      .f { border-bottom: 1px solid #dde2e8; padding: 8px 0 7px; break-inside: avoid; }
      .f.full { grid-column: 1 / -1; }
      .fl { font-size: 8.5pt; color: #6b7785; font-weight: bold; margin-bottom: 2px; }
      .fv { font-size: 10pt; color: #2a3340; }
      .box { border: 1px solid #d5dbe2; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid-page; }
      .box p { margin: 0 0 9px; } .box p:last-child { margin-bottom: 0; }
      .muted { color: #8a95a2; } .small { font-size: 8.5pt; }
      .hl { background: #eef3f8; padding: 12px; font-weight: bold; color: ${navy}; margin-bottom: 10px; }
      table.est { width: 100%; border-collapse: collapse; font-size: 8.6pt; }
      table.est th { text-align: left; color: ${navy}; padding: 6px 5px; border-bottom: 1px solid #d5dbe2; vertical-align: bottom; }
      table.est td { padding: 5px; vertical-align: top; }
      table.est tbody tr:nth-child(odd) td { background: #f1f3f6; }
      table.est .ct { font-weight: bold; color: ${navy}; }
      table.est tr.tot td { font-weight: bold; color: ${navy}; background: #fff !important; }
      table.est tr.grand td { background: #8a8a8a !important; color: #fff; font-size: 12pt; font-weight: bold; padding: 8px 5px; }
      table.sum { width: 100%; border-collapse: collapse; font-size: 10pt; }
      table.sum th { text-align: left; color: ${navy}; padding: 6px 8px; border-bottom: 1px solid #d5dbe2; }
      table.sum td { padding: 6px 8px; font-weight: bold; color: #3b4652; }
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
      figure.photo { margin: 0 0 14px; break-inside: avoid; text-align: left; }
      .pwrap { position: relative; display: block; margin: 0 auto; width: fit-content; max-width: 100%; }
      .pwrap img { display: block; max-width: 100%; max-height: 95mm; }
      .pbox { position: absolute; border: 2.5px solid #ff3b30; border-radius: 2px; }
      .ptag { position: absolute; transform: translateY(-100%); color: #fff; font-size: 7pt; font-weight: bold; padding: 1px 4px; white-space: nowrap; border-radius: 2px 2px 0 0; }
      figcaption { margin-top: 6px; } .pt { font-weight: bold; color: ${navy}; font-size: 9.5pt; } .pc { font-size: 8.5pt; margin-top: 3px; } .ps { font-size: 7pt; color: #8a95a2; }
      .sigimg { max-height: 60px; max-width: 220px; }
      .nobreak { break-inside: avoid; }
      @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; width: auto; min-height: 0; padding: 0; } .pfoot { display: none !important; } }
    `;

    const head = (wide) => `<div class="phead">${co.logo ? `<img src="${co.logo}" alt="">` : `<b>${esc(co.name)}</b>`}<div class="rt">${esc(co.reportTitle)}</div></div>`;
    const foot = `<div class="pfoot">${footerLine}</div>`;
    const page = (body, cls) => `<section class="page ${cls || ''}">${head()}${body}${foot}</section>`;

    const pages = [];

    // Cover
    pages.push(`<section class="page cover">
      ${logo}
      <h1>${esc(co.coverTitle).replace(/ &amp; /, ' &amp;<br>')}</h1>
      <div class="sub">${esc(co.coverSubtitle)}</div>
      <div class="grid">
        ${field('Vehicle make / model / derivative', t([v.make, v.model, v.derivative].filter(Boolean).join(' ')))}
        ${field('Registration', t(v.reg))}
        ${field('Report reference', t(job.report.ref))}
        ${field('Date of loss', t(longDate(ins.dateOfLoss)))}
        ${field('Report date', t(longDate(job.report.date)))}
        ${field('Version', t(job.report.version))}
        ${field('Report status', t(job.report.status))}
        ${field('Instructing party', t(ins.instructingParty))}
      </div>
      ${o.headline ? `<div class="verdict">${esc(o.headline)}</div>` : ''}
      ${o.sub ? `<div class="verdict2">${esc(o.sub)}</div>` : ''}
      <div class="co"><b>${esc(co.name)}</b><br>${esc(co.tradingName)}<br>${esc(co.address)}<br><span class="small">T: ${esc(co.phone)} | E: ${esc(co.email)}</span></div>
      ${foot}
    </section>`);

    // 01 Summary
    pages.push(page(`${sec(o.sectionTitle)}${richPara(job.report.summary)}`));

    // 02 Instruction, 03 Vehicle
    pages.push(page(`${sec('INSTRUCTION & CLAIM DETAILS')}
      <div class="grid">
        ${field('Instructing party', t(ins.instructingParty))}${field('Claimant / vehicle owner', t(job.customer.name))}
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
        ${field('Mileage at inspection / units', v.mileage ? t(num(v.mileage).toLocaleString('en-GB') + ' ' + v.mileageUnit) : '')}${field('Body type / number of doors', t(v.body))}
        ${field('Fuel type', t(v.fuel))}${field('Transmission', t(v.transmission))}
        ${field('Engine size', v.engineSize ? t(num(v.engineSize).toLocaleString('en-GB') + ' cc') : '')}${field('Engine code', t(v.engineCode))}
        ${field('Colour / paint code', t([v.colour, v.paintCode].filter(Boolean).join(' / ')))}${field('First registration date', t(longDate(v.firstReg)))}
      </div>`));

    // 04 Inspection
    pages.push(page(`${sec('INSPECTION DETAILS')}
      <div class="grid">
        ${field('Inspection date', t(ukDate(insp.date)))}${field('Inspection time', t(insp.time))}
        ${field('Inspection location', t(insp.location), 'full')}
        ${field('Inspection type', t(insp.type))}${field('Vehicle condition at inspection', para(insp.condition))}
        ${field('Dismantling carried out', para(insp.dismantling))}${field('Photographs taken / source', t(insp.photos))}
        ${field('Diagnostic scan / tool', para(insp.diagnostic))}${field('Road test / reason if not completed', para(insp.roadTest))}
        ${field('Warning lamps', para(insp.warningLamps))}
      </div>`));

    // 05 Circumstances
    pages.push(page(`${sec('ACCIDENT CIRCUMSTANCES')}
      <h3>Account provided by</h3><div class="box"><strong>${t(circ.providedBy) || '—'}</strong></div>
      <h3>Circumstances as reported</h3><div class="box">${para(circ.narrative)}</div>
      <div class="grid">
        ${field('Reported impact type', t(circ.impactType))}${field('Reported primary impact area', t(circ.primaryArea))}
        ${field('Reported secondary contact area', t(circ.secondaryArea))}${field('Reported direction of contact', t(circ.direction))}
        ${field('Post-impact symptoms reported', t(circ.symptoms), 'full')}
      </div>
      ${circ.liabilityNote ? `<p class="small muted"><strong>${esc(circ.liabilityNote)}</strong></p>` : ''}`));

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
    const valComments = val.comments || '';
    pages.push(page(`${sec('VALUATION')}
      <div class="grid">
        ${field('Valuation date / date assessed', t(val.date))}${field('Mileage used for valuation', val.mileage ? t(num(val.mileage).toLocaleString('en-GB') + ' ' + v.mileageUnit) : '')}
        ${field('Cost at new', t(val.costNew || 'N/A'))}${field('Pre-accident condition', t(val.condition))}
      </div>
      <h3>Valuation evidence</h3>${chart}
      <h3>Assessed value</h3><div class="hl">ASSESSED PRE-ACCIDENT VALUE - ${gbp(tt.pav)}</div>
      <div class="grid">
        ${field('Provisional salvage value (£)', gbp(tt.salvage))}${field('Salvage category, if assessed', t(CATEGORY_TEXT[job.outcome.category] || 'Not assessed'))}
        ${field('Repair cost / value (%)', `Excl. VAT: ${gbp(tt.net)} — ${tt.pctNet.toFixed(2)}%<br>Incl. VAT: ${gbp(tt.gross)} — ${tt.pctGross.toFixed(2)}%`)}
        ${field('Economic repair / total-loss assessment', t(job.outcome.decision))}
      </div>
      <h3>Valuation comments</h3><div class="box">${richPara(valComments)}
      ${o.isTL ? `<div class="verdict-lines"><p>${esc(String(job.outcome.decision).toUpperCase())}</p>${job.outcome.category ? `<p>SALVAGE CATEGORY: ${esc(CATEGORY_TEXT[job.outcome.category].toUpperCase())}</p>` : ''}</div>` : ''}
      ${job.outcome.category ? '<p class="small muted">Categorisation reference: ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage. Category N is a repairable non-structural salvage category; Category S is a repairable structural category. Neither is a roadworthiness certificate.</p>' : ''}
      </div>`));

    // 08 Repair estimate + 09 summary
    pages.push(page(`${sec('REPAIR ESTIMATE')}
      <table class="est"><thead><tr><th>Cost Type</th><th>Description</th><th>Part No. / Ref</th><th>Labour Rate</th><th>Labour Hours</th><th>Labour Value</th><th>Parts / Materials / Service</th></tr></thead>
      <tbody>${lineRows || '<tr><td colspan="7" class="muted">No estimate lines.</td></tr>'}
        <tr class="tot"><td></td><td>TOTAL LABOUR</td><td></td><td></td><td>${hrs(tt.labourHours)} hrs</td><td>${gbp(tt.labour)}</td><td></td></tr>
        <tr class="tot"><td></td><td>REPLACEMENT PARTS TOTAL</td><td colspan="4"></td><td>${gbp(tt.parts)}</td></tr>
        <tr class="tot"><td></td><td>PAINT MATERIALS</td><td colspan="4"></td><td>${gbp(tt.paint)}</td></tr>
        <tr class="tot"><td></td><td>OTHER SERVICES / MATERIALS</td><td colspan="4"></td><td>${gbp(tt.other)}</td></tr>
        <tr class="grand"><td></td><td colspan="5">ESTIMATE SUBTOTAL EXCL. VAT</td><td>${gbp(tt.net)}</td></tr>
      </tbody></table>
      <h3>Estimate notes</h3><div class="box">${para(job.estimateNotes)}</div>`));

    pages.push(page(`${sec('REPAIR COSTS SUMMARY')}
      <table class="sum"><thead><tr><th>Cost Heading</th><th style="width:35%">Amount</th></tr></thead><tbody>
        <tr><td>Parts Cost</td><td>${gbp(tt.parts)}</td></tr>
        <tr><td>Labour Cost</td><td>${gbp(tt.labour)}</td></tr>
        <tr><td>Paint Cost</td><td>${gbp(tt.paint)}</td></tr>
        <tr><td>Other Cost</td><td>${gbp(tt.other)}</td></tr>
        <tr><td>Discounts</td><td>${gbp(tt.discount)}</td></tr>
        <tr><td>Net Cost</td><td>${gbp(tt.net)}</td></tr>
        <tr><td>VAT @ ${num(S.vatPct)}%</td><td>${gbp(tt.vat)}</td></tr>
        <tr class="grand"><td>TOTAL REPAIR COST</td><td>${gbp(tt.gross)}</td></tr>
      </tbody></table>`));

    // 10 Opinion
    pages.push(page(`${sec("REPORT COMMENTS / ENGINEER'S OPINION")}<div class="box">${richPara(job.opinion)}</div>`));

    // 11 Images (2 per page)
    if (job.photos.length) {
      const photos = job.photos.filter((p) => !p.exclude);
      for (let i = 0; i < photos.length; i += 2) {
        const pair = photos.slice(i, i + 2).map((p, k) => photoFigure(p, i + k)).join('');
        n = i === 0 ? n + 1 : n;
        const title = h2(n, 'IMAGES / PHOTOGRAPHIC EVIDENCE');
        const last = i + 2 >= photos.length;
        pages.push(page(`${title}${pair}${last ? `<h3>Image source / date</h3><p class="small">Inspection and supporting photographs supplied for ${esc(v.reg)}. Capture dates/times and photographers are not independently verified by this document unless stated. Maintain the original uncropped files with the claim.</p>${aiNote}` : ''}`));
      }
    }

    // 12 Customer
    const c = job.customer;
    pages.push(page(`${sec('CUSTOMER / CLIENT INFORMATION')}
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
    pages.push(page(`${sec('ASSESSOR DETAILS & SIGN-OFF')}
      <div class="grid">${field('Assessor name', `<strong>${t(job.assessor.name)}</strong>`)}${field('Professional role / title', `<strong>${t(job.assessor.title)}</strong>`)}</div>
      <h3>Assessor declaration</h3>${para(S.assessor.declaration)}
      <div class="grid nobreak">
        ${field('Assessor signature', sig ? `<img class="sigimg" src="${sig}" alt="signature">` : '')}${field('Date signed', t(ukDate(job.assessor.dateSigned)))}
        ${field('Report reference', t(job.report.ref))}${field('Report version / status', t(job.report.status))}
      </div>`));

    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(job.report.ref || 'Engineering report')}</title><style>${css}</style></head><body>${pages.join('\n')}</body></html>`;
  }

  // Header/footer templates for Electron printToPDF (page numbers)
  function pdfTemplates() {
    const co = C.settings.company;
    const navy = co.navy || '#1f3349';
    const header = `<div style="width:100%;margin:0 16mm;padding-bottom:4px;border-bottom:1px solid #d5dbe2;display:flex;justify-content:space-between;align-items:center;font-family:Arial;">
      ${co.logo ? `<img src="${co.logo}" style="height:34px">` : `<b style="font-size:10px;color:${navy}">${esc(co.name)}</b>`}
      <span style="font-size:8px;font-weight:bold;color:${navy}">${esc(co.reportTitle)}</span></div>`;
    const footer = `<div style="width:100%;margin:0 16mm;border-top:1px solid #d5dbe2;padding-top:4px;display:flex;justify-content:space-between;align-items:flex-end;font-family:Arial;font-size:6.5px;font-weight:bold;color:${navy}">
      <div>${esc(co.name)}${co.companyNo ? ' | Company No. ' + esc(co.companyNo) : ''} |<br>${esc(co.tradingName || '')}<br>${esc(co.address)} |<br>T: ${esc(co.phone)} | E: ${esc(co.email)} &nbsp;| PRIVATE &amp; CONFIDENTIAL</div>
      <div style="font-size:8px;font-weight:normal;color:#6b7785">Page <span class="pageNumber" style="font-size:11px;color:${navy}"></span> of <span class="totalPages" style="font-size:11px;color:${navy}"></span></div></div>`;
    return { header, footer };
  }

  window.Report = { render, pdfTemplates, outcomeText, CATEGORY_TEXT };
})();
