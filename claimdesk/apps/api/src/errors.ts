/** Manager-mode override information attached to an overridable (class A/B) refusal by `gate.refuse` (§A.4.3). */
export interface OverrideInfo { code: string; class: 'A' | 'B'; label: string; warning?: string; allowed: boolean; managerMode: 'on' | 'off' }

/** HTTP-mapped application errors. The app error handler turns these (and db/zod errors) into `{error:{code,message,details?,override?}}`. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  /** Set by the override gate on an overridable refusal (class C errors never carry it). */
  override?: OverrideInfo;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): HttpError => new HttpError(400, 'VALIDATION', message, details);
export const notFound = (entity: string, id: string): HttpError => new HttpError(404, 'NOT_FOUND', `${entity} ${id} not found`);
export const conflict = (code: string, message: string, details?: unknown): HttpError => new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown): HttpError => new HttpError(422, code, message, details);
export const notImplemented = (message: string): HttpError => new HttpError(501, 'NOT_IMPLEMENTED', message);
