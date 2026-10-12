// owned by claimai-server
import { describe, expect, it } from 'vitest';
import { CORRESPONDENCE_KINDS, CORRESPONDENCE_KIND_LABEL, kindResultFor, recogniseCorrespondence, type RecogniseInput } from './outbound.js';

const TITLES = [
  { templateId: 'letter.ncaf', title: 'New Claim Advice Form' },
  { templateId: 'letter.handling_ref_request', title: 'Request for handling office and claim reference' },
  { templateId: 'letter.intervention_reply', title: 'Reply to your offer of a replacement vehicle' },
  { templateId: 'letter.collect_or_pay', title: 'Notice: collect the vehicle or storage continues at your cost' },
];
const out = (text: string, x: Partial<RecogniseInput> = {}) => recogniseCorrespondence({ direction: 'out', docType: 'correspondence', text, subject: null, isEmail: false, templateTitles: TITLES, hasPaymentPack: false, insurerRefNew: false, ...x });
const inn = (text: string, x: Partial<RecogniseInput> = {}) => out(text, { direction: 'in', ...x });

describe('recogniseCorrespondence (§3.7)', () => {
  it('every outbound row by phrase', () => {
    const cases: Array<[string, string, string]> = [
      ['We notify you of a claim by our client', 'ncaf', 'ncaf_sent'],
      ['Please provide details of your handling office and your claim reference', 'handling_ref_request', 'letter_out'],
      ['The hire has commenced today', 'hire_start_notice', 'hire_start_notice_sent'],
      ['We are still awaiting your response', 'chaser', 'letter_out'],
      ['Please preserve the footage from your CCTV', 'cctv_request', 'cctv_request_sent'],
      ['Please find the payment pack', 'payment_pack', 'payment_pack_sent'],
      ['You must collect the vehicle or storage charges will continue', 'collect_or_pay', 'collect_or_pay_notice_sent'],
      ['Thank you for your offer of a replacement vehicle', 'intervention_reply', 'intervention_reply_sent'],
      ['This is a formal complaint under DISP 1', 'complaint', 'complaint_sent'],
      ['We instruct you to inspect the vehicle', 'engineer_instruction', 'engineer_instructed'],
      ['Dear Mrs Doe, please send your bank statements', 'doc_request', 'letter_out'],
      ['Dear Mrs Doe, an update on your claim', 'client_update', 'letter_out'],
      ['This is a letter before claim under the pre-action protocol', 'letter_before_claim', 'letter_before_claim_sent'],
      ['We make this offer under Part 36', 'part36', 'part36_sent'],
      ['Our response to your notice under section 172', 's172_response', 's172_response_sent'],
    ];
    for (const [text, kind, ev] of cases) expect(out(text), text).toMatchObject({ kind, eventType: ev });
    expect(out('We enclose the documents you asked for')).toMatchObject({ kind: 'other_out', eventType: 'letter_out', cls: 'record' });
    expect(out('Dear Sirs, please send your bank statements').kind).not.toBe('doc_request'); // only to the client
    expect(out('hello', { isEmail: true }).eventType).toBe('email_out');
  });
  it('template titles score 5 (first 20 lines or the subject)', () => {
    expect(out('Courtesy Cars\nNew Claim Advice Form\nClaimant: Jane Doe')).toMatchObject({ kind: 'ncaf', templateId: 'letter.ncaf', confidence: 0.95, cls: 'clock' });
    expect(out('hello', { subject: 'Request for handling office and claim reference — CCG-2026-00001', isEmail: true })).toMatchObject({ kind: 'handling_ref_request', emailKind: 'handling_ref_request', eventType: 'email_out', confidence: 0.95 });
  });
  it('the subject outweighs a mention of an earlier letter in the body', () => {
    const body = 'Dear Sirs,\nWe sent you our New Claim Advice Form on 2 October. Please confirm your handling office and claim reference.';
    expect(out(body, { subject: 'Request for handling office and claim reference — CCG-2026-00001', isEmail: true })).toMatchObject({ kind: 'handling_ref_request', eventType: 'email_out' });
    expect(out(body).kind).toBe('ncaf'); // no subject: the title in the first lines decides
  });
  it('a chaser is chaser_sent (clock) only once the payment pack went', () => {
    expect(out('final reminder', { hasPaymentPack: true })).toMatchObject({ kind: 'chaser', eventType: 'chaser_sent', cls: 'clock' });
    expect(out('final reminder')).toMatchObject({ kind: 'chaser', eventType: 'letter_out', cls: 'record' });
  });
  it('inbound: first insurer letter with a new reference → also handling_ref_received; offers / remittances / final responses are owner-only', () => {
    expect(inn('Example Mutual Insurance\nClaims Department\nWe acknowledge your letter', { docType: 'insurer_letter', insurerRefNew: true })).toMatchObject({ kind: 'acknowledgement', eventType: 'letter_in', alsoEvent: 'handling_ref_received', cls: 'clock' });
    expect(inn('Example Mutual Insurance\nWe acknowledge your letter', { docType: 'insurer_letter' })).toMatchObject({ kind: 'insurer_letter', eventType: 'letter_in', cls: 'record' });
    expect(inn('We are prepared to offer £1,000 in full and final settlement')).toMatchObject({ kind: 'offer', cls: 'owner_only' });
    expect(inn('Please find our remittance advice')).toMatchObject({ kind: 'remittance', cls: 'owner_only' });
    expect(inn('This is our final response')).toMatchObject({ kind: 'final_response', cls: 'owner_only' });
    expect(inn('the car is still at the garage', { isEmail: true, docType: null })).toMatchObject({ kind: 'client_message', eventType: 'email_in' });
    expect(inn('A note', { docType: null })).toMatchObject({ kind: 'other_in', eventType: 'letter_in' });
  });
  it('labels for every kind; owner-picked kinds', () => {
    for (const k of CORRESPONDENCE_KINDS) expect(CORRESPONDENCE_KIND_LABEL[k]).toBeTruthy();
    expect(kindResultFor('ncaf', 'out', false, false)).toMatchObject({ eventType: 'ncaf_sent', confidence: 1 });
    expect(kindResultFor('other_out', 'out', true, false)).toMatchObject({ eventType: 'email_out' });
    expect(kindResultFor('offer', 'in', false, false).cls).toBe('owner_only');
  });
});
