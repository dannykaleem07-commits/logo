// owned by knowledge-use
/** Small raw-SQL helpers for knowledge-use (reads across tables through `ctx.handle.sqlite`, guarded by `hasTable`). */
import type { AppContext } from '../../context.js';

export function tableExists(ctx: AppContext, name: string): boolean {
  return Boolean(ctx.handle.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

export function rows<T>(ctx: AppContext, sqlText: string, ...params: unknown[]): T[] {
  return ctx.handle.sqlite.prepare(sqlText).all(...params) as T[];
}

export function row<T>(ctx: AppContext, sqlText: string, ...params: unknown[]): T | undefined {
  return ctx.handle.sqlite.prepare(sqlText).get(...params) as T | undefined;
}

export function parseJson<T = unknown>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}
