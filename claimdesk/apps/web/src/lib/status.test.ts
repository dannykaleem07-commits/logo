import { describe, expect, it } from 'vitest';
import type { ClaimStatus, DocumentStatus } from '@ccguk/domain';
import { CLAIM_STATUSES, claimStatusLabel, claimStatusTone, clockStatusTone, DOCUMENT_STATUS_LABEL, documentStatusTone, gateTone, priorityTone, severityTone, verificationLabel, verificationTone } from './status';

describe('claim status mapping', () => {
  it('covers every ClaimStatus with a label and a tone', () => {
    const all: ClaimStatus[] = ['fnol', 'triage', 'declined', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing', 'disputed', 'complaint', 'pre_action', 'litigation', 'settled', 'closed'];
    expect(CLAIM_STATUSES.sort()).toEqual([...all].sort());
    for (const s of all) {
      expect(claimStatusLabel(s)).not.toBe('');
      expect(['green', 'amber', 'red', 'blue', 'navy', 'grey']).toContain(claimStatusTone(s));
    }
  });
  it('uses the colour language consistently', () => {
    expect(claimStatusTone('declined')).toBe('red');
    expect(claimStatusTone('settled')).toBe('green');
    expect(claimStatusTone('closed')).toBe('grey');
    expect(claimStatusTone('hire_active')).toBe('blue');
    expect(claimStatusTone('chasing')).toBe('amber');
    expect(claimStatusLabel('hire_active')).toBe('Hire active');
    expect(claimStatusLabel('something_new')).toBe('something new');
  });
});

describe('document status mapping', () => {
  it('covers every DocumentStatus', () => {
    const all: DocumentStatus[] = ['draft', 'blocked', 'approved', 'sent', 'signed', 'superseded', 'void'];
    for (const s of all) {
      expect(DOCUMENT_STATUS_LABEL[s]).toBeTruthy();
      expect(documentStatusTone(s)).toBeTruthy();
    }
    expect(documentStatusTone('blocked')).toBe('red');
    expect(documentStatusTone('draft')).toBe('amber');
    expect(documentStatusTone('sent')).toBe('green');
    expect(documentStatusTone('signed')).toBe('green');
    expect(documentStatusTone('void')).toBe('grey');
  });
});

describe('verification / severity / gates / clocks / priority', () => {
  it('verification is green-amber-red and never upgraded', () => {
    expect(verificationTone('verified')).toBe('green');
    expect(verificationTone('unverified')).toBe('amber');
    expect(verificationTone('stale')).toBe('amber');
    expect(verificationTone('failed')).toBe('red');
    expect(verificationTone(undefined)).toBe('amber');
    expect(verificationLabel({ status: 'unverified' })).toBe('Unverified');
    expect(verificationLabel({ status: 'verified', sourceUrl: 'https://x' })).toBe('Verified');
  });
  it('severity', () => {
    expect(severityTone('block')).toBe('red');
    expect(severityTone('warn')).toBe('amber');
    expect(severityTone('info')).toBe('blue');
  });
  it('gates map 1:1', () => {
    expect(gateTone('green')).toBe('green');
    expect(gateTone('amber')).toBe('amber');
    expect(gateTone('red')).toBe('red');
  });
  it('clock status', () => {
    expect(clockStatusTone('breached')).toBe('red');
    expect(clockStatusTone('met')).toBe('green');
    expect(clockStatusTone('running')).toBe('blue');
    expect(clockStatusTone('stopped')).toBe('grey');
    expect(clockStatusTone('not_applicable')).toBe('grey');
  });
  it('priority', () => {
    expect(priorityTone('now')).toBe('red');
    expect(priorityTone('today')).toBe('amber');
    expect(priorityTone('this_week')).toBe('blue');
    expect(priorityTone('scheduled')).toBe('grey');
  });
});
