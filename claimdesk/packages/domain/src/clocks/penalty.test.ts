import { describe, it, expect } from 'vitest';
import type { PenaltyNotice } from '../types.js';
import { derivePenaltyClocks } from './penalty.js';

const notice = (overrides: Partial<PenaltyNotice> = {}): PenaltyNotice => ({
  id: 'pen_1',
  fleetUnitId: 'fleet_golf',
  kind: 'pcn_council',
  issuer: 'London Borough of Barnet',
  noticeNumber: 'BA12345678',
  contraventionAt: '2026-07-01T08:00:00+01:00',
  receivedAt: '2026-07-06T10:00:00+01:00',
  amountPence: 13000,
  responseDeadline: '2026-08-02',
  stage: 'received',
  documentIds: [],
  ...overrides,
});

describe('derivePenaltyClocks — NIP and s.172', () => {
  const nip = notice({ kind: 'nip_s172', issuer: 'Metropolitan Police', receivedAt: '2026-07-10T10:00:00+01:00', responseDeadline: '2026-08-06' });
  it('NIP must be served within 14 days of the offence: offence 1 Jul → last day 15 Jul', () => {
    const clocks = derivePenaltyClocks(nip, '2026-07-20T12:00:00+01:00');
    const c = clocks.find((x) => x.kind === 'nip_14_days')!;
    expect(c).toMatchObject({ startsAt: '2026-07-01T08:00:00+01:00', dueAt: '2026-07-15T23:59:59+01:00', status: 'met', metAt: '2026-07-10T10:00:00+01:00', attributableTo: 'other', sourceEventId: 'pen_1' });
    expect(c.basis).toMatch(/s\.1 RTOA 1988/);
    expect(c.id).toBe('pen:pen_1:nip_14_days');
    expect(c.claimId).toBe('penalty:pen_1');
  });
  it('a NIP received on day 15 or later is out of time (breached by the issuer)', () => {
    const late = derivePenaltyClocks(notice({ kind: 'nip_s172', receivedAt: '2026-07-16T09:00:00+01:00', responseDeadline: '2026-08-12' }), '2026-07-20T12:00:00+01:00');
    expect(late.find((x) => x.kind === 'nip_14_days')).toMatchObject({ status: 'breached', metAt: '2026-07-16T09:00:00+01:00' });
  });
  it('s.172: 28 days beginning with the day of service (10 Jul → 6 Aug), using the printed deadline when given', () => {
    const c = derivePenaltyClocks(nip, '2026-07-20T12:00:00+01:00').find((x) => x.kind === 's172_28_days')!;
    expect(c).toMatchObject({ startsAt: '2026-07-10T10:00:00+01:00', dueAt: '2026-08-06T23:59:59+01:00', status: 'running', attributableTo: 'ccguk' });
    expect(c.basis).toMatch(/s\.172\(7\)/);
    const computed = derivePenaltyClocks({ ...nip, responseDeadline: '' }, '2026-07-20T12:00:00+01:00').find((x) => x.kind === 's172_28_days')!;
    expect(computed.dueAt).toBe('2026-08-06T23:59:59+01:00'); // 10 Jul + 27 days
    const printed = derivePenaltyClocks({ ...nip, responseDeadline: '2026-08-05' }, '2026-07-20T12:00:00+01:00').find((x) => x.kind === 's172_28_days')!;
    expect(printed.dueAt).toBe('2026-08-05T23:59:59+01:00');
  });
  it('s.172: met by the response date, met by stage without a date, breached when nothing is sent in time', () => {
    expect(derivePenaltyClocks(nip, '2026-08-10T12:00:00+01:00', { respondedAt: '2026-07-20T10:00:00+01:00' }).find((x) => x.kind === 's172_28_days')).toMatchObject({ status: 'met', metAt: '2026-07-20T10:00:00+01:00' });
    const byStage = derivePenaltyClocks({ ...nip, stage: 'liability_transferred' }, '2026-08-10T12:00:00+01:00').find((x) => x.kind === 's172_28_days')!;
    expect(byStage.status).toBe('met');
    expect(byStage.metAt).toBeUndefined();
    expect(derivePenaltyClocks(nip, '2026-08-10T12:00:00+01:00').find((x) => x.kind === 's172_28_days')?.status).toBe('breached');
    expect(derivePenaltyClocks(nip, '2026-08-10T12:00:00+01:00', { respondedAt: '2026-08-08T10:00:00+01:00' }).find((x) => x.kind === 's172_28_days')).toMatchObject({ status: 'breached', metAt: '2026-08-08T10:00:00+01:00' });
  });
  it('ADVERSARIAL: the 14 days run from the London date of the offence, not the UTC date (23:30Z in July is 00:30 BST next day)', () => {
    // Offence 2026-07-01T23:30:00Z = 00:30 BST on 2 July → last day for service is 16 July, so a NIP received 16 Jul is in time.
    const lateNight = notice({ kind: 'nip_s172', contraventionAt: '2026-07-01T23:30:00Z', receivedAt: '2026-07-16T09:00:00+01:00', responseDeadline: '2026-08-12' });
    const c = derivePenaltyClocks(lateNight, '2026-07-20T12:00:00+01:00').find((x) => x.kind === 'nip_14_days')!;
    expect(c).toMatchObject({ startsAt: '2026-07-02T00:30:00+01:00', dueAt: '2026-07-16T23:59:59+01:00', status: 'met' });
  });
  it('emits exactly the two clocks and honours a claimId override', () => {
    const clocks = derivePenaltyClocks(nip, '2026-07-20T12:00:00+01:00', { claimId: 'claim_x' });
    expect(clocks.map((c) => c.kind)).toEqual(['nip_14_days', 's172_28_days']);
    expect(clocks.every((c) => c.claimId === 'claim_x')).toBe(true);
  });
});

