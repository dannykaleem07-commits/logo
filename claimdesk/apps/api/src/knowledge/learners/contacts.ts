// owned by knowledge-learners
/**
 * L4 contacts from email signatures (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.2).
 *
 *   observeMailContacts  (knowledge.observe source `mail`) inbound mail on a claim whose insurer is known → the
 *                        signature is parsed → one `contact_observations` row per (message, signature). A copycat
 *                        phone or domain is never a contact: it is stored with domain_check 'copycat' and raises a
 *                        Needs-you `spoof_warning` (payment-diversion risk).
 *   consolidateContacts  (knowledge.consolidate) at least `thresholds.contactObservations` observations from
 *                        independent threads, own domain, DMARC pass, that agree → a `contact` item (internal,
 *                        unverified; KN-15 auto-applies it). Anything less waits as observations. A difference from
 *                        the directory becomes a directory_mismatch conflict (conflictsFor) and is queued.
 */
import { createHash } from 'node:crypto';
import { isCopycat } from '@ccguk/kb';
import { classifySender, extractSignature, itemKeyFor, normaliseSenderDomain, parseSignature, type ContactData, type KnowledgeProposal, type ParsedContact } from '@ccguk/domain';
import type { ContactObservationRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { createNeedsYou } from '../../agent/core.js';
import { getKnowledgeSettings } from '../settings.js';
import { proposeKnowledge } from '../store.js';
import { LEARNER, advanceWatermark, all, directoryEntry, entryForDomain, insurerSlugsByClaim, json, ownDomainsOf, watermark } from './common.js';

const PHONE_PREFERENCE: Record<string, number> = { direct: 0, mobile: 1, team: 2, switchboard: 3, null: 4 };

const dmarcOf = (auth: unknown): ContactObservationRecord['dmarc'] => {
  const d = String((auth as { dmarc?: unknown } | null)?.dmarc ?? '').toLowerCase();
  if (d === 'pass' || d === 'bestguesspass') return 'pass';
  if (d === 'fail' || d === 'softfail' || d === 'permerror') return 'fail';
  if (d === 'none') return 'none';
  return 'unknown';
};

function bestPhone(c: ParsedContact): ParsedContact['phones'][number] | null {
  return [...c.phones].sort((a, b) => (PHONE_PREFERENCE[String(a.kind)] ?? 4) - (PHONE_PREFERENCE[String(b.kind)] ?? 4))[0] ?? null;
}

export interface ObserveMailResult {
  scanned: number;
  observations: number;
  copycats: number;
  spoofWarnings: string[];
}

export function observeMailContacts(ctx: AppContext, opts: { limit?: number } = {}): ObserveMailResult {
  const w = watermark(ctx, 'mail');
  const rows = all<{ id: string; created_at: string; thread_key: string; claim_id: string; from_addr: string | null; body_text: string | null; auth_json: string | null; spoof_suspect: number; received_at: string; subject: string | null }>(
    ctx,
    `SELECT id, created_at, thread_key, claim_id, from_addr, body_text, auth_json, spoof_suspect, received_at, subject FROM mail_messages
      WHERE direction = 'in' AND claim_id IS NOT NULL AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?`,
    w.lastAt,
    w.lastAt,
    w.lastId ?? '',
    Math.max(1, Math.min(opts.limit ?? 2000, 20_000)),
  );
  const out: ObserveMailResult = { scanned: 0, observations: 0, copycats: 0, spoofWarnings: [] };
  if (!rows.length) return out;
  const slugs = insurerSlugsByClaim(ctx);
  const now = ctx.now();
  for (const m of rows) {
    out.scanned += 1;
    const fromDomain = m.from_addr?.includes('@') ? normaliseSenderDomain(m.from_addr.split('@').pop()!) : '';
    const block = m.body_text ? extractSignature(m.body_text) : null;
    if (!fromDomain || !block) continue;
    const parsed = parseSignature(block);
    if (!parsed.name && !parsed.phones.length && !parsed.emails.length && !parsed.ivr) continue;
    const linked = slugs.get(m.claim_id) ?? null;
    const entry = directoryEntry(ctx, linked) ?? entryForDomain(ctx, fromDomain);
    const auth = json<{ dmarc?: string }>(m.auth_json);
    const dmarc = dmarcOf(auth);
    let domainCheck = classifySender(fromDomain, auth ? { dmarc: String(auth.dmarc ?? '') } : null, Boolean(m.spoof_suspect), entry ? { ownDomains: ownDomainsOf(ctx, entry), copycatDomains: entry.copycatDomains } : null);
    // isCopycat over every phone, every email domain and the sender (any insurer's blacklist).
    const probes = [fromDomain, ...parsed.emails.map((e) => e.split('@').pop()!), ...parsed.phones.map((p) => p.norm)];
    const copy = probes.map((x) => isCopycat(x, ctx.kb.directory())).find(Boolean);
    if (copy) domainCheck = 'copycat';
    const phone = bestPhone(parsed);
    const ownEmail = parsed.emails.find((e) => normaliseSenderDomain(e.split('@').pop()!) === fromDomain) ?? parsed.emails[0] ?? null;
    const signatureSha = createHash('sha256').update(block.lines.join('\n')).digest('hex');
    const { created } = ctx.repos.insertContactObservation(ctx.db, {
      mailMessageId: m.id,
      threadKey: m.thread_key,
      insurerSlug: entry?.id ?? linked,
      fromDomain,
      dmarc,
      domainCheck,
      name: parsed.name,
      role: parsed.role,
      phoneNorm: phone?.norm ?? null,
      phoneKind: phone?.kind ?? null,
      email: ownEmail,
      ivrText: parsed.ivr,
      hoursText: parsed.hours,
      copycat: copy ? `${copy.kind}:${copy.pattern}` : null,
      signatureSha256: signatureSha,
      observedAt: m.received_at,
      createdAt: now,
    });
    if (created) out.observations += 1;
    if (copy && created) {
      out.copycats += 1;
      const ny = createNeedsYou(ctx, {
        kind: 'spoof_warning',
        claimId: m.claim_id,
        title: `Copycat contact details in an email: ${m.subject ?? '(no subject)'}`.slice(0, 200),
        summary: `The email signature contains ${copy.kind === 'domain' ? 'a domain' : 'a phone number'} (${copy.input}) on ${copy.name}'s copycat blacklist (${copy.pattern}). This is a payment-diversion risk: ClaimDesk did not learn it as a contact. Never pay, call or email it — use the number in the insurer directory.`,
        options: [{ id: 'keep', label: 'Understood — never use it', tone: 'primary' }],
        payload: { messageId: m.id, from: m.from_addr, subject: m.subject, reason: `copycat ${copy.kind} ${copy.input} (${copy.pattern})`, source: 'knowledge.observe' },
        priority: 'urgent',
        createdBy: LEARNER,
        dedupeKey: `spoof_warning:knowledge:${m.id}`,
      });
      out.spoofWarnings.push(ny.id);
    }
  }
  const last = rows[rows.length - 1]!;
  advanceWatermark(ctx, 'mail', last.created_at, last.id);
  return out;
}

// ---------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------

const identityOf = (o: ContactObservationRecord): string | null => (o.email ? `email:${o.email.toLowerCase()}` : o.phoneNorm ? `phone:${o.phoneNorm}` : o.name ? `name:${o.name.toLowerCase()}` : null);

/** The value seen in the most independent threads, if at least `min` threads agree on it. */
function agreed<T extends string | null>(obs: readonly ContactObservationRecord[], pick: (o: ContactObservationRecord) => T, min: number): T | null {
  const threads = new Map<string, Set<string>>();
  for (const o of obs) {
    const v = pick(o);
    if (v === null || v === undefined || v === '') continue;
    const set = threads.get(v) ?? new Set<string>();
    set.add(o.threadKey ?? o.mailMessageId);
    threads.set(v, set);
  }
  const best = [...threads.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0];
  return best && best[1].size >= min ? (best[0] as T) : null;
}

const IDENTITY_FIELDS: readonly (keyof ContactData)[] = ['insurerSlug', 'team', 'name', 'role', 'phone', 'phoneKind', 'email', 'ivr', 'hours'];

export interface ConsolidateResult {
  groups: number;
  proposed: { itemId: string; outcome: string }[];
  waiting: number;
}

export function consolidateContacts(ctx: AppContext): ConsolidateResult {
  const settings = getKnowledgeSettings(ctx);
  const min = settings.thresholds.contactObservations;
  const out: ConsolidateResult = { groups: 0, proposed: [], waiting: 0 };
  const trusted = ctx.repos.listContactObservations(ctx.db, { domainCheck: 'own_domain', limit: 50_000 }).filter((o) => o.dmarc === 'pass' && o.insurerSlug && !o.copycat);
  const groups = new Map<string, ContactObservationRecord[]>();
  for (const o of trusted) {
    const id = identityOf(o);
    if (!id) continue;
    const key = `${o.insurerSlug}|${id}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  for (const [key, obs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.groups += 1;
    const threads = new Set(obs.map((o) => o.threadKey ?? o.mailMessageId));
    if (threads.size < min) {
      out.waiting += 1;
      continue;
    }
    const slug = key.split('|')[0]!;
    const phone = agreed(obs, (o) => o.phoneNorm, min);
    const data: ContactData = {
      insurerSlug: slug,
      team: null,
      name: agreed(obs, (o) => o.name, min),
      role: agreed(obs, (o) => o.role, min),
      phone,
      phoneKind: phone ? ((agreed(obs.filter((o) => o.phoneNorm === phone), (o) => o.phoneKind, min) as ContactData['phoneKind']) ?? null) : null,
      email: agreed(obs, (o) => o.email, min),
      ivr: agreed(obs, (o) => o.ivrText, min),
      hours: agreed(obs, (o) => o.hoursText, min),
      observations: obs.length,
      independentThreads: threads.size,
      lastSeenAt: obs.map((o) => o.observedAt).sort().at(-1)!,
    };
    if (!data.name && !data.phone && !data.email && !data.ivr) {
      out.waiting += 1;
      continue;
    }
    const proposal: KnowledgeProposal<ContactData> = {
      kind: 'contact',
      area: 'contact',
      title: `${data.name ?? data.email ?? data.phone ?? 'Contact'} — ${directoryEntry(ctx, slug)?.name ?? slug}`.slice(0, 200),
      body: [
        data.name ? `${data.name}${data.role ? `, ${data.role}` : ''}` : null,
        data.phone ? `Phone ${data.phone}${data.phoneKind ? ` (${data.phoneKind})` : ''}` : null,
        data.email ? `Email ${data.email}` : null,
        data.ivr ? `Phone menu: ${data.ivr}` : null,
        data.hours ? `Hours: ${data.hours}` : null,
        `Learned from ${threads.size} separate email threads from the insurer's own domain (DMARC pass). Sending to a new address still asks.`,
      ]
        .filter(Boolean)
        .join('. '),
      data,
      tags: ['learned_contact'],
      scope: { kind: 'insurer', slug },
      business: ['ccguk'],
      useLimit: 'internal',
      origin: 'observed',
      confidence: 0.9,
      supportN: threads.size,
      provenance: obs.slice(-5).map((o) => ({ kind: 'email' as const, mailMessageId: o.mailMessageId, fromDomain: o.fromDomain, dmarc: o.dmarc, observedAt: o.observedAt })),
      createdBy: LEARNER,
    };
    // Only a change of the contact itself makes a new version (counts and dates do not).
    // A rejected identical contact is never re-proposed either.
    const latest = ctx.repos.latestKnowledgeVersion(ctx.db, itemKeyFor(proposal));
    if (latest && IDENTITY_FIELDS.every((f) => JSON.stringify((latest.data as unknown as ContactData)[f] ?? null) === JSON.stringify(data[f] ?? null))) continue;
    const r = proposeKnowledge(ctx, proposal, { contact: { domainCheck: 'own_domain', dmarc: 'pass', independentThreads: threads.size } });
    if (r.created) out.proposed.push({ itemId: r.item.id, outcome: r.decision.outcome });
  }
  return out;
}

export type { ContactObservationRecord };
