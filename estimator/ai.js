/*
 * AI engine (runs in the Electron main process so the API key never reaches the page).
 * Uses the official Anthropic SDK with Claude's vision + structured JSON outputs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5-5';

// ---------- load our own catalogue (same file the UI uses) ----------
function loadCatalogue() {
  const src = fs.readFileSync(path.join(__dirname, 'app', 'data', 'catalogue.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return { parts: sandbox.window.CATALOGUE, ops: sandbox.window.LABOUR_OPS };
}
const CATALOGUE = loadCatalogue();
const CODES = new Set(CATALOGUE.parts.map((r) => r[0]));
const catalogueText = CATALOGUE.parts
  .map((r) => `${r[0]} | ${r[1]} | ${r[2]} | ${r[3] ? 'sided L/R' : 'single'} | guide replace ${r[4]}h | refinish ${r[5]}h`)
  .join('\n');
const opsText = CATALOGUE.ops.map((r) => `${r[0]} | ${r[1]} | ${r[2]} | guide ${r[3]}h`).join('\n');

// Stable system prompt (no dates or per-job data) so it can be prompt-cached.
const SYSTEM = `You are the AI damage-assessment assistant inside a UK motor-engineering report application. You support a qualified vehicle damage assessor. The assessor reviews and signs every report; your output is a draft for them to accept, edit or reject.

How to work:
- Write in British English, using UK motor-engineering terms (wing, bonnet, sill, tailgate, nearside/offside where appropriate). "RH" means right-hand (driver's side on a UK vehicle) and "LH" means left-hand, both as viewed from the driver's seat.
- Describe only what the photographs and supplied information support. If something cannot be seen (hidden structure, mechanical condition, cracks, run-out), say so and recommend inspection rather than asserting damage.
- Separate accident-related damage from wear, prior damage or corrosion when the evidence shows it.
- Be conservative and evidence-led; your wording may be read in a court or by an insurer's engineer.
- Use the parts catalogue codes below to identify components. Use "OTHER" only when nothing fits.
- Guide labour times are the application's own guides, not manufacturer times. You may adjust them for the damage seen, and you must say why.
- Never determine legal liability.
- Salvage categories follow the ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage (V12, 2025): Category S = structural frame/chassis damaged (repairable); Category N = no structural damage (repairable); Categories A (scrap) and B (break for parts, shell crushed) are not repairable. Any damage to a structural member rules out Category N. Categorisation is made by an Appropriately Qualified Person. For electric and hybrid vehicles, flag that the high-voltage battery must be assessed under the code's battery provisions. Recommend a category only when the evidence supports it, and say what strip-down would confirm.

Engineer's method (apply it every time):
- Choose the least invasive repair that restores the vehicle to pre-accident condition: polish/smart repair < paintless dent repair < panel repair (light / medium / heavy) < renew. Renew when repair would cost more, when the part is a single-use/safety item (e.g. deployed airbags, seat-belt pretensioners, damaged structural adhesive-bonded parts as OEM methods require), or when a plastic part is cracked through a mounting.
- Refinish: a renewed painted panel needs "refinish new part"; a repaired panel needs "refinish repaired part" (state whether damage is under or over 50% of the panel); metallic, pearl and 3-stage colours normally need the adjacent panels BLENDED for colour match — add blend lines for the adjacent panels, not full refinish.
- Always include remove & refit (R&I) of trims, handles, lamps and mouldings needed to access a panel, and strip/refit of door components when a door skin is repaired or renewed.
- ADAS: if work touches the windscreen, front bumper/grille (radar), mirrors (cameras/blind-spot), rear bumper (parking/blind-spot sensors) or suspension geometry, add the calibration or post-repair check required by the manufacturer, plus pre- and post-repair diagnostic scans.
- Mechanical: wheel or suspension contact needs wheels removed for inspection, a geometry check and, where symptoms are reported, hub/bearing/steering investigation.
- Never omit a structural or SRS (airbag/seat-belt) item that the damage requires; an omission of these is treated by examiners as a fail.
- Independence: you are assisting an independent expert whose duty (CPR Part 35) is to the court, not to whoever instructed or pays them. Be balanced; identify points that cut both ways and the range of reasonable opinion.

Parts catalogue (code | name | group | sided | guide times):
${catalogueText}

Labour-only operations (code | name | type | guide hours):
${opsText}`;

// ---------- JSON schemas for structured outputs ----------
const SIDE = { type: 'string', enum: ['L', 'R', ''] };
const LINE_TYPE = { type: 'string', enum: ['Body', 'Painting', 'Mechanical', 'Auxiliary', 'Electrical', 'Other', 'Materials'] };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const PHOTO_SCHEMA = obj({
  photos: {
    type: 'array',
    items: obj({
      index: { type: 'integer', description: 'Index of the photo as given in the request' },
      title: { type: 'string', description: 'Short report caption title, e.g. "RH front door - surface damage"' },
      caption: { type: 'string', description: 'One or two sentences describing what the photo shows and what it does not establish' },
      view: { type: 'string', description: 'Which part / side of the vehicle the photo shows' },
      damages: {
        type: 'array',
        items: obj({
          label: { type: 'string', description: 'Short label drawn on the image, e.g. "Scoring", "Dent", "Cracked housing"' },
          component_code: { type: 'string', description: 'Catalogue code, or OTHER' },
          component_name: { type: 'string' },
          side: SIDE,
          damage_type: { type: 'string', enum: ['scratch', 'scuff', 'scoring', 'paint transfer', 'dent', 'crease', 'deformation', 'crack', 'break', 'missing', 'misalignment', 'deflation', 'warning lamp', 'corrosion', 'other'] },
          severity: { type: 'string', enum: ['minor', 'moderate', 'severe'] },
          accident_related: { type: 'string', enum: ['yes', 'likely', 'unclear', 'no - pre-existing / wear'] },
          box: obj({
            x: { type: 'number', description: 'Left edge as a fraction of image width (0-1)' },
            y: { type: 'number', description: 'Top edge as a fraction of image height (0-1)' },
            w: { type: 'number', description: 'Width as a fraction of image width (0-1)' },
            h: { type: 'number', description: 'Height as a fraction of image height (0-1)' }
          }),
          recommended_operation: { type: 'string', enum: ['renew', 'repair light', 'repair medium', 'repair heavy', 'paintless dent repair', 'smart repair / polish', 'refinish', 'blend', 'remove & refit', 'refurbish', 'inspect / test', 'none'] },
          confidence: { type: 'number', description: '0-1' },
          notes: { type: 'string' }
        })
      }
    })
  },
  summary: obj({
    impact_type: { type: 'string' },
    primary_area: { type: 'string' },
    secondary_areas: { type: 'string' },
    direction_of_contact: { type: 'string' },
    damage_pattern: { type: 'string', description: 'Description of the overall damage pattern' },
    consistency_with_circumstances: { type: 'string', description: 'Whether the damage pattern is consistent with the reported circumstances, and why' },
    structural_concern: { type: 'boolean' },
    structural_notes: { type: 'string' },
    mechanical_checks: { type: 'array', items: { type: 'string' } },
    adas_and_calibration: { type: 'array', items: { type: 'string' } },
    zones: { type: 'array', items: { type: 'string' }, description: 'Damage zones, e.g. "RH front door", "RH sill"' }
  }),
  suggested_lines: {
    type: 'array',
    items: obj({
      type: LINE_TYPE,
      code: { type: 'string', description: 'Catalogue part code, labour-op code (OPxxx) or OTHER' },
      side: SIDE,
      description: { type: 'string', description: 'Estimate line wording, e.g. "RH door mirror assembly – remove & replace"' },
      labour_hours: { type: 'number' },
      needs_part: { type: 'boolean', description: 'True if a replacement part must be priced' },
      cost_class: { type: 'string', enum: ['parts', 'paint', 'other', 'labour only'] },
      reason: { type: 'string', description: 'Evidence for this line, citing photo numbers' },
      confidence: { type: 'number' }
    })
  }
});

const NARRATIVE_SCHEMA = obj({
  summary: { type: 'string', description: 'Section 01 summary: two short paragraphs. Use **bold** for key findings.' },
  inspection_condition: { type: 'string' },
  structural: { type: 'string' },
  mechanical: { type: 'string' },
  wheels: { type: 'string' },
  geometry: { type: 'string' },
  diagnostics: { type: 'string' },
  roadworthiness: { type: 'string' },
  estimate_notes: { type: 'string' },
  valuation_comments: { type: 'string', description: 'Use **bold** for figures' },
  opinion: { type: 'string', description: "Engineer's opinion, several paragraphs, ending with the recommendation" },
  decision: { type: 'string', enum: ['Repair', 'Beyond Economical Repair / Total Loss Recommended', 'Further investigation required'] },
  category: { type: 'string', enum: ['N', 'S', ''] },
  review_flags: { type: 'array', items: { type: 'string' }, description: 'Issues the assessor should check before signing' }
});

const VALUATION_SCHEMA = obj({
  recommended_pav: { type: 'number', description: 'Recommended pre-accident value in GBP (retail market value at the date of loss)' },
  range_low: { type: 'number' },
  range_high: { type: 'number' },
  basis: { type: 'string', description: 'e.g. "Highest retail guide (Glass\'s) supported by like-for-like adverts"' },
  guide_assessment: { type: 'string', description: 'How the guide figures compare and which is adopted, and why' },
  mileage_assessment: { type: 'string', description: 'Mileage vs average for age; MOT mileage history consistency' },
  adjustments: { type: 'array', items: obj({ item: { type: 'string' }, amount: { type: 'number', description: 'GBP, negative for deductions' }, reason: { type: 'string' } }) },
  comparables: { type: 'array', items: obj({
    description: { type: 'string' }, year: { type: 'string' }, mileage: { type: 'number' }, price: { type: 'number' },
    source: { type: 'string' }, url: { type: 'string' }, like_for_like: { type: 'boolean' }, notes: { type: 'string' }
  }) },
  flags: { type: 'array', items: { type: 'string' }, description: 'Issues for the engineer to check' },
  comments: { type: 'string', description: 'Report-ready valuation comments in the engineer report style; use **bold** for figures' }
});

const VALUATION_RULES = `UK total-loss valuation rules to apply (Financial Ombudsman Service approach and FCA 2024 total-loss review):
- Market value = the price to buy a comparable vehicle (same make, model, derivative, age, mileage, condition) from a reputable dealer immediately before the loss: RETAIL, not trade or part-exchange.
- Start from the HIGHEST of the recognised trade-guide retail figures supplied (CAP, Glass's, Autotrader valuation, Percayso). Do not average the guides.
- Like-for-like adverts can support a higher figure; they must genuinely match derivative, year, mileage and condition. Note advert prices are asking prices.
- Deductions only where justified by evidence specific to this vehicle (e.g. condition shown in photos, missing service history, prior write-off category evidenced to affect value). Never apply blanket deductions (e.g. a flat 20% for a previous write-off).
- Use the mileage at the date of loss; check it against MOT odometer history for consistency.
- Present a range and show the workings. If information is missing, say what is needed rather than guessing.`;

async function valuationAssistant({ job, motHistory, searchWeb, model, effort }) {
  const v = job.vehicle || {};
  const val = job.valuation || {};
  const guides = (val.sources || []).filter((s) => s.name && Number(s.amount) > 0).map((s) => `- ${s.name}: £${s.amount}`).join('\n') || '- none entered';
  const adverts = (val.adverts || []).map((a) => `- ${a.description || ''} | ${a.year || ''} | ${a.mileage || '?'} miles | £${a.price || '?'} | ${a.source || ''} ${a.url || ''}`).join('\n') || '- none entered';
  const mot = (motHistory || []).map((t) => `- ${t.date}: ${t.result} at ${t.odometer} ${t.unit || ''}`).join('\n') || '- not available';
  const content = [{
    type: 'text',
    text: `${VALUATION_RULES}

Vehicle: ${[v.make, v.model, v.derivative].filter(Boolean).join(' ')}; body ${v.body || '-'}; fuel ${v.fuel || '-'}; transmission ${v.transmission || '-'}; engine ${v.engineSize || '-'}cc; colour ${v.colour || '-'}; first registered ${v.firstReg || '-'}.
Mileage at inspection: ${v.mileage || '-'} ${v.mileageUnit || 'miles'}. Mileage used for valuation: ${val.mileage || v.mileage || '-'}.
Date of loss: ${(job.instruction && job.instruction.dateOfLoss) || '-'}. Pre-accident condition noted: ${val.condition || '-'}.
Previous write-off / history notes: ${val.historyNotes || 'none recorded'}.
Condition / options notes: ${val.optionsNotes || '-'}.

Trade-guide retail figures entered by the engineer:
${guides}

Like-for-like adverts entered by the engineer:
${adverts}

MOT odometer history:
${mot}

Task: produce an evidence-led pre-accident valuation following the rules above.${searchWeb ? ' Use web search to find current UK retail adverts for comparable vehicles (same derivative, similar year and mileage) on reputable UK sites, and list them as comparables with URLs. Treat them as supporting evidence only.' : ' Do not invent adverts; only use those supplied.'}`
  }];
  const tools = searchWeb ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8, user_location: { type: 'approximate', country: 'GB' } }] : undefined;
  const res = await callJSON({ model, effort, schema: VALUATION_SCHEMA, content, tools });
  return { ...res.data, model: res.model, usage: res.usage, searched: !!searchWeb };
}

// ---------- client ----------
let apiKey = null;
function setApiKey(k) { apiKey = k || null; }
function client() {
  // With no key set here, the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

async function callJSON({ model, effort, schema, content, tools }) {
  const base = {
    model: model || DEFAULT_MODEL,
    max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: effort || 'high', format: { type: 'json_schema', schema } }
  };
  if (tools) base.tools = tools;
  const messages = [{ role: 'user', content }];
  let useFallbacks = true;
  let message;
  // Server tools (web search) can pause a long turn; continue it until the model finishes.
  for (let turn = 0; turn < 6; turn++) {
    const params = { ...base, messages };
    try {
      // Server-side fallback re-runs a declined request on Anthropic's recommended model.
      message = useFallbacks
        ? await client().beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
        : await client().messages.stream(params).finalMessage();
    } catch (err) {
      if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) { useFallbacks = false; turn--; continue; }
      throw err;
    }
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }
  if (message.stop_reason === 'refusal') {
    const why = message.stop_details && message.stop_details.explanation;
    throw new Error('The AI declined this request' + (why ? ': ' + why : '.'));
  }
  if (message.stop_reason === 'max_tokens') throw new Error('The AI response was cut off (too long). Try fewer photos per run.');
  const texts = message.content.filter((b) => b.type === 'text').map((b) => b.text);
  const candidates = [texts.join(''), ...texts.slice().reverse()];
  for (const t of candidates) {
    try { return { data: JSON.parse(t), usage: message.usage, model: message.model }; } catch (e) { /* try next */ }
  }
  const m = texts.join('').match(/\{[\s\S]*\}$/);
  if (m) { try { return { data: JSON.parse(m[0]), usage: message.usage, model: message.model }; } catch (e) { /* fall through */ } }
  throw new Error('The AI returned an unreadable response. Please try again.');
}

