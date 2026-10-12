/** Test helpers for the smart-intake modules (not exported from the package index). */
import type { DocType } from '../../agents/types.js';
import type { BundleFieldKey, Candidate, CandidateEngine, FieldSource } from './types.js';

export function src(fileId: string, docType: DocType | null, over: Partial<FieldSource> = {}): FieldSource {
  return {
    fileId,
    itemId: `item-${fileId}`,
    evidenceId: `ev-${fileId}`,
    filename: `${fileId}.pdf`,
    docType,
    docTypeLabel: docType,
    page: 1,
    quote: null,
    confidence: 0.8,
    engine: 'rules',
    rank: 50,
    label: `${docType ?? 'file'}, page 1`,
    quoteVerified: null,
    ...over,
  };
}

export function cand(key: BundleFieldKey, value: string, fileId: string, docType: DocType | null, over: { confidence?: number; engine?: CandidateEngine; rank?: number; display?: string; validatorOk?: boolean; page?: number; quote?: string } = {}): Candidate {
  return {
    key,
    value,
    display: over.display ?? value,
    source: src(fileId, docType, {
      confidence: over.confidence ?? 0.8,
      engine: over.engine ?? 'rules',
      rank: over.rank ?? 50,
      ...(over.page !== undefined ? { page: over.page } : {}),
      ...(over.quote !== undefined ? { quote: over.quote } : {}),
    }),
    validatorOk: over.validatorOk ?? true,
    validatorMessage: over.validatorOk === false ? 'failed its check' : null,
  };
}
