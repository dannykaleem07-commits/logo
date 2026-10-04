import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { createSession, deleteExpiredSessions, deleteSession, deleteUserSessions, getSessionByTokenHash, listUserSessions, touchSession } from './sessions.js';
import { createUser, getPasswordHash, getUser, getUserByUsername, listUsers, setPassword, updateUser } from './users.js';

const HASH = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaA==';
const tokenHash = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex');

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('users — sign-in fields', () => {
  it('stores the username trimmed and lower-cased and finds it case-insensitively', () => {
    const u = createUser(h.db, { id: 'courtesycars', name: 'Courtesy Cars', email: 'Claims@CourtesyCars.net', role: 'admin', username: '  CourtesyCars ', passwordHash: HASH });
    expect(u).toMatchObject({ id: 'courtesycars', username: 'courtesycars', email: 'claims@courtesycars.net' });
    expect(getUserByUsername(h.db, 'COURTESYCARS')?.id).toBe('courtesycars');
    expect(getUserByUsername(h.db, ' courtesycars  ')?.id).toBe('courtesycars');
    expect(getUserByUsername(h.db, 'someone-else')).toBeUndefined();
    expect(getUserByUsername(h.db, '   ')).toBeUndefined();
  });

  it('enforces a case-insensitive unique username but allows many users without one', () => {
    createUser(h.db, { name: 'A', email: 'a@x.test', role: 'handler', username: 'Alpha' });
    expect(() => createUser(h.db, { name: 'B', email: 'b@x.test', role: 'handler', username: 'ALPHA' })).toThrow(/UNIQUE/);
    createUser(h.db, { name: 'C', email: 'c@x.test', role: 'handler' });
    createUser(h.db, { name: 'D', email: 'd@x.test', role: 'handler' });
    expect(listUsers(h.db)).toHaveLength(3);
  });

  it('never returns the password hash on a user record; getPasswordHash reads it for sign-in only', () => {
    createUser(h.db, { id: 'u1', name: 'U', email: 'u@x.test', role: 'admin', username: 'u1', passwordHash: HASH });
    for (const rec of [getUser(h.db, 'u1'), getUserByUsername(h.db, 'u1'), listUsers(h.db)[0]]) {
      expect(rec).toBeDefined();
      expect(JSON.stringify(rec)).not.toContain('scrypt');
      expect(rec).not.toHaveProperty('passwordHash');
    }
    expect(getPasswordHash(h.db, 'u1')).toBe(HASH);
    createUser(h.db, { id: 'u2', name: 'V', email: 'v@x.test', role: 'handler' });
    expect(getPasswordHash(h.db, 'u2')).toBeUndefined();
  });

  it('refuses a plain-text password in createUser and setPassword', () => {
    expect(() => createUser(h.db, { name: 'P', email: 'p@x.test', role: 'admin', username: 'p', passwordHash: 'CourtesyCars123!' })).toThrow(ValidationError);
    createUser(h.db, { id: 'u1', name: 'U', email: 'u@x.test', role: 'admin', username: 'u1' });
    expect(() => setPassword(h.db, 'u1', 'CourtesyCars123!')).toThrow(ValidationError);
    expect(() => setPassword(h.db, 'u1', 'a$b$c')).toThrow(ValidationError);
    expect(getPasswordHash(h.db, 'u1')).toBeUndefined();
  });

  it('setPassword stores the hash and stamps password_changed_at; unknown users are NotFound', () => {
    createUser(h.db, { id: 'u1', name: 'U', email: 'u@x.test', role: 'admin', username: 'u1' });
    const after = setPassword(h.db, 'u1', HASH, '2026-10-05T10:00:00.000Z');
    expect(after.passwordChangedAt).toBe('2026-10-05T10:00:00.000Z');
    expect(getPasswordHash(h.db, 'u1')).toBe(HASH);
    expect(() => setPassword(h.db, 'nobody', HASH)).toThrow(NotFoundError);
  });

  it('updateUser normalises a new username', () => {
    createUser(h.db, { id: 'u1', name: 'U', email: 'u@x.test', role: 'admin' });
    expect(updateUser(h.db, 'u1', { username: ' NewName ' }).username).toBe('newname');
    expect(() => updateUser(h.db, 'u1', { username: '   ' })).toThrow(ValidationError);
  });
});

