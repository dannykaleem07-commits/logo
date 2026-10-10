// owned by casework
/**
 * Brain packs and memory (docs/SUPREME-DESIGN.md §E.5, §E.6, §L.10, §N.6 casework row). People only: no agent tool
 * declares these routes, so the perimeter refuses run tokens (§B.2 rule 1).
 *
 *   GET  /brain/packs                         packs (precedence order) with versions, the active preview and staged files
 *   POST /brain/packs/import                  {importId} | {uploadId} | {path} — admin only; `path` is a full local path
 *                                             the owner typed (a .ccbrain file, a pack folder or a skill folder)
 *   GET  /brain/packs/:id/versions/:version   preview of a stored version
 *   POST /brain/packs/:id/activate            {version?, business?, precedence?, useForCcguk?} — admin only (rollback =
 *                                             activate an older version)
 *   POST /brain/packs/:id/deactivate          admin only
 *   GET  /brain/search?q=&packs=&kinds=&business=   test retrieval
 *   GET  /memory?status=&scope=&kind=         memory items (default: proposed, awaiting approval)
 *   POST /memory/:id/approve | /memory/:id/retire
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MemoryKind, MemoryStatus } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params, requireRole } from './helpers.js';
import { activatePack, BUSINESSES, deactivatePack, importPack, storedPreview } from '../brain/packs.js';
import { brainSearch } from '../brain/search.js';
import { decideMemory } from '../brain/memory.js';
import { getStagedImport, listStagedImports, markImportConsumed, markImportFailed, stagedImportPath } from '../services/imports.js';
import { uploadsRoot } from '../services/uploads.js';

const ADMIN = ['admin'] as const;

function humanOnly(request: FastifyRequest): void {
  const id = request.actor?.userId ?? '';
  if (request.agent || id === 'system' || id.startsWith('agent:')) throw new HttpError(403, 'HUMAN_REQUIRED', 'Only a signed-in person can do this.');
}

const importBody = z.union([
  z.object({ importId: z.string().min(1).max(128) }).strict(),
  z.object({ uploadId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/) }).strict(),
  z.object({ path: z.string().min(3).max(1024) }).strict(),
]);

const activateBody = z
  .object({
    version: z.string().min(1).max(64).optional(),
    business: z.array(z.enum(BUSINESSES)).min(1).max(2).optional(),
    precedence: z.number().int().min(0).max(1000).optional(),
    useForCcguk: z.boolean().optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  packs: z.string().max(1000).optional(),
  kinds: z.string().max(500).optional(),
  business: z.enum(BUSINESSES).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const memoryQuery = z.object({
  status: z.enum(['proposed', 'approved', 'retired', 'all']).optional(),
  scope: z.string().max(200).optional(),
  kind: z.enum(['note', 'correction', 'outcome', 'preference', 'research']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** The staged import a finished chunked upload produced. */
function importIdOfUpload(ctx: AppContext, uploadId: string): string {
  const file = path.join(uploadsRoot(ctx), uploadId, 'session.json');
  if (!existsSync(file)) throw new HttpError(404, 'NOT_FOUND', `upload ${uploadId} not found`);
  const s = JSON.parse(readFileSync(file, 'utf8')) as { status?: string; purpose?: string; result?: { importId?: string } };
  if (s.status !== 'complete' || !s.result?.importId) throw conflict('UPLOAD_INCOMPLETE', 'Finish the upload first');
  return s.result.importId;
}

export function listPacksResponse(ctx: AppContext) {
  const packs = ctx.repos.listBrainPacks(ctx.db).map((p) => {
    const versions = ctx.repos.listBrainPackVersions(ctx.db, p.id).map((v) => ({ version: v.version, sha256: v.sha256, entries: v.entries, source: v.source, importedAt: v.importedAt, importedBy: v.importedBy }));
    return { ...p, versions, preview: p.activeVersion ? storedPreview(ctx, p.id, p.activeVersion) : versions[0] ? storedPreview(ctx, p.id, versions[0].version) : null };
  });
  let staged: ReturnType<typeof listStagedImports> = [];
  try {
    staged = listStagedImports(ctx, { purpose: 'brain-packs' }).filter((i) => i.status !== 'consumed');
  } catch {
    staged = [];
  }
  return { packs, staged };
}

