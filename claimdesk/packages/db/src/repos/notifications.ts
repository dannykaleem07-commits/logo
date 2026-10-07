/**
 * In-app notifications and their channel deliveries (docs/SUPREME-DESIGN.md §J.1).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { notifications, type NotificationDelivery, type NotificationRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

export type { NotificationDelivery };

export interface NotificationRecord {
  id: string;
  needsYouId?: string;
  level: string;
  title: string;
  body: string;
  link?: string;
  channels: string[];
  deliveries: NotificationDelivery[];
  createdAt: ISODateTime;
  readAt?: ISODateTime;
}

export interface CreateNotificationInput {
  needsYouId?: string;
  level: string;
  title: string;
  body: string;
  link?: string;
  channels: string[];
  now?: ISODateTime;
}

const toNotification = (r: NotificationRow): NotificationRecord => denull(r) as NotificationRecord;

export function createNotification(db: Db, input: CreateNotificationInput): NotificationRecord {
  const row = {
    id: randomUUID(),
    needsYouId: input.needsYouId ?? null,
    level: input.level,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
    channels: input.channels,
    deliveries: [] as NotificationDelivery[],
    createdAt: input.now ?? nowIso(),
  };
  return toNotification(db.insert(notifications).values(row).returning().get());
}

export function getNotification(db: Db, id: string): NotificationRecord | undefined {
  const r = db.select().from(notifications).where(eq(notifications.id, id)).get();
  return r ? toNotification(r) : undefined;
}

export function listNotifications(db: Db, filter: { unreadOnly?: boolean; needsYouId?: string; limit?: number; offset?: number } = {}): NotificationRecord[] {
  const where: SQL[] = [];
  if (filter.unreadOnly) where.push(isNull(notifications.readAt));
  if (filter.needsYouId) where.push(eq(notifications.needsYouId, filter.needsYouId));
  return db
    .select()
    .from(notifications)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(notifications.createdAt), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 100, 1000)))
    .offset(filter.offset ?? 0)
    .all()
    .map(toNotification);
}

export function markNotificationRead(db: Db, id: string, at: ISODateTime = nowIso()): NotificationRecord {
  const r = db.update(notifications).set({ readAt: at }).where(eq(notifications.id, id)).returning().get();
  if (!r) throw new NotFoundError('notifications', id);
  return toNotification(r);
}

/** Record a delivery attempt on a channel (toast, sms, …). */
export function appendNotificationDelivery(db: Db, id: string, delivery: NotificationDelivery): NotificationRecord {
  const n = getNotification(db, id);
  if (!n) throw new NotFoundError('notifications', id);
  const r = db.update(notifications).set({ deliveries: [...n.deliveries, delivery] }).where(eq(notifications.id, id)).returning().get()!;
  return toNotification(r);
}
