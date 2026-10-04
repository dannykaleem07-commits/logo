/** Hashing helpers shared by the registry (HTML) and the renderer (PDF). */
import { createHash } from 'node:crypto';

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the HTML string (UTF-8). */
export function htmlSha256(html: string): string {
  return sha256Hex(Buffer.from(html, 'utf8'));
}
