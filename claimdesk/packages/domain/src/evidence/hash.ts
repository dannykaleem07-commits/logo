/**
 * SHA-256 hex digest. node:crypto is pure computation (no I/O) and is the only Node built-in this package uses.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return h.digest('hex');
}
