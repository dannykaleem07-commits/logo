// owned by knowledge-use
/**
 * The reviewer checks outbound knowledge (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.3). Pure. Runs in tier a of the
 * casework reviewer next to the existing UNVERIFIED_CITATION, GTA_CITED_AS_LAW and FORUM_NOT_OPEN checks (unchanged).
 *
 *   KNOWLEDGE_REF_UNKNOWN               block  a cited ki: ref does not resolve or is not active
 *   KNOWLEDGE_NOT_CITABLE               block  internal / code_only / computed / FOS to an at-fault insurer / injury
 *   KNOWLEDGE_LEGAL_UNCONFIRMED         block  a legal, quantum or precedent item cited without a person's check
 *   KNOWLEDGE_INTERNAL_LEAK             block  ≥ 8-word overlap with an internal item injected into the drafting run, or
 *                                              statistic phrasing about the recipient ("you usually pay in", "in 3 of 4 cases")
 *   KNOWLEDGE_STALE                     warn   a cited item's health is not ok
 *   KNOWLEDGE_CONFLICTED                warn   a cited item has an open conflict (the reviewer escalates it to the owner)
 *   KNOWLEDGE_UNVERIFIED_STATED_AS_FACT warn   an unverified external item is the only basis for a factual sentence
 *
 * KB (`kb:`) and pack refs keep their own checks (UNVERIFIED_CITATION and friends); here they only get the
 * not-citable and stale checks. Flags are de-duplicated and ordered deterministically.
 */
import type { RecipientRole } from '../agents/types.js';
import type { ConsistencyFlag } from '../types.js';
import type { KnowledgeHit, KnowledgeRef } from './types.js';
import { candidateAsItem, knowledgeWords, sharedShingle } from './retrieval.js';
import { mayCiteOutbound } from './verification.js';

export interface KnowledgeUseInput {
  text: string;
  recipientRole: RecipientRole | null;
  /** from {{cite:ki:…}} / KB / pack placeholders in the draft (SD §E.3 mechanism, ki: prefix added) */
  citedRefs: KnowledgeRef[];
  /** from the drafting run's result basis[] (BasisKind 'knowledge') */
  basisRefs: KnowledgeRef[];
  /** computed + internal items injected into that run */
  internalBodies: { ref: KnowledgeRef; text: string }[];
  resolve(ref: KnowledgeRef): KnowledgeHit | undefined;
}

/** Words in a row that count as a leak of internal text (§8.3). */
export const INTERNAL_LEAK_SHINGLE = 8;
/** Words in a row that tie a sentence to an item's text (stated-as-fact detection). */
export const STATED_SHINGLE = 5;

/** Statistic phrasing about the recipient — internal figures must never be put to the insurer (KR-10). */
export const STATISTIC_PHRASES: readonly RegExp[] = [
  /\byou\s+(?:usually|normally|typically|generally|often|tend\s+to|on\s+average)\s+(?:pay|settle|take|reply|respond|offer|reduce|dispute|object)\b/i,
  /\bon\s+average,?\s+you\b/i,
  /\byour\s+(?:average|median|typical|usual)\s+(?:payment|settlement|response|reply|offer|time)\b/i,
  /\bin\s+\d+\s+(?:of|out\s+of)\s+(?:the\s+)?(?:last\s+)?\d+\s+(?:cases|claims|matters|files)\b/i,
  /\b\d{1,3}\s?%\s+of\s+(?:our\s+|your\s+|the\s+)?(?:cases|claims|matters|files)\b/i,
  /\b(?:median|average)\s+of\s+\d+\s+working\s+days\b/i,
];

const HEDGE_RE = /\b(?:unverified|we\s+understand|it\s+appears|appears\s+to|we\s+believe|may\s+be|reportedly|according\s+to)\b/i;
const CONFIRMED: ReadonlySet<string> = new Set(['owner_confirmed', 'source_verified', 'kb_verified']);

const isKi = (ref: string): boolean => ref.startsWith('ki:');
const flag = (code: ConsistencyFlag['code'], severity: ConsistencyFlag['severity'], message: string, excerpt?: string): ConsistencyFlag => ({ code, severity, message, ...(excerpt ? { excerpt } : {}) });

/** Sentences of a text (simple: split on . ! ? and line breaks). */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => knowledgeWords(s).length >= 4);
}

