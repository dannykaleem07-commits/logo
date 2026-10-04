/**
 * Legacy-detail and banned-phrase dictionary (BLUEPRINT §3.10, live-file lesson i; ARCHITECTURE convention 9).
 * packages/documents/src/brand.ts carries an identical copy as `brand.legacy` — keep the two lists the same.
 */
import type { ConsistencyFlag } from '../types.js';

export const REGISTERED_NAME = 'Courtesy Cars Group UK Ltd';

/** Strings that must never appear in an outgoing document (the legacy Car Flex / Carflex Ltd identity). */
export const LEGACY_BLOCKED_STRINGS: readonly string[] = ['Car Flex', 'Carflex Ltd', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk'];

/** The one permitted exact-case form: the supplier's registered name (CARFLEX LTD, company 12640635). */
export const LEGACY_ALLOWED_EXACT_CASE: readonly string[] = ['CARFLEX LTD'];

/** Disclaimer phrases that must never be used (script guard, lesson m). */
export const BANNED_PHRASES: readonly string[] = ['ignore any offer of a courtesy car', 'do not accept a vehicle from the insurer'];

/** Wording that implies regulated status (Legal Services Act 2007 s.12 perimeter; SRA). */
export const REGULATED_STATUS_PHRASES: readonly string[] = [
  'our solicitors',
  'our solicitor',
  'we act as your solicitors',
  'we act as your solicitor',
  'regulated by the SRA',
  'regulated by the Solicitors Regulation Authority',
  'legal advice from our lawyers',
  'our lawyers',
  'our lawyer',
  'our legal team'
];

/** Wording that reads like a solicitor–client retainer: warn with the perimeter-safe alternative (perimeter.md Part 2). */
export const REGULATED_STATUS_WARN_PHRASES: ReadonlyArray<{ phrase: RegExp; suggestion: string }> = [
  { phrase: /\bour\s+clients?\b(?:['’]s?)?/gi, suggestion: 'the claimant / our customer' },
  { phrase: /\bwe\s+act\s+for\b/gi, suggestion: 'we are instructed to correspond on behalf of' }
];

/** Mirror of packages/documents brand.legacy — same order, same strings. */
export const legacy = {
  blockedStrings: [...LEGACY_BLOCKED_STRINGS],
  allowedExactCase: [...LEGACY_ALLOWED_EXACT_CASE],
  bannedPhrases: [...BANNED_PHRASES, 'our solicitors', 'we act as your solicitors', 'regulated by the SRA', 'legal advice from our lawyers']
} as const;

interface LegacyPattern {
  label: string;
  re: RegExp;
  /** When the matched text equals one of these exactly (case-sensitive), it is allowed. */
  allowExact?: readonly string[];
  suggestion: string;
}

const LEGACY_PATTERNS: LegacyPattern[] = [
  { label: 'Car Flex', re: /\bcar[\s\-]+flex\b/gi, suggestion: `Use the registered name "${REGISTERED_NAME}".` },
  { label: 'Carflex Ltd', re: /\bcarflex\s+ltd\b\.?/gi, allowExact: LEGACY_ALLOWED_EXACT_CASE, suggestion: `Legacy company name. Only the supplier's exact registered form "CARFLEX LTD" is permitted; otherwise use "${REGISTERED_NAME}".` },
  { label: 'Carflex Limited', re: /\bcarflex\s+limited\b/gi, suggestion: 'Legacy company name. Remove.' },
  { label: '17360033', re: /\b17360033\b/g, suggestion: 'Legacy company number. The registered company number is 17430389.' },
  { label: '66 Paul Street', re: /\b66,?\s+Paul\s+St(?:reet|\.)?\b/gi, suggestion: 'Legacy address. Use the current registered office from Settings.' },
  { label: 'EC2A 4PX', re: /\bEC2A\s*4PX\b/gi, suggestion: 'Legacy postcode. Use the current registered office from Settings.' },
  { label: 'courtesycarsuk.co.uk', re: /courtesycarsuk\.co\.uk/gi, suggestion: 'Legacy domain. Use claims@courtesycars.net.' }
];

export function excerptAround(text: string, index: number, length: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** LEGACY_DETAIL (block) for every legacy string, honouring the exact-case allowance. */
export function legacyCheck(text: string): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  for (const p of LEGACY_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const matched = m[0].replace(/\.$/, '');
      if (p.allowExact && p.allowExact.includes(matched)) continue;
      flags.push({
        code: 'LEGACY_DETAIL',
        severity: 'block',
        message: `Legacy detail "${matched}" (${p.label}) must not appear in any outgoing document. ${p.suggestion}`,
        draftValue: matched,
        excerpt: excerptAround(text, m.index, m[0].length)
      });
    }
  }
  return flags;
}

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
}

const NEGATION_BEFORE = /\b(?:not|nor|never|neither|is\s+not|are\s+not|isn['’]t|aren['’]t)\s*$/i;

/**
 * BANNED_PHRASE (block) for the disclaimer phrases; REGULATED_STATUS_IMPLIED (block) for wording implying regulated
 * status, except where negated ("is not regulated by the SRA" is the mandatory status line); "our client(s)" → warn
 * with the suggestion "the claimant / our customer".
 */
export function bannedPhraseCheck(text: string): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  for (const phrase of BANNED_PHRASES) {
    const re = phraseRegex(phrase);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      flags.push({
        code: 'BANNED_PHRASE',
        severity: 'block',
        message: `Banned phrase "${m[0]}". Never tell a client to ignore or refuse an insurer's offer; log the offer and reply in writing with reasons (Copley v Lawn mitigation risk).`,
        draftValue: m[0],
        excerpt: excerptAround(text, m.index, m[0].length)
      });
    }
  }
  const statusMatches: Array<{ index: number; length: number; text: string }> = [];
  for (const phrase of REGULATED_STATUS_PHRASES) {
    const re = phraseRegex(phrase);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (NEGATION_BEFORE.test(before)) continue; // "is not regulated by the SRA"
      statusMatches.push({ index: m.index, length: m[0].length, text: m[0] });
    }
  }
  statusMatches.sort((a, b) => a.index - b.index || b.length - a.length);
  let coveredTo = -1;
  for (const m of statusMatches) {
    if (m.index < coveredTo) continue; // nested phrase ("our lawyers" inside "legal advice from our lawyers")
    coveredTo = m.index + m.length;
    flags.push({
      code: 'REGULATED_STATUS_IMPLIED',
      severity: 'block',
      message: `"${m.text}" implies regulated legal status. CCGUK is not a firm of solicitors and is not regulated by the SRA (Legal Services Act 2007 s.12). Use "we assist", "we are instructed to correspond on behalf of" or "paralegal/accident management services".`,
      draftValue: m.text,
      excerpt: excerptAround(text, m.index, m.length)
    });
  }
  for (const { phrase, suggestion } of REGULATED_STATUS_WARN_PHRASES) {
    const re = new RegExp(phrase.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (NEGATION_BEFORE.test(before)) continue; // "we do not act for"
      flags.push({
        code: 'REGULATED_STATUS_IMPLIED',
        severity: 'warn',
        message: `"${m[0]}" reads like a solicitor–client relationship. Prefer "${suggestion}" (Legal Services Act 2007 s.12 perimeter).`,
        draftValue: m[0],
        ledgerValue: suggestion,
        excerpt: excerptAround(text, m.index, m[0].length)
      });
    }
  }
  return flags;
}
