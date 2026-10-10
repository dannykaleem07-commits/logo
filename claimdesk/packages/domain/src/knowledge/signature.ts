// owned by knowledge-learners
/**
 * L4 contacts from email signatures (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.2). STUB created by knowledge-core: the
 * signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-learners fills them.
 * `DomainCheck` is declared in types.ts (core) because decideKnowledge (KN-05, KN-15) reads it.
 */
import { notImplemented } from './notImplemented.js';
import type { DomainCheck } from './types.js';

export interface SignatureBlock {
  lines: string[];
  startLine: number;
}
export interface ParsedContact {
  name: string | null;
  role: string | null;
  team: string | null;
  phones: { norm: string; kind: 'direct' | 'team' | 'switchboard' | 'mobile' | null }[];
  emails: string[];
  ivr: string | null;
  hours: string | null;
}

/** last ≤ 25 lines above quoted-reply markers; sign-off / "-- " anchors; disclaimers stripped */
export function extractSignature(_bodyText: string): SignatureBlock | null {
  return notImplemented('knowledge-learners', 'extractSignature');
}

/** labels DDI/Direct/Tel/Mob; UK formats via normalisePhone; IVR "option N", "press N" */
export function parseSignature(_b: SignatureBlock): ParsedContact {
  return notImplemented('knowledge-learners', 'parseSignature');
}

export function classifySender(_fromDomain: string, _auth: { dmarc: string } | null, _spoofSuspect: boolean, _entry: { ownDomains: string[]; copycatDomains: string[] } | null): DomainCheck {
  return notImplemented('knowledge-learners', 'classifySender');
}