describe('sessions', () => {
  beforeEach(() => {
    createUser(h.db, { id: 'u1', name: 'U', email: 'u@x.test', role: 'admin', username: 'u1', passwordHash: HASH });
    createUser(h.db, { id: 'u2', name: 'V', email: 'v@x.test', role: 'handler', username: 'u2', passwordHash: HASH });
  });

  it('stores only a sha256 digest as the id — a raw token is refused', () => {
    const raw = randomBytes(32).toString('base64url');
    expect(() => createSession(h.db, { tokenHash: raw, userId: 'u1', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' })).toThrow(ValidationError);
    const digest = createHash('sha256').update(raw).digest('hex');
    const s = createSession(h.db, { tokenHash: digest, userId: 'u1', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z', ip: '127.0.0.1', userAgent: 'x'.repeat(2000) });
    expect(s).toMatchObject({ id: digest, userId: 'u1', lastSeenAt: '2026-10-05T09:00:00.000Z', ip: '127.0.0.1' });
    expect(s.userAgent).toHaveLength(512);
    expect(getSessionByTokenHash(h.db, digest)).toEqual(s);
    expect(getSessionByTokenHash(h.db, digest.toUpperCase())?.id).toBe(digest);
    expect(getSessionByTokenHash(h.db, raw)).toBeUndefined();
    const stored = h.sqlite.prepare('select * from sessions').all();
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it('refuses an expiry that is not after creation', () => {
    expect(() => createSession(h.db, { tokenHash: tokenHash(), userId: 'u1', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T09:00:00.000Z' })).toThrow(ValidationError);
  });

  it('touches, deletes one, deletes a user’s others, and purges expired rows', () => {
    const a = createSession(h.db, { tokenHash: tokenHash(), userId: 'u1', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' });
    const b = createSession(h.db, { tokenHash: tokenHash(), userId: 'u1', createdAt: '2026-10-05T10:00:00.000Z', expiresAt: '2026-10-05T22:00:00.000Z' });
    const c = createSession(h.db, { tokenHash: tokenHash(), userId: 'u1', createdAt: '2026-10-05T11:00:00.000Z', expiresAt: '2026-10-05T23:00:00.000Z' });
    const other = createSession(h.db, { tokenHash: tokenHash(), userId: 'u2', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' });

    touchSession(h.db, a.id, '2026-10-05T12:00:00.000Z');
    expect(getSessionByTokenHash(h.db, a.id)?.lastSeenAt).toBe('2026-10-05T12:00:00.000Z');

    expect(deleteSession(h.db, c.id)).toBe(true);
    expect(deleteSession(h.db, c.id)).toBe(false);

    expect(deleteUserSessions(h.db, 'u1', a.id)).toBe(1);
    expect(listUserSessions(h.db, 'u1').map((s) => s.id)).toEqual([a.id]);
    expect(getSessionByTokenHash(h.db, b.id)).toBeUndefined();
    expect(getSessionByTokenHash(h.db, other.id)).toBeDefined();

    expect(deleteExpiredSessions(h.db, '2026-10-05T20:59:59.999Z')).toBe(0);
    expect(deleteExpiredSessions(h.db, '2026-10-05T21:00:00.000Z')).toBe(2);
    expect(listUserSessions(h.db, 'u2')).toHaveLength(0);

    createSession(h.db, { tokenHash: tokenHash(), userId: 'u2', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' });
    expect(deleteUserSessions(h.db, 'u2')).toBe(1);
  });

  it('cascade-deletes with the user and is not append-only', () => {
    const s = createSession(h.db, { tokenHash: tokenHash(), userId: 'u2', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' });
    expect(() => h.sqlite.prepare("update sessions set ip = '10.0.0.1' where id = ?").run(s.id)).not.toThrow();
    h.sqlite.prepare("delete from users where id = 'u2'").run();
    expect(getSessionByTokenHash(h.db, s.id)).toBeUndefined();
  });

  it('rejects a session for a user that does not exist', () => {
    expect(() => createSession(h.db, { tokenHash: tokenHash(), userId: 'ghost', createdAt: '2026-10-05T09:00:00.000Z', expiresAt: '2026-10-05T21:00:00.000Z' })).toThrow(/FOREIGN KEY/);
  });
});