describe('derivePenaltyClocks — council PCN', () => {
  it('discount 14 days and representations 28 days "beginning with" service: 6 Jul → 19 Jul and 2 Aug', () => {
    const clocks = derivePenaltyClocks(notice({ responseDeadline: '' }), '2026-07-08T12:00:00+01:00');
    expect(clocks.map((c) => c.kind)).toEqual(['pcn_discount_14_days', 'pcn_representations_28_days']);
    expect(clocks[0]).toMatchObject({ startsAt: '2026-07-06T10:00:00+01:00', dueAt: '2026-07-19T23:59:59+01:00', status: 'running' });
    expect(clocks[1]).toMatchObject({ dueAt: '2026-08-02T23:59:59+01:00', status: 'running' });
  });
  it('the dates printed on the notice govern when present', () => {
    const clocks = derivePenaltyClocks(notice({ discountDeadline: '2026-07-20', responseDeadline: '2026-08-03' }), '2026-07-08T12:00:00+01:00');
    expect(clocks[0]?.dueAt).toBe('2026-07-20T23:59:59+01:00');
    expect(clocks[1]?.dueAt).toBe('2026-08-03T23:59:59+01:00');
  });
  it('payment within the discount period meets the discount clock and stops representations', () => {
    const clocks = derivePenaltyClocks(notice(), '2026-08-10T12:00:00+01:00', { paidAt: '2026-07-10T10:00:00+01:00' });
    expect(clocks[0]).toMatchObject({ status: 'met', metAt: '2026-07-10T10:00:00+01:00' });
    expect(clocks[1]).toMatchObject({ status: 'stopped', stoppedAt: '2026-07-10T10:00:00+01:00', stoppedReason: 'penalty paid' });
  });
  it('representations (or the hirer liability transfer) meet the representations clock and suspend the discount', () => {
    const clocks = derivePenaltyClocks(notice(), '2026-08-10T12:00:00+01:00', { representationsSentAt: '2026-07-15T10:00:00+01:00' });
    expect(clocks[0]).toMatchObject({ status: 'stopped', stoppedAt: '2026-07-15T10:00:00+01:00' });
    expect(clocks[0]?.stoppedReason).toMatch(/discount suspended/);
    expect(clocks[1]).toMatchObject({ status: 'met', metAt: '2026-07-15T10:00:00+01:00' });
    expect(derivePenaltyClocks(notice({ stage: 'liability_transferred' }), '2026-08-10T12:00:00+01:00')[1]?.status).toBe('met');
  });
  it('missed deadlines breach; a cancelled notice stops everything', () => {
    const missed = derivePenaltyClocks(notice(), '2026-08-10T12:00:00+01:00');
    expect(missed.map((c) => c.status)).toEqual(['breached', 'breached']);
    const cancelled = derivePenaltyClocks(notice({ stage: 'cancelled' }), '2026-08-10T12:00:00+01:00');
    expect(cancelled.map((c) => c.status)).toEqual(['stopped', 'stopped']);
    expect(cancelled[0]?.stoppedReason).toBe('notice cancelled');
  });
  it('the appeal clock appears once a notice of rejection is recorded: 28 days beginning with receipt', () => {
    const clocks = derivePenaltyClocks(notice(), '2026-08-10T12:00:00+01:00', { representationsSentAt: '2026-07-15T10:00:00+01:00', rejectionReceivedAt: '2026-08-01T10:00:00+01:00' });
    const appeal = clocks.find((c) => c.kind === 'pcn_appeal_28_days')!;
    expect(appeal).toMatchObject({ startsAt: '2026-08-01T10:00:00+01:00', dueAt: '2026-08-28T23:59:59+01:00', status: 'running' });
    expect(appeal.basis).toMatch(/London Tribunals \/ the Traffic Penalty Tribunal/);
    const lodged = derivePenaltyClocks(notice({ stage: 'appeal' }), '2026-09-10T12:00:00+01:00', { rejectionReceivedAt: '2026-08-01T10:00:00+01:00', appealLodgedAt: '2026-08-20T10:00:00+01:00' });
    expect(lodged.find((c) => c.kind === 'pcn_appeal_28_days')).toMatchObject({ status: 'met', metAt: '2026-08-20T10:00:00+01:00' });
  });
});

