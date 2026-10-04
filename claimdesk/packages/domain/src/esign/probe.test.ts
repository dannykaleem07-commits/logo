import { describe, it, expect } from 'vitest';
import { signatureDateChecks } from './index.js';
import { fixtureDocument } from '../evidence/bundle.fixture.js';
import type { GeneratedDocument, SignatureRecord } from '../types.js';

const sig = (signedAt: string): SignatureRecord => ({ signerPartyId: 'p', signerName: 'A', signerContact: 'a@b.c', otpChannel: 'email', otpVerifiedAt: signedAt, ipAddress: '1.1.1.1', userAgent: 'UA', signedAt, documentSha256: 'b'.repeat(64), certificateId: 'C' });

describe('PROBE esign', () => {
  it('E1 duplicate London date across UTC midnight in BST', () => {
    const docs: GeneratedDocument[] = [
      fixtureDocument('d1', 'agreement.credit_hire', { createdAt: '2026-06-30T20:00:00Z', signature: sig('2026-06-30T23:30:00Z') }), // 1 July 00:30 BST
      fixtureDocument('d2', 'agreement.storage', { createdAt: '2026-06-30T20:00:00Z', signature: sig('2026-07-01T08:00:00Z') }) // 1 July 09:00 BST
    ];
    const f = signatureDateChecks(docs, 'claim-1');
    console.log('E1', f);
    expect(f.map((x) => x.code)).toEqual(['DUPLICATE_SIGNATURE_DATE']);
  });
});
