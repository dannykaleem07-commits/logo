// owned by knowledge-research
/**
 * Privacy for research (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.6, KR-7). STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 * `ClaimDictionary` is declared in types.ts (core).
 */
import { notImplemented } from './notImplemented.js';
import type { ClaimDictionary } from './types.js';

export type ScrubKind = 'name' | 'vrm' | 'claim_ref' | 'insurer_ref' | 'email' | 'phone' | 'postcode' | 'dob' | 'policy_no' | 'money';

export function scrubForResearch(_text: string, _dict: ClaimDictionary): { text: string; removed: ScrubKind[] } {
  return notImplemented('knowledge-research', 'scrubForResearch');
}

export function containsPii(_text: string, _dict: ClaimDictionary): ScrubKind[] {
  return notImplemented('knowledge-research', 'containsPii');
}

export function egressGuard(_urlOrQuery: string, _dict: ClaimDictionary): { ok: true } | { ok: false; kinds: ScrubKind[] } {
  return notImplemented('knowledge-research', 'egressGuard');
}

export function perimeterTopic(_question: string): 'injury' | 'regulated_advice' | 'fos' | null {
  return notImplemented('knowledge-research', 'perimeterTopic');
}
