// owned by knowledge-learners
/**
 * Conflict detection (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.7), run on every proposal (through
 * `KnowledgeHooks.conflictsFor`) and nightly. Only code records conflicts; the AI curator may only mention a
 * contradiction in its summary. Pure: the caller reads the active items, the directory values, the pack red lines and
 * the overlapping KB entries into a `ConflictContext`.
 *
 *   duplicate           same itemKey, different content, and the existing version is the owner's, verified, or from a
 *                       different origin (a learner superseding its own unverified version is normal, not a conflict)
 *   directory_mismatch  a learned team / switchboard number or a shared inbox that the directory does not list, or a
 *                       contact email on a domain the directory never uses
 *   red_line            the item text matches an active pack red-line pattern
 *   perimeter           FOS material for CCGUK (FORUM_NOT_OPEN), GTA as law, regulated status, in-house PI handling …
 *   kb_contradiction    a negation or number mismatch against a KB entry with an overlapping citation or tags
 *   stats_vs_note       a note's figure outside the computed profile's range (IQR for heads; median/2 … p90 for days);
 *                       the profile → note direction runs nightly through profileNoteConflicts
 *
 * `leftRef` is `'new'` for the proposal (the store replaces it with `ki:<id>`).
 */
import { perimeterTextFlags } from './autonomy.js';
import { contentShaOf, itemKeyFor, normaliseKeyText } from './keys.js';
import { isFosTagged } from './verification.js';
import type { ConflictFinding, ContactData, FactData, InsurerProfileData, KnowledgeItem, KnowledgeProposal } from './types.js';
import { normaliseSenderDomain } from './signature.js';

/** What conflict detection compares a proposal with (all read by the caller; this module stays pure). */
export interface ConflictContext {
  /** active items of the same itemKey or scope */
  active: readonly Pick<KnowledgeItem, 'id' | 'itemKey' | 'kind' | 'area' | 'title' | 'body' | 'data' | 'scope' | 'verification' | 'origin' | 'contentSha256'>[];
  /** directory values for the proposal's insurer (contacts) */
  directory: { slug: string; phones: string[]; emails: string[] } | null;
  /** active pack red-line patterns */
  redLines: readonly { id: string; pattern: string; scope: string | null }[];
  /** KB entries with overlapping citation or tags */
  kb: readonly { id: string; citation: string | null; text: string; tags: string[] }[];
}

type ActiveItem = ConflictContext['active'][number];

const SHARED_INBOX = /^(?:claims?|tp|tpclaims|thirdparty|third\.party|third-party|recoveries|recovery|complaints?|enquiries|info|customerservices|customer\.services|motorclaims|motor\.claims|newclaims|credithire|credit\.hire|hire|admin|mail|post)(?:[._-].*)?@/i;
const digits = (s: string): string => s.replace(/\D/g, '');

function textOf(p: Pick<KnowledgeProposal, 'title' | 'body' | 'data'>): string {
  let data = '';
  try {
    data = JSON.stringify(p.data ?? {});
  } catch {
    data = '';
  }
  return `${p.title}\n${p.body}\n${data}`;
}

