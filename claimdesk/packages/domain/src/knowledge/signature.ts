// owned by knowledge-learners
/**
 * L4 contacts from email signatures (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.2). Pure and deterministic.
 *
 *   extractSignature  the sign-off block of the newest message: text above the first quoted-reply marker, after the
 *                     last "-- " line or sign-off ("Kind regards", "Yours faithfully" …), at most 25 lines, with
 *                     confidentiality disclaimers stripped
 *   parseSignature    name, role, team, phones (labelled DDI / Direct / Tel / Mob / Switchboard; UK formats), emails,
 *                     IVR notes ("option 2", "press 3") and opening hours
 *   classifySender    own_domain / unknown_domain / copycat / spoof_suspect for the sending domain
 *
 * `DomainCheck` is declared in types.ts (core) because decideKnowledge (KN-05, KN-15) reads it.
 */
import { normalisePhone } from '../linkage/normalise.js';
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

export const MAX_SIGNATURE_LINES = 25;

const QUOTE_MARKERS: readonly RegExp[] = [
  /^\s*>/,
  /^\s*On\s.{3,200}\swrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}/i,
  /^\s*_{8,}\s*$/,
  /^\s*From:\s.+$/i,
  /^\s*Sent from my\s/i,
];

const SIGN_OFF = /^\s*(?:kind(?:est)?\s+regards|best\s+regards|warm\s+regards|regards|many\s+thanks|thanks(?:\s+(?:again|and\s+regards))?|thank\s+you|yours\s+(?:sincerely|faithfully|truly)|best\s+wishes|best|cheers|sincerely)\s*[,.!]?\s*$/i;
const DASH_DASH = /^--\s?$/;
const DISCLAIMER = /\b(?:this\s+(?:e-?mail|message|communication)\s+(?:and\s+any\s+(?:attachments?|files)\s+)?(?:is|are|may\s+be)\s+(?:confidential|intended)|disclaimer|privileged\s+and\s+confidential|if\s+you\s+(?:are\s+not|have\s+received\s+this)|registered\s+(?:in|office)\s+(?:england|scotland|wales)|registered\s+office|company\s+(?:registration|number|no\.?)|authori[sz]ed\s+and\s+regulated\s+by|please\s+consider\s+the\s+environment|vat\s+(?:registration|reg|no))\b/i;

