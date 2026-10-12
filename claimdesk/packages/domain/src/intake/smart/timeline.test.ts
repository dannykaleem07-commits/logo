import { describe, expect, it } from 'vitest';
import { proposeTimeline, timelineId, TIMELINE_EVENT_CLASS, type TimelineFile } from './timeline.js';

const file = (fileId: string, over: Partial<TimelineFile>): TimelineFile => ({ fileId, docType: null, documentDate: null, emailDate: null, from: null, subject: null, facts: {}, ...over });
const base = { aiItems: [], accidentAt: '2026-10-07T16:45:00.000Z', ticks: {}, minAutoTick: 0.8 };

describe('proposeTimeline', () => {
  it('letters, handling references, emails, police and engineer reports, estimates', () => {
    const t = proposeTimeline({
      ...base,
      files: [
        file('l1', { docType: 'insurer_letter', documentDate: '2026-10-09', facts: { insurerName: 'Example Mutual', insurerRef: 'TPI/778812' } }),
        file('l2', { docType: 'insurer_letter', documentDate: '2026-10-12', facts: { insurerName: 'Example Mutual', insurerRef: 'TPI/778812' } }),
        file('e1', { docType: 'correspondence', emailDate: '2026-10-10T09:00:00.000Z', from: 'claims@tp-insurer.example.test', subject: 'Acknowledgement' }),
        file('p1', { docType: 'police_report', documentDate: '2026-10-08', facts: { policeRef: 'INC-1' } }),
        file('r1', { docType: 'engineer_report', documentDate: '2026-10-14', facts: { inspectionDate: '2026-10-13' } }),
        file('s1', { docType: 'bodyshop_estimate', documentDate: '2026-10-11' }),
      ],
    });
    const types = t.map((p) => p.eventType);
    expect(types).toEqual(['note', 'letter_in', 'handling_ref_received', 'email_in', 'estimate_received', 'letter_in', 'inspection', 'note']);
    expect(t.filter((p) => p.eventType === 'handling_ref_received')).toHaveLength(1);
    expect(t.find((p) => p.eventType === 'email_in')!.summary).toBe('Email from claims@tp-insurer.example.test: Acknowledgement');
    expect(t.find((p) => p.eventType === 'handling_ref_received')!.class).toBe('clock');
    expect(t.every((p) => p.ticked)).toBe(true);
  });

  it('owner-only events (offers) are never ticked', () => {
    const t = proposeTimeline({ ...base, files: [file('o', { docType: 'insurer_letter', documentDate: '2026-10-20', facts: { offerFound: true, offerKind: 'pav' } })] });
    const offer = t.find((p) => p.eventType === 'pav_offer_received')!;
    expect(offer.class).toBe('owner_only');
    expect(offer.ticked).toBe(false);
    const ticked = proposeTimeline({ ...base, ticks: { [offer.id]: true }, files: [file('o', { docType: 'insurer_letter', documentDate: '2026-10-20', facts: { offerFound: true, offerKind: 'pav' } })] });
    expect(ticked.find((p) => p.id === offer.id)!.ticked).toBe(false);
  });

  it('documents dated before the accident are flagged and unticked', () => {
    const t = proposeTimeline({ ...base, files: [file('x', { docType: 'bodyshop_estimate', documentDate: '2026-09-01' })] });
    expect(t[0]!.ticked).toBe(false);
    expect(t[0]!.note).toMatch(/before the accident/);
  });

  it('AI items merge with the rules item on the same type, day and file', () => {
    const t = proposeTimeline({ ...base, files: [file('l1', { docType: 'insurer_letter', documentDate: '2026-10-09' })], aiItems: [{ at: '2026-10-09', eventType: 'letter_in', summary: 'Acknowledgement letter', fileId: 'l1', page: 1, quote: 'We acknowledge', confidence: 0.95 }, { at: '2026-10-15', eventType: 'not_a_type', summary: 'x', fileId: 'l1', page: 1, quote: null, confidence: 1 }] });
    expect(t).toHaveLength(1);
    expect(t[0]!.confidence).toBe(0.95);
  });

  it('owner ticks override defaults; ids are stable', () => {
    const files = [file('s1', { docType: 'bodyshop_estimate', documentDate: '2026-10-11' })];
    const id = timelineId('estimate_received', '2026-10-11', 's1');
    expect(id).toMatch(/^t:[0-9a-f]{12}$/);
    const t = proposeTimeline({ ...base, files, ticks: { [id]: false } });
    expect(t[0]).toMatchObject({ id, ticked: false, tickedBy: 'owner' });
  });

  it('the event-class table follows the spec', () => {
    expect(TIMELINE_EVENT_CLASS.letter_in).toBe('record');
    expect(TIMELINE_EVENT_CLASS.estimate_received).toBe('clock');
    expect(TIMELINE_EVENT_CLASS.settlement_offer_received).toBe('owner_only');
    expect(TIMELINE_EVENT_CLASS.hire_started).toBe('owner_only');
  });
});
