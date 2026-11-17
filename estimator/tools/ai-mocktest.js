#!/usr/bin/env node
/* Offline test of the AI pipeline: intercepts the HTTP call, checks the request shape, returns a canned streamed reply. */
'use strict';
const assert = require('assert');
let captured = null;
const reply = {
  photos: [{ index: 1, title: 'RH front door - surface damage', caption: 'Horizontal scoring across the door skin.', view: 'RH side',
    damages: [{ label: 'Scoring', component_code: 'DR001', component_name: 'Front door shell', side: 'R', damage_type: 'scoring', severity: 'moderate', accident_related: 'yes',
      box: { x: 0.9, y: 0.2, w: 0.3, h: 0.2 }, recommended_operation: 'repair', confidence: 0.8, notes: '' },
      { label: 'Made up', component_code: 'ZZZ999', component_name: 'x', side: '', damage_type: 'other', severity: 'minor', accident_related: 'unclear', box: { x: -1, y: 0.5, w: 0.1, h: 0.1 }, recommended_operation: 'none', confidence: 0.2, notes: '' }] }],
  summary: { impact_type: 'Sideswipe', primary_area: 'RH side', secondary_areas: '', direction_of_contact: 'Rear to front', damage_pattern: 'Longitudinal scoring', consistency_with_circumstances: 'Consistent',
    structural_concern: false, structural_notes: '', mechanical_checks: ['RH front hub'], adas_and_calibration: [], zones: ['RH front door'] },
  suggested_lines: [{ type: 'Body', code: 'OP001', side: 'R', description: 'RH front door – panel restoration', labour_hours: 1.83, needs_part: false, cost_class: 'labour only', reason: 'Photo 1', confidence: 0.8 }]
};
function sse(obj) {
  const text = JSON.stringify(obj);
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, data))}\n\n`;
  return ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } })
    + ev('message_stop', {});
}
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
  return new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const ai = require('../ai');
ai.setApiKey('sk-ant-test');
(async () => {
  const out = await ai.analysePhotos({ job: { vehicle: { make: 'Nissan', model: 'Juke' }, circumstances: {}, inspection: {} }, photos: [{ index: 1, mediaType: 'image/jpeg', base64: 'AAAA', title: '' }] });
  const b = captured.body;
  assert.match(captured.url, /\/v1\/messages/);
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.strictEqual(b.stream, true);
  assert.strictEqual(b.output_config.format.type, 'json_schema');
  assert.strictEqual(b.output_config.effort, 'high');
  assert.strictEqual(b.fallbacks, 'default');
  assert.ok(!('thinking' in b) || b.thinking.type === 'adaptive');
  assert.strictEqual(b.system[0].cache_control.type, 'ephemeral');
  assert.strictEqual(b.messages[0].content[1].type, 'image');
  const hdr = new Headers(captured.headers).get('anthropic-beta') || '';
  assert.match(hdr, /server-side-fallback-2026-07-01/);
  console.log('✓ request: model, streaming, JSON schema output, effort, cached system prompt, image block, fallback beta header');
  const d = out.photos[0].damages;
  assert.strictEqual(d[1].component_code, 'OTHER', 'unknown code sanitised');
  assert.strictEqual(d[1].box.x, 0, 'negative x clamped');
  assert.ok(Math.abs(d[0].box.x + d[0].box.w - 1) < 1e-9, 'box clipped to image');
  assert.strictEqual(out.suggested_lines[0].labour_hours, 1.8);
  console.log('✓ response: parsed, unknown codes → OTHER, boxes clamped to the image, hours rounded');
  await ai.draftNarrative({ job: { vehicle: {}, circumstances: {}, inspection: {}, assessment: {}, valuation: { sources: [] }, lines: [], photos: [] }, totals: { labourHours: 0, labour: 0, parts: 0, paint: 0, other: 0, net: 0, vat: 0, gross: 0, pav: 0, salvage: 0, pctNet: 0, pctGross: 0 }, settings: { berThresholdPct: 60, berBasis: 'net' } }).catch(() => {});
  assert.ok(captured.body.output_config.format.schema.properties.opinion, 'narrative schema sent');
  console.log('✓ narrative request uses the narrative schema');
  console.log('AI mock test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