export function registerBrainRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/brain/packs', async () => listPacksResponse(ctx));

  app.post('/brain/packs/import', async (request, reply) => {
    humanOnly(request);
    requireRole(request, ADMIN);
    const body = parse(importBody, request.body ?? {});
    let result;
    if ('path' in body) {
      if (!path.isAbsolute(body.path)) throw badRequest('Type the full path of the pack on this PC (for example C:\\Users\\you\\Documents\\danny-brain)');
      result = importPack(ctx, { kind: 'path', path: body.path, source: 'path' }, request.actor);
    } else {
      const importId = 'importId' in body ? body.importId : importIdOfUpload(ctx, body.uploadId);
      const imp = getStagedImport(ctx, importId);
      if (!imp) throw new HttpError(404, 'NOT_FOUND', `import ${importId} not found`);
      if (imp.purpose !== 'brain-packs') throw badRequest(`That file was imported as ${imp.purpose}, not as a brain pack`);
      try {
        result = importPack(ctx, { kind: 'bytes', filename: imp.filename, bytes: new Uint8Array(readFileSync(stagedImportPath(ctx, imp.id))), source: `import:${imp.id}` }, request.actor);
      } catch (err) {
        if (imp.status === 'staged') markImportFailed(ctx, imp.id, err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (imp.status !== 'consumed') markImportConsumed(ctx, imp.id, 'brain', { packId: result.pack.id, version: result.version.version, duplicate: result.duplicate });
    }
    reply.code(result.duplicate ? 200 : 201);
    return result;
  });

  app.get('/brain/packs/:id/versions/:version', async (request) => {
    const { id, version } = params<{ id: string; version: string }>(request);
    return storedPreview(ctx, id, version);
  });

  app.post('/brain/packs/:id/activate', async (request) => {
    humanOnly(request);
    requireRole(request, ADMIN);
    const { id } = params<{ id: string }>(request);
    const body = parse(activateBody, request.body ?? {});
    return activatePack(ctx, id, body, request.actor);
  });

  app.post('/brain/packs/:id/deactivate', async (request) => {
    humanOnly(request);
    requireRole(request, ADMIN);
    const { id } = params<{ id: string }>(request);
    return deactivatePack(ctx, id, request.actor);
  });

  app.get('/brain/search', async (request) => {
    const q = parse(searchQuery, request.query);
    const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);
    return { hits: brainSearch(ctx, { q: q.q, packs: list(q.packs), kinds: list(q.kinds), business: q.business ?? 'ccguk', limit: q.limit ?? 10 }) };
  });

  app.get('/memory', async (request) => {
    const q = parse(memoryQuery, request.query);
    const status: MemoryStatus | undefined = q.status === 'all' ? undefined : (q.status ?? 'proposed');
    const items = ctx.repos.listMemoryItems(ctx.db, { ...(status ? { status } : {}), ...(q.scope ? { scope: q.scope } : {}), ...(q.kind ? { kind: q.kind as MemoryKind } : {}), limit: q.limit ?? 200 });
    return { items, counts: { proposed: ctx.repos.countMemoryItems(ctx.db, { status: 'proposed' }), approved: ctx.repos.countMemoryItems(ctx.db, { status: 'approved' }) } };
  });

  for (const action of ['approve', 'retire'] as const) {
    app.post(`/memory/:id/${action}`, async (request) => {
      humanOnly(request);
      const { id } = params<{ id: string }>(request);
      return decideMemory(ctx, id, action === 'approve' ? 'approved' : 'retired', request.actor);
    });
  }
}
