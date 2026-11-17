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
- Salvage categories follow the ABI Code of Practice: Category S = structural frame or chassis damaged (repairable); Category N = no structural damage (repairable). Categories A/B are for vehicles that must be broken or crushed. Recommend a category only when the evidence supports it.

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
          recommended_operation: { type: 'string', enum: ['replace', 'repair', 'refinish', 'remove & refit', 'refurbish', 'inspect / test', 'none'] },
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

// ---------- client ----------
let apiKey = null;
function setApiKey(k) { apiKey = k || null; }
function client() {
  // With no key set here, the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

async function callJSON({ model, effort, schema, content }) {
  const params = {
    model: model || DEFAULT_MODEL,
    max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: effort || 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }]
  };
  let message;
  try {
    // Server-side fallback re-runs a declined request on Anthropic's recommended model.
    message = await client().beta.messages
      .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      .finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
      message = await client().messages.stream(params).finalMessage();
    } else {
      throw err;
    }
  }
  if (message.stop_reason === 'refusal') {
    const why = message.stop_details && message.stop_details.explanation;
    throw new Error('The AI declined this request' + (why ? ': ' + why : '.'));
  }
  if (message.stop_reason === 'max_tokens') throw new Error('The AI response was cut off (too long). Try fewer photos per run.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { data: JSON.parse(text), usage: message.usage, model: message.model };
  } catch (e) {
    throw new Error('The AI returned an unreadable response. Please try again.');
  }
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
3. Recommend estimate lines covering parts to replace, panel repair / metal finishing, refinishing, strip & refit, mechanical investigation, diagnostics, geometry, wheel refurbishment, tyres, ADAS calibration and consumables where the evidence supports them. Use the guide hours unless the damage justifies different hours, and cite the photo numbers that support each line.`
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

module.exports = { analysePhotos, draftNarrative, testConnection, setApiKey, describeError, SYSTEM, PHOTO_SCHEMA, NARRATIVE_SCHEMA };