/** Why a cited hit may not be cited (null = it may), judged with health set aside (health has its own warn codes). */
function citeProblem(hit: KnowledgeHit, role: RecipientRole | null): { code: 'KNOWLEDGE_NOT_CITABLE' | 'KNOWLEDGE_LEGAL_UNCONFIRMED'; reason: string } | null {
  const item = { ...candidateAsItem(hit), health: 'ok' as const };
  const r = mayCiteOutbound(item, role);
  if (r.ok) return null;
  const needsCheck = hit.area === 'legal' || hit.area === 'quantum' || hit.kind === 'precedent';
  if (needsCheck && !CONFIRMED.has(hit.verification)) {
    // Only the confirmation is missing? Then it is LEGAL_UNCONFIRMED; anything else is NOT_CITABLE.
    const ifConfirmed = mayCiteOutbound({ ...item, verification: 'owner_confirmed' }, role);
    if (ifConfirmed.ok) return { code: 'KNOWLEDGE_LEGAL_UNCONFIRMED', reason: r.reason ?? 'needs the owner to confirm or source-verify it first' };
  }
  return { code: 'KNOWLEDGE_NOT_CITABLE', reason: r.reason ?? 'may not be cited outbound' };
}

export function checkKnowledgeUse(i: KnowledgeUseInput): ConsistencyFlag[] {
  const out: ConsistencyFlag[] = [];
  const seen = new Set<string>();
  const push = (f: ConsistencyFlag, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  const cited = [...new Set(i.citedRefs)].sort();
  for (const ref of cited) {
    const hit = i.resolve(ref);
    if (!hit) {
      if (isKi(ref)) push(flag('KNOWLEDGE_REF_UNKNOWN', 'block', `${ref} is not active knowledge (unknown, retired or not yet approved) and may not be cited`, ref), `unknown:${ref}`);
      continue;
    }
    const problem = citeProblem(hit, i.recipientRole);
    if (problem && (isKi(ref) || problem.code === 'KNOWLEDGE_NOT_CITABLE')) {
      // KB / pack refs: their verification wording is UNVERIFIED_CITATION's job; only hard "not citable" applies.
      if (isKi(ref) || hit.useLimit !== 'outbound_ok' || hit.computed || hit.fos || hit.injury) {
        push(flag(problem.code, 'block', `${ref} (${hit.title}) may not be cited in this ${i.recipientRole === 'at_fault_insurer' ? 'letter to the at-fault insurer' : 'draft'}: ${problem.reason}`, ref), `cite:${ref}`);
      }
    }
    if (hit.health === 'conflicted' || hit.badges.includes('conflicted')) {
      push(flag('KNOWLEDGE_CONFLICTED', 'warn', `${ref} (${hit.title}) has an open conflict with other knowledge — the owner decides before it is relied on`, ref), `conflict:${ref}`);
    } else if (hit.health !== 'ok' || hit.verification === 'kb_stale') {
      push(flag('KNOWLEDGE_STALE', 'warn', `${ref} (${hit.title}) is ${hit.verification === 'kb_stale' ? 'stale' : hit.health.replace(/_/g, ' ')}: re-check it before relying on it`, ref), `stale:${ref}`);
    }
  }

  // Internal leak: ≥ 8 words in a row from an internal item injected into the drafting run.
  for (const b of [...i.internalBodies].sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0))) {
    const s = sharedShingle(i.text, b.text, INTERNAL_LEAK_SHINGLE);
    if (s) push(flag('KNOWLEDGE_INTERNAL_LEAK', 'block', `The draft repeats internal knowledge ${b.ref} ("${s}") — internal figures and notes are never stated outbound`, s), `leak:${b.ref}`);
  }
  for (const re of STATISTIC_PHRASES) {
    const m = re.exec(i.text);
    if (m) push(flag('KNOWLEDGE_INTERNAL_LEAK', 'block', `Statistic phrasing about the recipient ("${m[0]}") — ClaimDesk's own statistics are internal and never put to the other side`, m[0]), `phrase:${m[0].toLowerCase()}`);
  }

  // Unverified external item as the only basis of a factual sentence.
  const basis = [...new Set([...i.basisRefs, ...i.citedRefs])].sort();
  const hits = basis.map((r) => i.resolve(r)).filter((h): h is KnowledgeHit => Boolean(h));
  const externalUnverified = hits.filter((h) => h.external && !CONFIRMED.has(h.verification));
  if (externalUnverified.length) {
    const sentences = sentencesOf(i.text);
    for (const h of externalUnverified) {
      for (const sent of sentences) {
        if (HEDGE_RE.test(sent)) continue;
        if (!sharedShingle(sent, h.text, STATED_SHINGLE)) continue;
        const otherSupport = hits.some((o) => o.ref !== h.ref && CONFIRMED.has(o.verification) && sharedShingle(sent, o.text, STATED_SHINGLE));
        if (otherSupport) continue;
        push(flag('KNOWLEDGE_UNVERIFIED_STATED_AS_FACT', 'warn', `"${sent.slice(0, 160)}" rests only on unverified external knowledge ${h.ref}: word it as unverified or get it confirmed`, sent.slice(0, 160)), `fact:${h.ref}`);
        break;
      }
    }
  }
  const rank: Record<string, number> = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity]! - rank[b.severity]! || a.code.localeCompare(b.code) || (a.excerpt ?? '').localeCompare(b.excerpt ?? ''));
}
