// owned by knowledge-core
/**
 * Stub support (docs/SUPREME-KNOWLEDGE-BUILDER.md §13): `knowledge-core` creates every other knowledge slice's files
 * with their final export names and typed signatures; bodies throw `NOT_IMPLEMENTED` until the owning slice lands.
 */
export class KnowledgeNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(readonly slice: string, readonly fn: string) {
    super(`${fn} is not built yet (owned by ${slice})`);
  }
}

export function notImplemented(slice: string, fn: string): never {
  throw new KnowledgeNotImplementedError(slice, fn);
}

export const isNotImplemented = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'NOT_IMPLEMENTED';
