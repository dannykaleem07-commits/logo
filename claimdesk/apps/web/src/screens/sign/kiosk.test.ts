// owned by ap-paperwork
import { describe, expect, it } from 'vitest';
import { base64Bytes, FATAL_KIOSK_CODES, kioskMessage, kioskStage, progressLabel, signBlocker } from './kiosk';
import { packActions, packCounts } from '../claim/components/packsView';

const docs = [
  { id: 'a', title: 'Agreement', purpose: 'sign' as const, read: false, signed: false },
  { id: 'b', title: 'Cancellation form', purpose: 'give' as const, read: false, signed: false },
];

describe('kiosk stage', () => {
  it('walks the documents one at a time, then signing, then done', () => {
    expect(kioskStage({ documents: docs, completed: false }, new Set())).toEqual({ kind: 'read', index: 0, total: 2 });
    expect(progressLabel(kioskStage({ documents: docs, completed: false }, new Set(['a'])))).toBe('Document 2 of 2');
    expect(kioskStage({ documents: docs, completed: false }, new Set(['a', 'b']))).toEqual({ kind: 'sign' });
    expect(kioskStage({ documents: docs.map((d) => ({ ...d, read: true })), completed: false }, new Set())).toEqual({ kind: 'sign' });
    expect(kioskStage({ documents: docs, completed: true }, new Set())).toEqual({ kind: 'done' });
  });

  it('enables Sign only with a name, a signature, consent, a requested code and 6 digits', () => {
    const ok = { typedName: 'Jane Example', signaturePng: 'data:image/png;base64,AAAA', code: '123 456', consent: true, codeRequested: true };
    expect(signBlocker(ok)).toBeNull();
    expect(signBlocker({ ...ok, typedName: ' ' })).toBe('Type your full name');
    expect(signBlocker({ ...ok, signaturePng: null })).toBe('Draw your signature');
    expect(signBlocker({ ...ok, consent: false })).toMatch(/Tick the box/);
    expect(signBlocker({ ...ok, codeRequested: false })).toBe('Ask for your code');
    expect(signBlocker({ ...ok, code: '12345' })).toBe('Enter the 6-digit code');
  });

  it('measures the signature image and words the errors plainly', () => {
    expect(base64Bytes('data:image/png;base64,AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(kioskMessage('KIOSK_EXPIRED', 'x')).toMatch(/expired/);
    expect(kioskMessage('SOMETHING_ELSE', 'fallback')).toBe('fallback');
    expect(FATAL_KIOSK_CODES.has('KIOSK_DEVICE')).toBe(true);
  });
});

describe('packs view', () => {
  const item = (purpose: 'sign' | 'give', status: string, documentId?: string) => ({ key: `${purpose}${status}`, templateId: 't', purpose, status, ...(documentId ? { documentId } : {}) }) as never;
  it('offers approve while awaiting approval, then send and the kiosk, never after signing', () => {
    const base = { sendTo: [{ target: 'client' as const, documents: 2 }] };
    expect(packActions({ ...base, status: 'awaiting_approval', view: [item('sign', 'reviewed', 'd1'), item('give', 'reviewed', 'd2')] })).toEqual(['approve_send', 'approve_only', 'reject']);
    expect(packActions({ ...base, status: 'approved', view: [item('sign', 'approved', 'd1')] })).toEqual(['send', 'kiosk', 'reject']);
    expect(packActions({ ...base, status: 'sent', view: [item('sign', 'sent', 'd1')] })).toEqual(['kiosk', 'reject']);
    expect(packActions({ ...base, status: 'signed', view: [item('sign', 'signed', 'd1')] })).toEqual([]);
    expect(packActions({ ...base, status: 'preparing', view: [item('sign', 'pending')] })).toEqual(['reject', 'restart']);
  });
  it('counts documents to sign and keep', () => {
    expect(packCounts([item('sign', 'signed', 'd'), item('sign', 'sent', 'e'), item('give', 'sent', 'f')])).toBe('2 to sign · 1 to keep · 1 signed');
  });
});
