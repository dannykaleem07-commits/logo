// owned by claimai-server
/** The catch-up plan (docs/CLAIM-AI-INPUT.md §3.8). Synthetic files (invented names, example.test addresses). */
import { describe, expect, it } from 'vitest';
import { BANNED_INTAKE_WORDS } from '../intake/smart/types.js';
import { planCatchUp, recordAt, type CatchUpClaimFacts, type CatchUpFileInput } from './catchUp.js';
import type { Identity, PartyHints } from './direction.js';

const NOW = '2026-10-12T09:00:00.000Z';
const ID: Identity = { companyNames: ['Courtesy Cars Group UK Ltd'], ourEmails: ['claims@ccguk.example.test'], ourDomains: ['ccguk.example.test'], ourPostcodes: ['RG1 1ZZ'], ourPhones: [], ourRefPattern: /CCG-\d{4}-\d{5}/ };
const P: PartyHints = { client: { names: ['Jane Doe'], emails: ['jane.doe@example.test'] }, insurer: { names: ['Example Mutual Insurance'], emails: [], domains: ['example-mutual.example.test'] }, others: [] };
const TITLES = [{ templateId: 'letter.ncaf', title: 'New Claim Advice Form' }];
const claim: CatchUpClaimFacts = {
  claimId: 'c1', reference: 'CCG-2026-00001', accidentAt: '2026-10-01T13:00:00.000Z', openedAt: NOW,
  evidence: [{ id: 'ev-v5c', sha256: 'sha-v5c', textSha256: 'tsha-v5c', kind: 'v5c', filename: 'V5C.pdf' }],
  events: [], outboxSent: [], sentDocuments: [], correspondence: [], hasPaymentPack: false,
};

let pos = 0;
function file(x: Partial<CatchUpFileInput>): CatchUpFileInput {
  pos += 1;
  return {
    fileId: `f-${pos}`, itemId: `i-${pos}`, evidenceId: `e-${pos}`, filename: `file${pos}.pdf`, mime: 'application/pdf', role: 'document', isPhoto: false, docType: 'correspondence', docTypeConfidence: 0.9,
    groupKey: 'main', excluded: false, duplicateOf: null, sha256: `sha-${pos}`, textSha256: null, documentDate: null, emailDate: null, pdfCreatedAt: null, subject: null, head: '', tail: '', text: '',
    email: null, formTemplateId: null, signed: null, insurerRefNew: false, override: null, position: pos, ...x,
  };
}
const NCAF_HEAD = 'Courtesy Cars Group UK Ltd\n1 Depot Road, Reading RG1 1ZZ\n\nExample Mutual Insurance\nLeeds\n2 October 2026\nOur ref: CCG-2026-00001\nDear Sirs\nNew Claim Advice Form';
const NCAF_TAIL = 'Yours faithfully\nClaims Team\nCourtesy Cars Group UK Ltd';
const plan = (files: CatchUpFileInput[], c: Partial<CatchUpClaimFacts> = {}, timeline: Parameters<typeof planCatchUp>[5]['timeline'] = []) =>
  planCatchUp(files, { ...claim, ...c }, ID, P, TITLES, { now: NOW, autoMinConfidence: 0.8, timeline });

