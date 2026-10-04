/**
 * Settings → GTA benchmark rates (TEMPLATES-VEHICLES-DESKTOP §F.3): manual rows that replace, hide or add to the KB rate
 * table, and the segment → group starting suggestions.
 *
 * GTA rates are an industry benchmark only — Courtesy Cars Group UK Ltd is not a GTA subscriber. Verification rule
 * (server side): `verified` needs an https source URL; the server stamps `verifiedBy` (session user) and `verifiedAt`
 * (today); anything the client sends for those is ignored. KB rows are never changed.
 */
import type { FastifyInstance } from 'fastify';
import { GTA_NON_SUBSCRIBER_NOTE, gtaRateKey, londonDate, type GtaRate, type MergedGtaRate, type Verification } from '@ccguk/domain';
import type { GtaRateRecord } from '@ccguk/db';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isoDate, parse } from '../schemas/common.js';
import { CATALOGUE_SEGMENTS, kbGtaRates, kbSegmentDefaults, SEGMENT_LABELS } from '../services/kb.js';
import { params } from './helpers.js';

const GROUP = /^[A-Z]{1,3}\d{0,2}$/;
const PERIOD = /^\d{4}-\d{2}$/;

const groupCode = z
  .string()
  .trim()
  .transform((g) => g.toUpperCase())
  .pipe(z.string().regex(GROUP, 'GTA group must look like S1, M, M1 or CP2'));