function clamp01(n) { n = Number(n); return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

function jobContext(job) {
  const v = job.vehicle || {};
  const c = job.circumstances || {};
  return [
    `Vehicle: ${[v.make, v.model, v.derivative].filter(Boolean).join(' ') || 'unknown'}; reg ${v.reg || '-'}; first registered ${v.firstReg || '-'}; mileage ${v.mileage || '-'}; colour ${v.colour || '-'}; body ${v.body || '-'}; fuel ${v.fuel || '-'}; transmission ${v.transmission || '-'}.`,
    `Reported circumstances: ${c.narrative || 'not provided'}`,
    `Reported impact type: ${c.impactType || '-'}; primary area: ${c.primaryArea || '-'}; secondary: ${c.secondaryArea || '-'}; direction: ${c.direction || '-'}.`,
    `Post-impact symptoms reported: ${c.symptoms || '-'}`,
    `Inspection notes: ${(job.inspection && job.inspection.condition) || '-'}; diagnostics: ${(job.inspection && job.inspection.diagnostic) || '-'}; warning lamps: ${(job.inspection && job.inspection.warningLamps) || '-'}.`
  ].join('\n');
}

/**
 * Analyse photos: labels with boxes, captions, damage summary and suggested estimate lines.
 * photos: [{index, mediaType, base64, title, caption}]
 */
async function analysePhotos({ job, photos, model, effort }) {
  if (!photos || !photos.length) throw new Error('No photos supplied.');
  const content = [];
  for (const p of photos) {
    content.push({ type: 'text', text: `Photo ${p.index}${p.title ? ' (assessor title: ' + p.title + ')' : ''}${p.caption ? ' (note: ' + p.caption + ')' : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/jpeg', data: p.base64 } });
  }
  content.push({
    type: 'text',
    text: `${jobContext(job)}

Task:
1. For every photo, label each visible damage area with a tight bounding box (fractions of image width/height, top-left origin), the catalogue component code, side, damage type, severity, whether it is accident-related, and the recommended operation. Write a report title and caption for each photo in the style "RH front door - surface damage" / "Horizontal scratches and paint transfer across the door outer panel."
2. Summarise the overall damage pattern, the likely impact type and direction, and whether it is consistent with the reported circumstances.
3. Recommend estimate lines covering parts to renew, panel repair (light/medium/heavy), refinish of new parts, refinish of repaired parts, blending of adjacent panels for colour match, remove & refit / strip & refit, mechanical investigation, diagnostics, geometry, wheel refurbishment, tyres, ADAS calibration and consumables where the evidence supports them. Word descriptions the way a UK estimate does, e.g. "RH front door – renew", "RH front door – refinish new part", "RH front wing – blend", "RH rear door – repair (medium) / metal finish". Use the guide hours unless the damage justifies different hours, and cite the photo numbers that support each line.`
  });
  const res = await callJSON({ model, effort, schema: PHOTO_SCHEMA, content });
  const d = res.data;
  // sanitise
  (d.photos || []).forEach((ph) => (ph.damages || []).forEach((dm) => {
    if (!CODES.has(dm.component_code)) dm.component_code = 'OTHER';
    dm.box = { x: clamp01(dm.box.x), y: clamp01(dm.box.y), w: clamp01(dm.box.w), h: clamp01(dm.box.h) };
    if (dm.box.x + dm.box.w > 1) dm.box.w = 1 - dm.box.x;
    if (dm.box.y + dm.box.h > 1) dm.box.h = 1 - dm.box.y;
  }));
  (d.suggested_lines || []).forEach((l) => {
    if (!CODES.has(l.code) && !/^OP\d{3}$/.test(l.code)) l.code = 'OTHER';
    l.labour_hours = Math.max(0, Math.round(Number(l.labour_hours || 0) * 10) / 10);
  });
  return { ...d, model: res.model, usage: res.usage };
}

/** Draft the narrative sections of the report from everything entered so far. */
async function draftNarrative({ job, totals, settings, model, effort }) {
  const lines = (job.lines || []).map((l) => `- [${l.type}] ${l.description} | part ${l.partNo || '-'} | ${l.hours || 0}h | £${l.amount || 0}`).join('\n');
  const findings = job.aiFindings ? JSON.stringify(job.aiFindings.summary || {}) : 'none';
  const photoNotes = (job.photos || []).map((p, i) => `Image ${i + 1}: ${p.title || ''} — ${p.caption || ''} [labels: ${(p.labels || []).map((l) => l.text).join(', ')}]`).join('\n');
  const content = [{
    type: 'text',
    text: `${jobContext(job)}

Damage zones: ${(job.zones || []).join(', ') || '-'}
AI photo findings summary: ${findings}
Photographs:
${photoNotes || '-'}

Current estimate lines:
${lines || '-'}

Totals: labour ${totals.labourHours}h £${totals.labour}; parts £${totals.parts}; paint £${totals.paint}; other £${totals.other}; net £${totals.net}; VAT £${totals.vat}; gross £${totals.gross}.
Valuation sources: ${(job.valuation.sources || []).map((s) => `${s.name} £${s.amount}`).join('; ')}. Adopted PAV £${totals.pav}. Provisional salvage £${totals.salvage}. Repair/PAV ${totals.pctNet}% net, ${totals.pctGross}% gross. The assessor's economic-repair threshold is ${settings.berThresholdPct}% (${settings.berBasis}).
Existing assessor text (keep their facts; improve the wording):
- Structural: ${job.assessment.structural || '-'}
- Mechanical: ${job.assessment.mechanical || '-'}
- Opinion: ${job.opinion || '-'}

Task: draft every narrative section of the engineering report in the formal, measured style of a UK independent engineer's report. Quote the exact totals and percentages above. State clearly what was not inspected (pre-strip, no dismantling) where that applies. Recommend a decision and salvage category only as far as the evidence supports, and list anything the assessor must check in review_flags.`
  }];
  const res = await callJSON({ model, effort, schema: NARRATIVE_SCHEMA, content });
  return { ...res.data, model: res.model, usage: res.usage };
}

async function testConnection({ model }) {
  const msg = await client().messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
  });
  return { ok: true, model: msg.model };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in Settings → AI.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to the selected model.';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found. Check the model name in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the AI service. Wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError) return 'The AI service rejected the request: ' + err.message;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `AI service error (${err.status}): ${err.message}`;
  if (err && /api key|apiKey|authentication/i.test(err.message || '')) return 'No AI key set. Add your Anthropic API key in Settings → AI.';
  return (err && err.message) || String(err);
}

module.exports = { analysePhotos, draftNarrative, valuationAssistant, VALUATION_SCHEMA, testConnection, setApiKey, describeError, SYSTEM, PHOTO_SCHEMA, NARRATIVE_SCHEMA };
