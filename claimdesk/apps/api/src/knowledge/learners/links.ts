// owned by knowledge-learners
/**
 * Party → insurer links (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.1 step 1). For every at-fault insurer party that has no
 * link yet:
 *   - the party's normalised name equals a directory name → `exact_name` (1.0); equals a brand → `brand` (0.95);
 *   - else DMARC-pass inbound mail on its claims comes from exactly one insurer's own domain → `email_domain` (0.9);
 *   - else, when the directory has candidates, a Needs-you `question` ("Which insurer is 'X'?") with the candidates as
 *     options. The owner's answer is applied on the next run as that owner (`setOwnerInsurerLink`, human only).
 * Code never overwrites an `owner` link (upsertInsurerLink enforces it).
 */
import { searchDirectory } from '@ccguk/kb';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { createNeedsYou } from '../../agent/core.js';
import { setOwnerInsurerLink, upsertInsurerLink } from '../insurerLinks.js';
import { LEARNER, LEARNER_ACTOR, all, entryForDomain, isPerson, json } from './common.js';

export const LINK_QUESTION_PREFIX = 'knowledge.link:';
const GENERIC_WORDS = new Set(['insurance', 'insurer', 'insurers', 'services', 'motor', 'claims', 'group', 'direct', 'underwriting', 'mutual', 'company', 'europe']);

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’'`]/g, '')
    .replace(/\b(?:limited|ltd|plc|company|co|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface LinkRunResult {
  linked: { partyId: string; insurerSlug: string; method: string }[];
  asked: string[];
  appliedOwnerAnswers: number;
  unlinked: number;
}

/** The exact directory match for a party name: name → exact_name, brand → brand. */
export function directoryMatchFor(name: string, directory: readonly InsurerDirectoryEntry[]): { entry: InsurerDirectoryEntry; method: 'exact_name' | 'brand'; confidence: number } | null {
  const n = fold(name);
  if (!n) return null;
  const byName = directory.filter((d) => fold(d.name) === n);
  if (byName.length === 1) return { entry: byName[0]!, method: 'exact_name', confidence: 1 };
  const byBrand = directory.filter((d) => d.brands.some((b) => fold(b) === n));
  if (byBrand.length === 1) return { entry: byBrand[0]!, method: 'brand', confidence: 0.95 };
  return null;
}

/** Apply owner answers to earlier "Which insurer is …?" questions (as the owner who answered). */
function applyOwnerAnswers(ctx: AppContext): number {
  const rows = all<{ id: string; dedupe_key: string; resolution: string | null; resolved_by: string | null }>(
    ctx,
    `SELECT id, dedupe_key, resolution, resolved_by FROM needs_you WHERE kind = 'question' AND status = 'resolved' AND dedupe_key LIKE ?`,
    `${LINK_QUESTION_PREFIX}%`,
  );
  let applied = 0;
  for (const r of rows) {
    const partyId = r.dedupe_key.slice(LINK_QUESTION_PREFIX.length);
    const optionId = json<{ optionId?: string }>(r.resolution)?.optionId ?? '';
    if (!optionId.startsWith('insurer:') || !isPerson(r.resolved_by)) continue;
    const slug = optionId.slice('insurer:'.length);
    const current = ctx.repos.getInsurerLink(ctx.db, partyId);
    if (current?.method === 'owner') continue;
    try {
      setOwnerInsurerLink(ctx, partyId, slug, { userId: r.resolved_by! });
      applied += 1;
    } catch (err) {
      ctx.logger.warn('could not apply the owner’s insurer link answer', { needsYouId: r.id, error: String(err) });
    }
  }
  return applied;
}

export function linkInsurerParties(ctx: AppContext, opts: { ask?: boolean } = {}): LinkRunResult {
  const out: LinkRunResult = { linked: [], asked: [], appliedOwnerAnswers: applyOwnerAnswers(ctx), unlinked: 0 };
  const directory = ctx.kb.directory();
  const parties = all<{ party_id: string; name: string; claims: number }>(
    ctx,
    `SELECT c.at_fault_insurer_id AS party_id, p.name AS name, count(*) AS claims FROM claims c JOIN parties p ON p.id = c.at_fault_insurer_id
       LEFT JOIN insurer_links l ON l.party_id = c.at_fault_insurer_id
      WHERE c.at_fault_insurer_id IS NOT NULL AND l.party_id IS NULL GROUP BY c.at_fault_insurer_id, p.name ORDER BY c.at_fault_insurer_id`,
  );
  for (const p of parties) {
    const exact = directoryMatchFor(p.name, directory);
    if (exact) {
      upsertInsurerLink(ctx, { partyId: p.party_id, insurerSlug: exact.entry.id, method: exact.method, confidence: exact.confidence }, LEARNER_ACTOR);
      out.linked.push({ partyId: p.party_id, insurerSlug: exact.entry.id, method: exact.method });
      continue;
    }
    // Sender domains of DMARC-pass inbound mail on this party's claims.
    const mail = all<{ from_addr: string | null; auth_json: string | null; spoof_suspect: number }>(
      ctx,
      `SELECT m.from_addr, m.auth_json, m.spoof_suspect FROM mail_messages m JOIN claims c ON c.id = m.claim_id WHERE c.at_fault_insurer_id = ? AND m.direction = 'in'`,
      p.party_id,
    );
    const slugs = new Set<string>();
    for (const m of mail) {
      const dmarc = String(json<{ dmarc?: string }>(m.auth_json)?.dmarc ?? '').toLowerCase();
      if (m.spoof_suspect || (dmarc !== 'pass' && dmarc !== 'bestguesspass') || !m.from_addr?.includes('@')) continue;
      const e = entryForDomain(ctx, m.from_addr.split('@').pop()!);
      if (e) slugs.add(e.id);
    }
    if (slugs.size === 1) {
      const slug = [...slugs][0]!;
      upsertInsurerLink(ctx, { partyId: p.party_id, insurerSlug: slug, method: 'email_domain', confidence: 0.9 }, LEARNER_ACTOR);
      out.linked.push({ partyId: p.party_id, insurerSlug: slug, method: 'email_domain' });
      continue;
    }
    out.unlinked += 1;
    if (opts.ask === false) continue;
    const words = fold(p.name).split(' ').filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
    const hits = [p.name, ...words].flatMap((q) => searchDirectory(q, directory).filter((h) => h.score >= 30).map((h) => h.entry.id));
    const candidates = [...new Set([...slugs, ...hits])].slice(0, 5);
    if (!candidates.length) continue;
    const dedupeKey = `${LINK_QUESTION_PREFIX}${p.party_id}`;
    if (ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, dedupeKey)) continue;
    const answered = all<{ id: string }>(ctx, `SELECT id FROM needs_you WHERE dedupe_key = ? LIMIT 1`, dedupeKey);
    if (answered.length) continue; // asked before: the owner can relink from Knowledge ▸ Insurers
    const ny = createNeedsYou(ctx, {
      kind: 'question',
      title: `Which insurer is “${p.name}”?`.slice(0, 200),
      summary: `ClaimDesk could not match the insurer “${p.name}” (${p.claims} claim${p.claims === 1 ? '' : 's'}) to the insurer directory. Choose the directory entry so its statistics and contacts are counted. You can change it later in Knowledge ▸ Insurers.`,
      options: [
        ...candidates.map((slug) => ({ id: `insurer:${slug}`, label: directory.find((d) => d.id === slug)?.name ?? slug, tone: 'neutral' as const })),
        { id: 'none', label: 'None of these', tone: 'neutral' as const },
      ],
      payload: { partyId: p.party_id, partyName: p.name, candidates, link: '/knowledge?tab=insurers' },
      priority: 'low',
      createdBy: LEARNER,
      dedupeKey,
    });
    out.asked.push(ny.id);
  }
  return out;
}