const rateBody = z
  .object({
    group: groupCode,
    description: z.string().trim().max(300).optional(),
    dailyRatePence: z.number().int('pence must be a whole number').positive('the daily rate must be more than 0'),
    period: z.string().trim().regex(PERIOD, 'period must look like 2026-27'),
    effectiveFrom: isoDate,
    effectiveTo: isoDate,
    // verifiedBy / verifiedAt are deliberately not read: the server sets them.
    verification: z
      .object({
        status: z.enum(['unverified', 'verified']),
        sourceUrl: z.string().trim().max(2000).optional(),
        sourceNote: z.string().trim().max(2000).optional(),
      })
      .optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.effectiveFrom <= b.effectiveTo, { message: 'effectiveFrom must be on or before effectiveTo', path: ['effectiveTo'] });

const suppressBody = z.object({ group: groupCode, period: z.string().trim().regex(PERIOD, 'period must look like 2026-27'), suppressed: z.boolean() });
const segmentBody = z.object({ group: groupCode });

export type GtaRateListItem = MergedGtaRate & { kbRate?: GtaRate; suppressed?: boolean; note?: string };

/** Every row the settings page shows: KB rows, overrides (with the KB row they replace), hidden rows, manual-only rows. */
export function gtaRateListing(kb: GtaRate[], manual: GtaRateRecord[]): GtaRateListItem[] {
  const byKey = new Map(manual.map((m) => [gtaRateKey(m.group, m.period), m] as const));
  const used = new Set<string>();
  const fromManual = (m: GtaRateRecord, kbRow?: GtaRate): GtaRateListItem => {
    const item: GtaRateListItem = {
      group: m.group,
      dailyRatePence: m.dailyRatePence ?? kbRow?.dailyRatePence ?? 0,
      period: m.period,
      effectiveFrom: m.effectiveFrom,
      effectiveTo: m.effectiveTo,
      verification: m.dailyRatePence !== undefined ? m.verification : (kbRow?.verification ?? m.verification),
      origin: m.dailyRatePence !== undefined ? 'manual' : 'kb',
      id: m.id,
      overridesKb: Boolean(kbRow) && m.dailyRatePence !== undefined,
      suppressed: m.suppressed,
    };
    const description = m.description ?? kbRow?.description;
    if (description !== undefined) item.description = description;
    if (kbRow) item.kbRate = kbRow;
    if (m.note) item.note = m.note;
    return item;
  };
  const items: GtaRateListItem[] = [];
  for (const r of kb) {
    const key = gtaRateKey(r.group, r.period);
    const m = byKey.get(key);
    if (!m) {
      items.push({ ...r, origin: 'kb' });
      continue;
    }
    used.add(key);
    items.push(fromManual(m, r));
  }
  for (const m of manual) if (!used.has(gtaRateKey(m.group, m.period))) items.push(fromManual(m));
  return items.sort((a, b) => a.group.localeCompare(b.group) || a.effectiveFrom.localeCompare(b.effectiveFrom));
}

export function registerGtaRatesRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Apply the server-side verification rule. Client-sent verifiedBy/verifiedAt never reach here (stripped by zod). */
  const verificationFor = (v: z.infer<typeof rateBody>['verification'], userId: string): Verification => {
    const sourceUrl = v?.sourceUrl?.trim() || undefined;
    const sourceNote = v?.sourceNote?.trim() || undefined;
    if (v?.status === 'verified') {
      if (!sourceUrl || !/^https:\/\/\S+$/i.test(sourceUrl)) throw badRequest('A verified GTA rate needs the https:// address of the page or file it was checked against', { code: 'VERIFICATION_SOURCE_REQUIRED' });
      return { status: 'verified', sourceUrl, ...(sourceNote ? { sourceNote } : {}), verifiedBy: userId, verifiedAt: londonDate(ctx.now()) };
    }
    if (sourceUrl && !/^https?:\/\/\S+$/i.test(sourceUrl)) throw badRequest('sourceUrl must be an http(s) address');
    return { status: 'unverified', ...(sourceUrl ? { sourceUrl } : {}), ...(sourceNote ? { sourceNote } : {}) };
  };

  app.get('/settings/gta-rates', async () => ({ items: gtaRateListing(kbGtaRates(ctx), ctx.repos.listGtaRates(ctx.db)), note: GTA_NON_SUBSCRIBER_NOTE }));

  app.post('/settings/gta-rates', async (request, reply) => {
    const body = parse(rateBody, request.body);
    if (ctx.repos.findGtaRate(ctx.db, body.group, body.period)) throw conflict('GTA_RATE_EXISTS', `A rate for group ${body.group} and period ${body.period} already exists — edit that row instead`);
    const verification = verificationFor(body.verification, request.user.id);
    const now = ctx.now();
    const row = ctx.db.transaction((tx) => {
      const r = ctx.repos.createGtaRate(tx, { ...body, verification }, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_rate.create', entity: 'gta_rates', entityId: r.id, after: r, at: now });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.put('/settings/gta-rates/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(rateBody, request.body);
    const before = ctx.repos.getGtaRate(ctx.db, id);
    if (!before) throw notFound('gta rate', id);
    const clash = ctx.repos.findGtaRate(ctx.db, body.group, body.period);
    if (clash && clash.id !== id) throw conflict('GTA_RATE_EXISTS', `A rate for group ${body.group} and period ${body.period} already exists`);
    const verification = verificationFor(body.verification, request.user.id);
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const r = ctx.repos.updateGtaRate(tx, id, { ...body, verification }, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_rate.update', entity: 'gta_rates', entityId: id, before, after: r, at: now });
      return r;
    });
  });

  app.delete('/settings/gta-rates/:id', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const before = ctx.repos.getGtaRate(ctx.db, id);
    if (!before) throw notFound('gta rate', id);
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.deleteGtaRate(tx, id);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_rate.delete', entity: 'gta_rates', entityId: id, before, at: now });
    });
    return reply.status(204).send();
  });

  /** Hide (or show again) the KB row for a group and period. Answers with the row as the settings list shows it. */
  app.post('/settings/gta-rates/suppress', async (request) => {
    const body = parse(suppressBody, request.body);
    const kb = kbGtaRates(ctx);
    const kbRow = kb.find((r) => gtaRateKey(r.group, r.period) === gtaRateKey(body.group, body.period));
    const existing = ctx.repos.findGtaRate(ctx.db, body.group, body.period);
    if (!kbRow && !existing) throw notFound('gta rate', `${body.group} ${body.period}`);
    const now = ctx.now();
    const stored = ctx.db.transaction((tx) => {
      const r = ctx.repos.setGtaRateSuppressed(tx, body, request.actor, kbRow ? { effectiveFrom: kbRow.effectiveFrom, effectiveTo: kbRow.effectiveTo, ...(kbRow.description ? { description: kbRow.description } : {}) } : undefined);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_rate.suppress', entity: 'gta_rates', entityId: r?.id ?? existing?.id ?? `${body.group}:${body.period}`, before: existing ?? null, after: { group: body.group, period: body.period, suppressed: body.suppressed }, at: now });
      return r;
    });
    const listing = gtaRateListing(kb, ctx.repos.listGtaRates(ctx.db));
    return listing.find((i) => gtaRateKey(i.group, i.period) === gtaRateKey(body.group, body.period)) ?? stored;
  });

  const segmentItems = () => {
    const kb = kbSegmentDefaults(ctx);
    const db = new Map(ctx.repos.listGtaSegmentDefaults(ctx.db).map((r) => [r.segment, r] as const));
    return CATALOGUE_SEGMENTS.map((segment) => {
      const mine = db.get(segment);
      return { segment, label: SEGMENT_LABELS[segment], group: mine?.group ?? kb[segment] ?? '', origin: mine ? ('manual' as const) : ('kb' as const), ...(kb[segment] ? { kbGroup: kb[segment] } : {}) };
    });
  };
  const requireSegment = (segment: string): (typeof CATALOGUE_SEGMENTS)[number] => {
    if (!(CATALOGUE_SEGMENTS as readonly string[]).includes(segment)) throw notFound('segment', segment);
    return segment as (typeof CATALOGUE_SEGMENTS)[number];
  };

  app.get('/settings/gta-segments', async () => ({ items: segmentItems(), note: GTA_NON_SUBSCRIBER_NOTE }));

  app.put('/settings/gta-segments/:segment', async (request) => {
    const segment = requireSegment(params<{ segment: string }>(request).segment);
    const body = parse(segmentBody, request.body);
    const before = ctx.repos.listGtaSegmentDefaults(ctx.db).find((r) => r.segment === segment);
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.setGtaSegmentDefault(tx, segment, body.group, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_segment.update', entity: 'gta_segment_defaults', entityId: segment, before: before ?? null, after: { segment, group: body.group }, at: now });
    });
    return segmentItems().find((i) => i.segment === segment);
  });

  app.delete('/settings/gta-segments/:segment', async (request, reply) => {
    const segment = requireSegment(params<{ segment: string }>(request).segment);
    const before = ctx.repos.listGtaSegmentDefaults(ctx.db).find((r) => r.segment === segment);
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      if (ctx.repos.deleteGtaSegmentDefault(tx, segment)) {
        ctx.repos.appendAudit(tx, { actor: request.actor, action: 'gta_segment.reset', entity: 'gta_segment_defaults', entityId: segment, before: before ?? null, at: now });
      }
    });
    return reply.status(204).send();
  });
}
