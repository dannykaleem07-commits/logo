// owned by runtime
/**
 * Daily log routes (docs/SUPREME-DESIGN.md §J.2, §L.4, §N.6):
 *   GET  /daily-log?day=YYYY-MM-DD   the stored log; for a day with none stored yet, compiled now (not stored)
 *   GET  /daily-log/days             recent compiled days
 *   POST /daily-log/compile {day?}   compile and store now
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { isoDate, parse } from '../schemas/common.js';
import { compileAndStoreDailyLog, compileDailyLog, type DailyLog } from '../agent/dailyLog.js';
import { londonDay } from '../agent/core.js';

const dayQuery = z.object({ day: isoDate.optional() });
const compileBody = z.object({ day: isoDate.optional() }).optional();

export function registerDailyLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/daily-log', async (request) => {
    const q = parse(dayQuery, request.query);
    const day = q.day ?? londonDay(ctx.now());
    const stored = ctx.repos.getDailyLog(ctx.db, day);
    if (stored) return { day, stored: true, compiledAt: stored.compiledAt, log: stored.log as DailyLog };
    const log = compileDailyLog(ctx, day);
    return { day, stored: false, compiledAt: log.generatedAt, log };
  });

  app.get('/daily-log/days', async () => ({ items: ctx.repos.listDailyLogs(ctx.db, 60).map((d) => ({ day: d.day, compiledAt: d.compiledAt, headline: (d.log as DailyLog | null)?.headline ?? '' })) }));

  app.post('/daily-log/compile', async (request) => {
    const body = parse(compileBody, request.body ?? undefined);
    const day = body?.day ?? londonDay(ctx.now());
    const log = compileAndStoreDailyLog(ctx, day);
    return { day, stored: true, compiledAt: log.generatedAt, log };
  });
}
