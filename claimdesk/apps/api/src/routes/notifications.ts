// owned by runtime
/**
 * Notification routes (docs/SUPREME-DESIGN.md §J.1, §L.7, §N.6):
 *   GET  /notifications?unread=1          in-app notifications (newest first)
 *   POST /notifications/:id/read
 *   POST /notifications/test              a test notification, delivered now (toast on Windows)
 *   GET  /settings/notifications, PATCH /settings/notifications (admin/approver; audited 'notifications.settings')
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params, requireRole } from './helpers.js';
import { dispatch, notifyOwner, type DispatchOptions } from '../notify/index.js';
import { isHhmm, updateSchedule } from '../agent/scheduler.js';

const listQuery = z.object({ unread: z.enum(['0', '1', 'true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

const settingsPatch = z
  .object({
    toasts: z.boolean(),
    toastMinPriority: z.enum(['urgent', 'high', 'normal', 'low']),
    quietHoursSuppressToasts: z.boolean(),
    dailyLogAt: z.string().refine(isHhmm, 'expected HH:MM'),
    dailyLogEmail: z.boolean(),
    sms: z.object({ enabled: z.boolean(), to: z.string().max(32).nullable(), maxPerDay: z.number().int().min(0).max(50) }).partial().strict(),
  })
  .partial()
  .strict();

/** The public shape of a notification (internal channel metadata stripped). */
export function publicNotification(n: NotificationRecord) {
  return { ...n, channels: n.channels.filter((c) => !c.includes(':')) };
}

const dispatchOptions = (ctx: AppContext): DispatchOptions => ((ctx.services as { notify?: DispatchOptions }).notify ?? {});

export function registerNotificationsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/notifications', async (request) => {
    const q = parse(listQuery, request.query);
    const unreadOnly = q.unread === '1' || q.unread === 'true';
    const items = ctx.repos.listNotifications(ctx.db, { unreadOnly, limit: q.limit ?? 100 }).map(publicNotification);
    const unread = ctx.repos.listNotifications(ctx.db, { unreadOnly: true, limit: 1000 }).length;
    return { items, unread };
  });

  app.post('/notifications/:id/read', async (request) => {
    const { id } = params<{ id: string }>(request);
    if (!ctx.repos.getNotification(ctx.db, id)) throw notFound('notifications', id);
    return publicNotification(ctx.repos.markNotificationRead(ctx.db, id, ctx.now()));
  });

  app.post('/notifications/test', async (request) => {
    const n = notifyOwner(ctx, { level: 'normal', kind: 'test', title: 'Test notification', body: 'This is a test notification from ClaimDesk.', link: '/settings/notifications', toastTitle: 'ClaimDesk', toastBody: 'Test notification — pop-ups are working.' });
    const result = await dispatch(ctx, n.id, dispatchOptions(ctx));
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'notifications.test', entity: 'notifications', entityId: n.id, after: result, at: ctx.now() });
    return { notification: publicNotification(ctx.repos.getNotification(ctx.db, n.id) ?? n), result, platform: process.platform };
  });

  app.get('/settings/notifications', async () => ({ settings: ctx.repos.getAgentSettings(ctx.db).notifications, smsAvailable: false }));

  app.patch('/settings/notifications', async (request) => {
    requireRole(request);
    const body = parse(settingsPatch, request.body);
    const next = ctx.repos.patchAgentSettings(ctx.db, { notifications: body }, request.actor, ctx.now());
    if (body.dailyLogAt) updateSchedule(ctx, 'dailylog.compile', { atLocal: body.dailyLogAt });
    return { settings: next.notifications, smsAvailable: false };
  });
}