describe('planCatchUp (§3.8)', () => {
  it('our NCAF (letter) → file + record, sent 2 Oct (document date), apply; never the upload date', () => {
    const f = file({ filename: 'NCAF.pdf', head: NCAF_HEAD, tail: NCAF_TAIL, text: `${NCAF_HEAD}\nWe notify you of a claim.\n${NCAF_TAIL}` });
    const r = plan([f]);
    expect(r.files[0]).toMatchObject({ plan: 'file_and_record', realDate: { at: '2026-10-02', source: 'document' }, kind: { kind: 'ncaf', eventType: 'ncaf_sent' }, alreadyRecorded: null, dateFlag: null });
    const rec = r.actions.find((a) => a.type === 'record_correspondence')!;
    expect(rec).toMatchObject({ tier: 'apply', ticked: true, params: { direction: 'out', kind: 'ncaf', eventType: 'ncaf_sent', templateId: 'letter.ncaf', at: '2026-10-02T11:00:00.000Z', dateSource: 'document', counterpartyRole: 'at_fault_insurer', channel: 'post' } });
    expect(rec.params.summary).toBe('New Claim Advice Form sent to Example Mutual Insurance on Fri 2 Oct 2026 — recorded late, source: NCAF.pdf');
    expect(r.actions.find((a) => a.type === 'file_evidence')).toMatchObject({ key: `f${f.position}`, tier: 'apply', undoable: false });
    expect(r.willDo).toEqual([
      'File 1 document on CCG-2026-00001',
      'Record 1 letter we sent outside ClaimDesk: New Claim Advice Form (2 Oct)',
      "Back-date 1 chronology entry (marked 'recorded late')",
      'Ask the Autopilot and the case manager to re-plan',
    ]);
  });

  it('real date priority: owner > email header > document date > head line > PDF metadata; none → confirm line asking for it', () => {
    const base = { head: NCAF_HEAD.replace('2 October 2026', ''), tail: NCAF_TAIL, text: 'New Claim Advice Form' };
    expect(plan([file({ ...base, override: { date: '2026-10-03' }, documentDate: '2026-10-02' })]).files[0]!.realDate).toMatchObject({ at: '2026-10-03', source: 'owner' });
    expect(plan([file({ ...base, emailDate: 'Fri, 09 Oct 2026 11:05:00 +0100', documentDate: '2026-10-02' })]).files[0]!.realDate).toMatchObject({ at: '2026-10-09T10:05:00.000Z', source: 'email_header' });
    expect(plan([file({ ...base, documentDate: '2026-10-04', pdfCreatedAt: '2026-10-05T10:00:00Z' })]).files[0]!.realDate).toMatchObject({ at: '2026-10-04', source: 'document' });
    expect(plan([file({ ...base, head: `${base.head}\n5/10/2026`, pdfCreatedAt: '2026-10-07T10:00:00Z' })]).files[0]!.realDate).toMatchObject({ at: '2026-10-05', source: 'document' });
    expect(plan([file({ ...base, pdfCreatedAt: '2026-10-07T10:00:00Z' })]).files[0]!.realDate).toMatchObject({ source: 'file_metadata' });
    const none = plan([file(base)]);
    expect(none.files[0]!.realDate).toMatchObject({ at: null, source: null });
    expect(none.actions.find((a) => a.type === 'record_correspondence')).toMatchObject({ tier: 'confirm', ticked: false, why: 'No date found — set the date, then tick' });
  });

  it('a flagged date (future, or long before the accident) → confirm; an owner override → confirm', () => {
    const fut = plan([file({ head: NCAF_HEAD, tail: NCAF_TAIL, text: 'New Claim Advice Form', documentDate: '2026-11-20' })]);
    expect(fut.files[0]!.dateFlag).toMatch(/future/);
    expect(fut.actions.find((a) => a.type === 'record_correspondence')!.tier).toBe('confirm');
    expect(fut.blockers.some((b) => b.code === 'CHECK_DATE')).toBe(true);
    expect(plan([file({ head: NCAF_HEAD, tail: NCAF_TAIL, text: 'x', documentDate: '2026-07-01' })]).files[0]!.dateFlag).toMatch(/30 days before/);
    // a document for the file (V5C, MOT) carries old dates by nature: no flag, no blocker
    const v5c = plan([file({ docType: 'v5c', documentDate: '2021-03-15' })]);
    expect(v5c.files[0]!.dateFlag).toBeNull();
    expect(v5c.blockers.some((b) => b.code === 'CHECK_DATE')).toBe(false);
  });

  it('already on file: same bytes or same text → not filed twice; its record may still be made', () => {
    const r = plan([file({ docType: 'v5c', sha256: 'sha-v5c' }), file({ docType: 'v5c', textSha256: 'tsha-v5c' })]);
    expect(r.files.map((f) => [f.plan, f.alreadyOnFile?.how])).toEqual([['already_on_file', 'same_file'], ['already_on_file', 'same_text']]);
    expect(r.actions.filter((a) => a.type === 'file_evidence')).toEqual([]);
    expect(r.willDo[0]).toBe('2 already on file — not filed twice');
  });

  it('already recorded: an event ±1 day, an outbox row ±2 days, a sent document ±2 days, a record on the same day', () => {
    const f = () => file({ head: NCAF_HEAD, tail: NCAF_TAIL, text: 'New Claim Advice Form' });
    expect(plan([f()], { events: [{ id: 'ev1', type: 'ncaf_sent', at: '2026-10-02T15:00:00.000Z' }] }).files[0]!.alreadyRecorded).toMatchObject({ how: 'event', ref: 'ev1' });
    expect(plan([f()], { sentDocuments: [{ id: 'd1', templateId: 'letter.ncaf', sentAt: '2026-10-03T10:00:00.000Z' }] }).files[0]!.alreadyRecorded).toMatchObject({ how: 'document' });
    expect(plan([f()], { correspondence: [{ id: 'k1', direction: 'out', kind: 'ncaf', at: '2026-10-02T08:00:00.000Z', evidenceId: null }] }).files[0]!.alreadyRecorded).toMatchObject({ how: 'correspondence' });
    const eml = file({ role: 'email', filename: 'req.eml', mime: 'message/rfc822', email: { from: 'claims@ccguk.example.test', to: ['claims@example-mutual.example.test'], cc: [] }, emailDate: '2026-10-09T10:05:00Z', subject: 'Request for handling office and claim reference', text: 'Please confirm your claim reference and handling office' });
    expect(plan([eml], { outboxSent: [{ id: 'o1', kind: 'handling_ref_request', sentAt: '2026-10-10T10:00:00.000Z' }] }).files[0]!.alreadyRecorded).toMatchObject({ how: 'outbox', ref: 'o1' });
    const r = plan([f()], { events: [{ id: 'ev1', type: 'ncaf_sent', at: '2026-10-05T15:00:00.000Z' }] });
    expect(r.files[0]!.alreadyRecorded).toBeNull();
    // already recorded → no record line
    expect(plan([f()], { events: [{ id: 'ev1', type: 'ncaf_sent', at: '2026-10-02T15:00:00.000Z' }] }).actions.filter((a) => a.type === 'record_correspondence')).toEqual([]);
  });

  it('emails in and out by header; photos and documents just filed; unknown → "Who sent it?" (not tickable until you pick)', () => {
    const r = plan([
      file({ role: 'email', filename: 'client.eml', mime: 'message/rfc822', docType: null, email: { from: 'jane.doe@example.test', to: ['claims@ccguk.example.test'], cc: [] }, emailDate: 'Thu, 08 Oct 2026 09:00:00 +0100', text: 'the car is still at the garage' }),
      file({ filename: 'photo.png', mime: 'image/png', isPhoto: true, docType: 'damage_photo', evidenceKind: 'photo' }),
      file({ filename: 'plain.pdf', head: 'To whom it may concern\n5 October 2026', tail: 'Thanks', text: 'The car was returned.' }),
    ]);
    expect(r.files.map((f) => f.plan)).toEqual(['file_and_record', 'file_only', 'ask']);
    expect(r.actions.find((a) => a.key === 'r1' || (a.type === 'record_correspondence' && a.params.direction === 'in'))).toMatchObject({ tier: 'apply', params: { eventType: 'email_in', kind: 'client_message', dateSource: 'email_header', at: '2026-10-08T08:00:00.000Z', counterpartyName: 'Jane Doe' } });
    const who = r.actions.find((a) => a.title.startsWith('Who sent'))!;
    expect(who).toMatchObject({ tier: 'confirm', ticked: false, tickable: false });
    expect(who.title).toBe("Who sent 'plain.pdf'? — Sent by us / Received / Just file it");
    expect(r.blockers.find((b) => b.code === 'WHO_SENT')).toMatchObject({ text: "Who sent 'plain.pdf'?" });
    expect(r.willDo).toContain('File 2 documents and 1 photo on CCG-2026-00001');
    expect(r.willDo).toContain('Ask you who sent 1 file');
    // the owner picks "Sent by us" and a date → a record line that needs a tick
    const picked = plan([file({ filename: 'plain2.pdf', head: 'To whom it may concern', tail: 'Thanks', text: 'The car was returned.', override: { direction: 'out', date: '2026-10-05' } })]);
    expect(picked.files[0]).toMatchObject({ plan: 'file_and_record', realDate: { source: 'owner' } });
    expect(picked.actions.find((a) => a.type === 'record_correspondence')).toMatchObject({ tier: 'confirm', tickable: true, params: { direction: 'out', kind: 'other_out', eventType: 'letter_out', dateSource: 'owner' } });
  });

  it('another claim → not filed here; unsure → a confirm filing line; excluded / not this claim → nothing', () => {
    const r = plan([
      file({ groupKey: 'claim:c2', otherClaimRef: 'CCG-2026-00002', filename: 'other.pdf' }),
      file({ groupKey: 'unsure', filename: 'stranger.pdf' }),
      file({ excluded: true }),
      file({ override: { notThisClaim: true } }),
    ]);
    expect(r.files.map((f) => f.plan)).toEqual(['other_claim', 'ask', 'excluded', 'excluded']);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: 'file_evidence', tier: 'confirm', ticked: false });
    expect(r.blockers[0]).toMatchObject({ code: 'OTHER_CLAIM', text: "'other.pdf' looks like CCG-2026-00002 — open its AI input to file it there" });
  });

  it('inbound offers → open the screen; our letter before claim → confirm', () => {
    const r = plan([
      file({ head: 'Example Mutual Insurance\nLeeds\n\nDear Courtesy Cars\nYour ref: CCG-2026-00001', tail: 'Yours faithfully\nExample Mutual Insurance', text: 'We are prepared to offer £1,000 in full and final settlement', documentDate: '2026-10-07' }),
      file({ head: NCAF_HEAD.replace('New Claim Advice Form', 'Letter before claim'), tail: NCAF_TAIL, text: 'Letter before claim', documentDate: '2026-10-07' }),
    ]);
    const recs = r.actions.filter((a) => a.type === 'record_correspondence');
    expect(recs.map((a) => a.tier)).toEqual(['open_screen', 'confirm']);
  });

  it('extra events from the documents, back-dated and marked recorded late; duplicates of live events skipped', () => {
    const est = file({ docType: 'bodyshop_estimate', filename: 'estimate.pdf' });
    const r = plan([est], {}, [
      { id: 't1', at: '2026-10-05', precision: 'date', eventType: 'estimate_received', summary: 'Estimate received from the garage', fileId: est.fileId, confidence: 0.9, ticked: true },
      { id: 't2', at: '2026-10-05', precision: 'date', eventType: 'letter_in', summary: 'Letter', fileId: est.fileId, confidence: 0.9, ticked: true },
      { id: 't3', at: '2026-10-06', precision: 'date', eventType: 'inspection', summary: 'x', fileId: est.fileId, confidence: 0.9, ticked: false },
    ]);
    const ev = r.actions.filter((a) => a.type === 'event');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ key: `e${est.position}-1`, tier: 'apply', params: { eventType: 'estimate_received', at: '2026-10-05T11:00:00.000Z' } });
    expect(ev[0]!.params.summary).toMatch(/recorded late, source: estimate.pdf/);
    const dup = plan([est], { events: [{ id: 'x', type: 'estimate_received', at: '2026-10-05T09:00:00.000Z' }] }, [{ id: 't1', at: '2026-10-05', precision: 'date', eventType: 'estimate_received', summary: 'E', fileId: est.fileId, confidence: 0.9, ticked: true }]);
    expect(dup.actions.filter((a) => a.type === 'event')).toEqual([]);
  });

  it('keys are stable by bundle position; no banned words in any string; recordAt never after now', () => {
    const r = plan([file({ head: NCAF_HEAD, tail: NCAF_TAIL, text: 'New Claim Advice Form', position: 42 })]);
    expect(r.actions.map((a) => a.key).sort()).toEqual(['f42', 'r42']);
    expect(BANNED_INTAKE_WORDS.test(JSON.stringify(r))).toBe(false);
    expect(recordAt('2026-10-12', NOW)).toBe(NOW);
    expect(recordAt('2026-10-02', NOW)).toBe('2026-10-02T11:00:00.000Z');
  });
});
