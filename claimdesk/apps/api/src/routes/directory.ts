/**
 * Insurer directory (KB entries + human overrides, status ageing) and knowledge-base routes (search, advisor,
 * get-paid-faster ladder, GTA rates, court fees). Verification is data: only a human with a source URL verifies.
 */
import type { FastifyInstance } from 'fastify';
import type { KbEntryType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { directoryFailedBody, directoryQuery, directoryVerifyBody, gtaRatesQuery, kbAdviseQuery, kbSearchQuery } from '../schemas/services.js';
import { adviseTopic, filterDirectory, GET_PAID_FASTER, gtaRatesOn, kbEntries, loadCourtFees, loadDirectory, mergedDirectory, searchKb } from '../services/kb.js';
import { params } from './helpers.js';

export function registerDirectoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const today = () => ctx.now().slice(0, 10);
  const rows = () => mergedDirectory(ctx, ctx.repos.listDirectoryOverrides(ctx.db), today());
  const requireEntry = (id: string) => {
    const row = rows().find((e) => e.id === id);
    if (!row) throw notFound('directory entry', id);
    return row;
  };

  app.get('/directory', async (request) => {
    const q = parse(directoryQuery, request.query);
    let items = filterDirectory(rows(), q.q);
    if (q.status) items = items.filter((e) => e.directoryStatus === q.status);
    const limit = q.limit ?? 100;
    return { items: items.slice(0, limit), total: items.length, source: ctx.kb.dataDir ? 'packages/kb/data' : 'none', unverifiedWarning: 'Entries marked unverified/stale/failed must be confirmed on the insurer’s own site before use; copycat numbers are listed for recognition only.' };
  });

  app.get('/directory/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return { ...requireEntry(id), override: ctx.repos.getDirectoryOverride(ctx.db, id) ?? null };
  });

  app.patch('/directory/:id/verify', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireEntry(id);
    const body = parse(directoryVerifyBody, request.body);
    const actor = { userId: body.verifiedBy, ip: request.ip };
    const at = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.verifyDirectoryEntry(tx, id, actor, { sourceUrl: body.sourceUrl, sourceNote: [body.field ? `field: ${body.field}` : undefined, body.note, `verified via API by ${request.user.id}`].filter(Boolean).join('; '), verifiedAt: at.slice(0, 10) });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'directory.verify', entity: 'directory_overrides', entityId: id, after: { sourceUrl: body.sourceUrl, verifiedBy: body.verifiedBy, field: body.field }, at });
    });
    return requireEntry(id);
  });

  app.post('/directory/:id/report-failed', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireEntry(id);
    const body = parse(directoryFailedBody, request.body ?? {});
    const at = ctx.now();
    const note = [body.field ? `${body.field} failed` : 'contact failed', body.note, body.reportedBy ? `reported by ${body.reportedBy}` : undefined].filter(Boolean).join(' — ');
    ctx.db.transaction((tx) => {
      ctx.repos.reportDirectoryFailed(tx, id, request.actor, note, at.slice(0, 10));
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'directory.report_failed', entity: 'directory_overrides', entityId: id, after: { field: body.field, note: body.note }, at });
    });
    return requireEntry(id);
  });

  app.post('/directory/:id/used-ok', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireEntry(id);
    const at = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.reportDirectoryUsedOk(tx, id, request.actor, at.slice(0, 10));
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'directory.used_ok', entity: 'directory_overrides', entityId: id, at });
    });
    return requireEntry(id);
  });

  // ----- Knowledge base ---------------------------------------------------------
  app.get('/kb/search', async (request) => {
    const q = parse(kbSearchQuery, request.query);
    const hits = searchKb(kbEntries(ctx), q.q, { type: q.type as KbEntryType | undefined, topic: q.topic, limit: q.limit });
    return { items: hits.map((h) => ({ ...h.entry, score: h.score })), total: hits.length, query: q.q };
  });

  app.get('/kb/entries/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const e = kbEntries(ctx).find((x) => x.id === id);
    if (!e) throw notFound('kb entry', id);
    return e;
  });

  app.get('/kb/advise', async (request) => {
    const q = parse(kbAdviseQuery, request.query);
    return adviseTopic(ctx, q.topic);
  });

  app.get('/kb/get-paid-faster', async () => {
    const rules = ctx.kb.playbookRules();
    return { items: rules.length ? rules : GET_PAID_FASTER, source: rules.length ? 'packages/kb/data/playbook-rules.json' : 'built-in', basis: 'BLUEPRINT §7 — every step cites its basis; GTA references are an industry benchmark (CCGUK is not a subscriber).' };
  });

  app.get('/kb/gta-rates', async (request) => {
    const q = parse(gtaRatesQuery, request.query);
    const r = gtaRatesOn(ctx, q.date ?? today(), q.group);
    return { ...r, items: r.items };
  });

  app.get('/kb/court-fees', async () => ({ items: loadCourtFees(ctx) }));

  app.get('/kb/directory-raw', async () => ({ items: loadDirectory(ctx) }));
}