function redLineMatches(pattern: string, text: string): boolean {
  const p = (pattern ?? '').trim();
  if (!p) return false;
  try {
    return new RegExp(p, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(p.toLowerCase());
  }
}

const NEGATION = /\b(?:not|no|never|cannot|can't|won't|isn't|aren't|doesn't|don't|didn't|without|neither|nor|unless)\b/i;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'is', 'are', 'be', 'it', 'that', 'this', 'as', 'at', 'from', 'was', 'were', 'has', 'have', 'which', 'any', 'all', 'may', 'must', 'will', 'can', 'not', 'no', 'never']);
const contentWords = (s: string): Set<string> => new Set(normaliseKeyText(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const UNIT_NUMBER = /(\d+(?:\.\d+)?)\s*(%|per\s*cent|working\s+days?|days?|weeks?|months?|years?)/gi;

function unitNumbers(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of text.matchAll(UNIT_NUMBER)) {
    const unit = m[2]!.toLowerCase().replace(/per\s*cent/, '%').replace(/s$/, '').replace(/\s+/g, ' ');
    const set = out.get(unit) ?? new Set<string>();
    set.add(String(Number(m[1])));
    out.set(unit, set);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function kbFindings(p: KnowledgeProposal, kb: ConflictContext['kb']): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  const text = `${p.title}\n${p.body}${(p.data as Partial<FactData>)?.statement ? `\n${(p.data as FactData).statement}` : ''}`;
  const norm = normaliseKeyText(text);
  const tags = new Set(p.tags.map((t) => t.toLowerCase()));
  const words = contentWords(text);
  const nums = unitNumbers(text);
  for (const e of kb) {
    const citationHit = Boolean(e.citation && e.citation.trim().length >= 4 && norm.includes(normaliseKeyText(e.citation)));
    const tagHit = e.tags.some((t) => tags.has(t.toLowerCase()) && !['general', 'misc', 'other'].includes(t.toLowerCase()));
    if (!citationHit && !tagHit) continue;
    const ew = contentWords(e.text);
    const overlap = jaccard(words, ew);
    if (overlap < (citationHit ? 0.08 : 0.2)) continue;
    const en = unitNumbers(e.text);
    for (const [unit, values] of nums) {
      const other = en.get(unit);
      if (other && other.size && ![...values].some((v) => other.has(v))) {
        out.push({ kind: 'kb_contradiction', leftRef: 'new', rightRef: `kb:${e.id}`, detail: `States ${[...values].join('/')} ${unit} where KB ${e.citation ?? e.id} says ${[...other].join('/')} ${unit}` });
        break;
      }
    }
    if (out.some((f) => f.rightRef === `kb:${e.id}`)) continue;
    if (NEGATION.test(text) !== NEGATION.test(e.text) && overlap >= 0.3) {
      out.push({ kind: 'kb_contradiction', leftRef: 'new', rightRef: `kb:${e.id}`, detail: `Appears to negate KB ${e.citation ?? e.id}: one says "not/never", the other does not` });
    }
  }
  return out;
}

const HEAD_WORDS: readonly string[] = ['hire', 'recovery', 'storage', 'engineer_fee', 'pav', 'repair', 'salvage', 'excess', 'loss_of_use', 'diminution', 'personal_effects', 'loss_of_earnings', 'travel', 'misc'];

/** A note's figure vs the computed profile (§6.7 stats_vs_note). Returns a reason, or null when consistent. */
export function noteContradictsProfile(note: { title: string; body: string; data: unknown }, profile: InsurerProfileData): string | null {
  const fact = note.data as Partial<FactData>;
  const fig = fact?.figure;
  if (!fig || typeof fig.value !== 'number') return null;
  const text = normaliseKeyText(`${note.title} ${note.body} ${fact.statement ?? ''}`);
  const unit = fig.unit.toLowerCase();
  if (unit.includes('%') || unit.includes('percent') || unit.includes('pct')) {
    const head = HEAD_WORDS.find((h) => text.includes(h.replace(/_/g, ' ')) || text.includes(h));
    const dist = head ? profile.heads[head as keyof InsurerProfileData['heads']]?.paidOfClaimedPct : null;
    if (head && dist && /\bpa(?:y|id|ys)\b/.test(text) && (fig.value < dist.p25 || fig.value > dist.p75)) {
      return `The note says ${fig.value}% of ${head} is paid; ClaimDesk's records show ${dist.p25}–${dist.p75}% (median ${dist.median}%, n=${dist.n})`;
    }
    return null;
  }
  if (unit.includes('day') && /\bpa(?:y|id|ys|yment)\b/.test(text)) {
    const d = profile.daysToPay;
    if (d.medianWorkingDays !== null && d.p90WorkingDays !== null && (fig.value < d.medianWorkingDays / 2 || fig.value > d.p90WorkingDays)) {
      return `The note says ${fig.value} days to pay; ClaimDesk's records show a median of ${d.medianWorkingDays} working days (90th percentile ${d.p90WorkingDays}, n=${d.n})`;
    }
  }
  return null;
}

function contactFindings(p: KnowledgeProposal, dir: NonNullable<ConflictContext['directory']>): ConflictFinding[] {
  const c = p.data as Partial<ContactData>;
  const out: string[] = [];
  const dirPhones = dir.phones.map(digits).filter(Boolean);
  const dirEmails = dir.emails.map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (c.phone && (c.phoneKind === 'switchboard' || c.phoneKind === 'team') && dirPhones.length && !dirPhones.includes(digits(c.phone))) {
    out.push(`${c.phoneKind} number ${c.phone} is not the directory's ${dir.phones.join(' / ')}`);
  }
  if (c.email && dirEmails.length) {
    const email = c.email.toLowerCase().trim();
    const domain = normaliseSenderDomain(email);
    const dirDomains = [...new Set(dirEmails.map((e) => normaliseSenderDomain(e)))];
    if (!dirDomains.some((d) => domain === d || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`))) out.push(`email ${email} is on ${domain}, which the directory does not use (${dirDomains.join(', ')})`);
    else if (SHARED_INBOX.test(email) && !dirEmails.includes(email)) out.push(`shared inbox ${email} differs from the directory's ${dirEmails.join(' / ')}`);
  }
  return out.length ? [{ kind: 'directory_mismatch', leftRef: 'new', rightRef: `dir:${dir.slug}`, detail: `Learned contact differs from the insurer directory: ${out.join('; ')}` }] : [];
}

function duplicateFinding(p: KnowledgeProposal, active: readonly ActiveItem[]): ConflictFinding[] {
  if (p.origin === 'computed') return [];
  const key = itemKeyFor(p);
  const sha = contentShaOf(p);
  const same = active.find((a) => a.itemKey === key);
  if (!same || same.contentSha256 === sha) return [];
  if (same.origin === p.origin && same.verification === 'unverified' && same.origin !== 'owner') return [];
  return [{ kind: 'duplicate', leftRef: 'new', rightRef: `ki:${same.id}`, detail: `A different version of "${same.title}" is active (${same.origin}, ${same.verification}); the new one is ${p.origin}` }];
}

/**
 * Nightly direction of stats_vs_note: owner-confirmed / verified notes that a freshly computed profile contradicts.
 * Kept out of detectConflicts so a note never holds back the statistics themselves (they apply under KN-14); the
 * learner records these findings after the profile is stored.
 */
export function profileNoteConflicts(profileRef: string, profile: InsurerProfileData, notes: readonly ActiveItem[]): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  for (const a of notes) {
    if (a.kind !== 'fact' || a.verification === 'unverified' || a.scope.kind !== 'insurer' || a.scope.slug !== profile.insurerSlug) continue;
    const why = noteContradictsProfile(a, profile);
    if (why) out.push({ kind: 'stats_vs_note', leftRef: `ki:${a.id}`, rightRef: profileRef, detail: why });
  }
  return out;
}

export function detectConflicts(p: KnowledgeProposal, c: ConflictContext): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  out.push(...duplicateFinding(p, c.active));
  if (p.kind === 'contact' && c.directory) out.push(...contactFindings(p, c.directory));
  const text = textOf(p);
  for (const r of c.redLines) {
    if (redLineMatches(r.pattern, text)) out.push({ kind: 'red_line', leftRef: 'new', rightRef: `pack:${r.id}`, detail: `Matches the red line "${r.pattern.slice(0, 120)}"${r.scope ? ` (${r.scope})` : ''}` });
  }
  const perimeter = new Set(perimeterTextFlags(`${p.title}\n${p.body}`, p.tags));
  const mentionsFos = /\b(?:financial\s+ombudsman|ombudsman\s+service|fos)\b/i.test(`${p.title}\n${p.body}`) || isFosTagged(p.tags, p.provenance);
  if (mentionsFos && p.business.includes('ccguk')) perimeter.add('FORUM_NOT_OPEN');
  for (const code of [...perimeter].sort()) out.push({ kind: 'perimeter', leftRef: 'new', rightRef: `perimeter:${code}`, detail: `Perimeter check ${code} on the item text` });
  if (p.kind === 'fact' || p.kind === 'precedent' || p.kind === 'procedure') out.push(...kbFindings(p, c.kb));
  // stats_vs_note (note → profile; the profile → note direction is profileNoteConflicts, nightly).
  if (p.kind === 'fact' && p.scope.kind === 'insurer') {
    const slug = p.scope.slug;
    for (const a of c.active) {
      if (a.kind !== 'insurer_profile' || (a.data as Partial<InsurerProfileData>)?.insurerSlug !== slug) continue;
      const why = noteContradictsProfile(p, a.data as InsurerProfileData);
      if (why) out.push({ kind: 'stats_vs_note', leftRef: 'new', rightRef: `ki:${a.id}`, detail: why });
    }
  }
  // One finding per (kind, rightRef).
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.kind}|${f.leftRef}|${f.rightRef}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