/** Last ≤ 25 lines above quoted-reply markers; sign-off / "-- " anchors; disclaimers stripped. */
export function extractSignature(bodyText: string): SignatureBlock | null {
  const all = (bodyText ?? '').replace(/\r\n?/g, '\n').split('\n');
  // Only the newest message: stop at the first quoted-reply marker (after at least one line of content).
  let end = all.length;
  let seenContent = false;
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    if (seenContent && QUOTE_MARKERS.some((re) => re.test(line))) {
      end = i;
      break;
    }
    if (line.trim()) seenContent = true;
  }
  const own = all.slice(0, end);
  // Anchor: the last "-- " line, else the last sign-off line.
  let anchor = -1;
  for (let i = own.length - 1; i >= 0; i--) {
    if (DASH_DASH.test(own[i]!)) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) {
    for (let i = own.length - 1; i >= 0; i--) {
      if (SIGN_OFF.test(own[i]!)) {
        anchor = i;
        break;
      }
    }
  }
  if (anchor < 0) return null;
  let lines: string[] = [];
  let startLine = anchor + 1;
  for (let i = anchor + 1; i < own.length && lines.length < MAX_SIGNATURE_LINES; i++) {
    const line = own[i]!;
    if (DISCLAIMER.test(line)) break; // disclaimers (and everything after them) are stripped
    lines.push(line.replace(/\s+$/g, '').replace(/^\s+/, ''));
  }
  // Trim blank lines at both ends.
  while (lines.length && !lines[0]!.trim()) {
    lines = lines.slice(1);
    startLine += 1;
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines = lines.slice(0, -1);
  if (!lines.length) return null;
  return { lines, startLine };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// UK numbers: +44 / 0044 / 0 followed by 9–10 digits with spaces, dots, dashes or brackets.
const PHONE_RE = /(?:\+44\s?\(?0?\)?|0044\s?|\(?0)\d[\d\s().-]{7,15}\d/g;
const ROLE_WORDS = /\b(?:handler|manager|officer|advis[eo]r|executive|technician|negotiator|specialist|assistant|consultant|lead|leader|supervisor|director|administrator|coordinator|co-ordinator|engineer|assessor|analyst|associate|partner|paralegal|solicitor)\b/i;
const TEAM_WORDS = /\b(?:team|department|dept\.?|unit|division|desk|centre|center|recoveries|recovery\s+unit|third\s+party|tp\s+claims|claims\s+(?:hub|team|department))\b/i;
const PHONE_TEST = new RegExp(PHONE_RE.source);
const IVR_RE = /\b(?:option|press|select)\s*\d+\b/i;
const HOURS_RE = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b.*\d|\b\d{1,2}(?::\d{2}|\.\d{2})?\s?(?:am|pm)\s?(?:-|–|to)\s?\d{1,2}(?::\d{2}|\.\d{2})?\s?(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\s?(?:-|–|to)\s?\d{1,2}[:.]\d{2}\b/i;
const NAME_RE = /^(?:(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){1,3}$/;
const NOT_A_NAME = /\b(?:limited|ltd|plc|insurance|insurer|claims?|team|department|services|group|direct|regards|thanks|street|road|house|floor|centre|center|london|manchester|birmingham|leeds|bristol|office)\b/i;

function phoneKindOf(line: string, matchIndex: number): ParsedContact['phones'][number]['kind'] {
  const label = line.slice(0, matchIndex).toLowerCase();
  if (/\b(?:ddi|direct(?:\s+dial|\s+line)?|d)\s*[:.]?\s*$|\bdirect\b/.test(label)) return 'direct';
  if (/\b(?:mob(?:ile)?|m|cell)\s*[:.]?\s*$|\bmob/.test(label)) return 'mobile';
  if (/\b(?:switchboard|main|reception|general|office)\b/.test(label)) return 'switchboard';
  if (/\bteam\b/.test(label)) return 'team';
  return null;
}

/** Labels DDI/Direct/Tel/Mob; UK formats via normalisePhone; IVR "option N", "press N". */
export function parseSignature(b: SignatureBlock): ParsedContact {
  const lines = b.lines.map((l) => l.trim()).filter((l) => l.length > 0);
  const phones: ParsedContact['phones'] = [];
  const emails: string[] = [];
  let name: string | null = null;
  let role: string | null = null;
  let team: string | null = null;
  let ivr: string | null = null;
  let hours: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(EMAIL_RE)) {
      const e = m[0].toLowerCase().replace(/\.$/, '');
      if (!emails.includes(e)) emails.push(e);
    }
    for (const m of line.matchAll(PHONE_RE)) {
      const norm = normalisePhone(m[0]);
      if (!norm || norm.length < 10 || norm.length > 11 || !norm.startsWith('0')) continue;
      if (phones.some((p) => p.norm === norm)) continue;
      phones.push({ norm, kind: phoneKindOf(line, m.index ?? 0) });
    }
    if (!ivr && IVR_RE.test(line)) ivr = line.slice(0, 200);
    if (!hours && HOURS_RE.test(line) && !PHONE_TEST.test(line)) hours = line.slice(0, 200);
    const plain = !/[@\d]/.test(line);
    if (!name && plain && i <= 2 && NAME_RE.test(line) && !NOT_A_NAME.test(line) && !ROLE_WORDS.test(line)) {
      name = line;
      continue;
    }
    if (!role && plain && ROLE_WORDS.test(line) && line.length <= 80) {
      role = line;
      continue;
    }
    if (!team && plain && TEAM_WORDS.test(line) && line.length <= 80 && line !== role) team = line;
  }
  return { name, role, team, phones, emails, ivr, hours };
}

/** Lower-case host without scheme, credentials, path or a leading "www.". */
export function normaliseSenderDomain(input: string): string {
  let s = (input ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^/@]*@/, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.split(':')[0] ?? '';
  return s.replace(/^www\./, '').replace(/\.$/, '');
}

const domainMatches = (host: string, d: string): boolean => {
  const n = normaliseSenderDomain(d);
  return n !== '' && (host === n || host.endsWith(`.${n}`));
};

/**
 * How far the sending domain can be trusted for contact learning: a copycat domain (payment-diversion risk) first,
 * then a spoof suspect (flagged by mail parsing, or the insurer's own domain failing DMARC), then the insurer's own
 * domain, else unknown.
 */
export function classifySender(fromDomain: string, auth: { dmarc: string } | null, spoofSuspect: boolean, entry: { ownDomains: string[]; copycatDomains: string[] } | null): DomainCheck {
  const host = normaliseSenderDomain(fromDomain);
  if (!host) return 'unknown_domain';
  if (entry?.copycatDomains.some((d) => domainMatches(host, d))) return 'copycat';
  if (spoofSuspect) return 'spoof_suspect';
  const own = entry?.ownDomains.some((d) => domainMatches(host, d)) ?? false;
  if (own && auth && /^(?:fail|softfail|permerror)$/i.test(auth.dmarc)) return 'spoof_suspect';
  return own ? 'own_domain' : 'unknown_domain';
}