describe('derivePenaltyClocks — private parking, TfL charges, FPN', () => {
  it('private parking charges use the operator / POPLA–IAS bases (contract, not statute)', () => {
    const clocks = derivePenaltyClocks(notice({ kind: 'pcn_private', issuer: 'ParkingEye' }), '2026-07-08T12:00:00+01:00', { rejectionReceivedAt: '2026-08-01T10:00:00+01:00' });
    expect(clocks.map((c) => c.kind)).toEqual(['pcn_discount_14_days', 'pcn_representations_28_days', 'pcn_appeal_28_days']);
    expect(clocks[0]?.basis).toMatch(/BPA \/ IPC Code of Practice/);
    expect(clocks[1]?.basis).toMatch(/POFA 2012 Sch 4/);
    expect(clocks[2]?.basis).toMatch(/POPLA/);
  });
  it('congestion / ULEZ and Dart Charge notices follow the council PCN timetable', () => {
    for (const kind of ['congestion_ulez', 'dart_charge'] as const) {
      const clocks = derivePenaltyClocks(notice({ kind, issuer: 'TfL' }), '2026-07-08T12:00:00+01:00');
      expect(clocks.map((c) => c.kind), kind).toEqual(['pcn_discount_14_days', 'pcn_representations_28_days']);
      expect(clocks[0]?.basis).toMatch(/Traffic Management Act 2004/);
    }
  });
  it('a fixed penalty notice yields one custom clock on the printed deadline', () => {
    const clocks = derivePenaltyClocks(notice({ kind: 'fpn', responseDeadline: '2026-08-03' }), '2026-07-08T12:00:00+01:00');
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ kind: 'custom', dueAt: '2026-08-03T23:59:59+01:00', status: 'running' });
    expect(clocks[0]?.basis).toMatch(/RTOA 1988/);
  });
});
