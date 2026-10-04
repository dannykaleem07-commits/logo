import { describe, expect, it } from 'vitest';
import type { GeneratedDocument } from '@ccguk/domain';
import { approvalBlocker, canSend, canSign, extraDataBody, extraDataFields, flagCounts, groupTemplates, humanise, isBlocked, sortDocuments, supersedeDataFrom } from './documents';

const doc = (over: Partial<GeneratedDocument>): GeneratedDocument => ({
  id: 'd1',
  claimId: 'c1',
  templateId: 'letter.chaser_7',
  templateVersion: '1.0.0',
  title: 'Chaser',
  status: 'draft',
  html: '<p>x</p>',
  sha256: 'f'.repeat(64),
  createdAt: '2026-09-01T10:00:00Z',
  createdBy: 'u1',
  dataSnapshot: {},
  ...over
});

describe('template picker', () => {
  it('groups by kind in picker order and sorts titles', () => {
    const groups = groupTemplates([
      { id: 'report.engineer', version: '1.0.0', kind: 'report', title: "Engineer's report", requiredData: [] },
      { id: 'letter.ncaf', version: '1.0.0', kind: 'letter', title: 'New Claim Advice Form', requiredData: [] },
      { id: 'letter.chaser_7', version: '1.0.0', kind: 'letter', title: 'Chaser (day 7)', requiredData: [] },
      { id: 'invoice.hire', version: '1.0.0', kind: 'invoice', title: 'Hire invoice', requiredData: [] }
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['letter', 'invoice', 'report']);
    expect(groups[0]!.label).toBe('Letters');
    expect(groups[0]!.templates.map((t) => t.id)).toEqual(['letter.chaser_7', 'letter.ncaf']);
  });
  it('separates extra fields from data the snapshot supplies; amounts and dates the ledger knows are never typed', () => {
    const fields = extraDataFields(['settings.registeredOffice', 'claim.ourReference', 'recipient.name', 'allegationQuoted', 'responseDeadline', 'outstandingPence', 'authorityDate', 'operatorType']);
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['settings.registeredOffice', 'supplied'],
      ['claim.ourReference', 'supplied'],
      ['recipient.name', 'supplied'],
      ['allegationQuoted', 'text'],
      ['responseDeadline', 'date'],
      ['outstandingPence', 'supplied'],
      ['authorityDate', 'date'],
      ['operatorType', 'text']
    ]);
    expect(humanise('allegationLetter.date')).toBe('Allegation letter › date');
    expect(extraDataBody(fields, { allegationQuoted: ' "you ignored our offer" ', operatorType: '', responseDeadline: '2026-10-20', 'claim.ourReference': 'ignored' })).toEqual({ allegationQuoted: '"you ignored our offer"', responseDeadline: '2026-10-20' });
    expect(extraDataBody(fields, {})).toBeUndefined();
  });
});

describe('approval gate (lesson a: £1,287 stated vs £1,112 received blocks)', () => {
  const blocked = doc({
    status: 'blocked',
    consistency: {
      checkedAt: '2026-09-01T10:00:00Z',
      blocked: true,
      flags: [
        { code: 'AMOUNT_PAID_MISMATCH', severity: 'block', message: 'Draft says £1,287.00 paid; ledger shows £1,112.00', draftValue: '£1,287.00', ledgerValue: '£1,112.00', excerpt: 'we received £1,287.00' },
        { code: 'UNVERIFIED_CITATION', severity: 'warn', message: 'Irani v Duchon not verified' }
      ]
    }
  });
  it('counts flags and disables approval while a block flag is uncleared', () => {
    expect(flagCounts(blocked.consistency)).toEqual({ block: 1, warn: 1, info: 0, blocking: 1, cleared: 0, total: 2 });
    expect(isBlocked(blocked)).toBe(true);
    expect(approvalBlocker(blocked)).toMatch(/1 block flag must be cleared with a reason/);
  });
  it('opens approval once every block flag is cleared', () => {
    const cleared = doc({
      status: 'draft',
      consistency: { checkedAt: 'x', blocked: false, flags: [{ code: 'AMOUNT_PAID_MISMATCH', severity: 'block', message: 'm', clearedAt: '2026-09-01T11:00:00Z', clearedBy: 'u2', clearedReason: 'Second remittance £175 received 2 Sept, ledger updated' }] }
    });
    expect(isBlocked(cleared)).toBe(false);
    expect(approvalBlocker(cleared)).toBeUndefined();
    expect(approvalBlocker(doc({ status: 'draft' }))).toMatch(/Waiting/);
    expect(approvalBlocker(doc({ status: 'sent' }))).toMatch(/Already approved/);
  });
  it('send and sign follow the status', () => {
    expect(canSend(doc({ status: 'draft' }))).toBe(false);
    expect(canSend(doc({ status: 'approved' }))).toBe(true);
    expect(canSign(doc({ status: 'approved', templateId: 'agreement.credit_hire' }))).toBe(true);
    expect(canSign(doc({ status: 'approved', templateId: 'letter.ncaf' }))).toBe(false);
    expect(canSign(doc({ status: 'draft', templateId: 'agreement.credit_hire' }))).toBe(false);
  });
  it('orders current versions before superseded ones', () => {
    const docs = [doc({ id: 'old', status: 'superseded', createdAt: '2026-09-03T00:00:00Z' }), doc({ id: 'a', createdAt: '2026-09-01T00:00:00Z' }), doc({ id: 'b', createdAt: '2026-09-02T00:00:00Z' })];
    expect(sortDocuments(docs).map((d) => d.id)).toEqual(['b', 'a', 'old']);
  });
  it('re-execution carries the real date and supersedes the version (lesson b)', () => {
    const today = '2026-10-04';
    expect(supersedeDataFrom(doc({}), { reExecutedOn: '', reason: '' }, today).ok).toBe(false);
    expect(supersedeDataFrom(doc({}), { reExecutedOn: '2026-10-05', reason: 'Client signed the wrong copy' }, today).ok).toBe(false);
    expect(supersedeDataFrom(doc({}), { reExecutedOn: '', reason: 'Client signed the wrong copy' }, today)).toEqual({
      ok: true,
      data: { supersedesId: 'd1', supersedesVersion: '1.0.0', reExecutedOn: today, reExecutionReason: 'Client signed the wrong copy' }
    });
  });
});
