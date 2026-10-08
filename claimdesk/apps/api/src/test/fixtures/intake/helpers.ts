// owned by intake
/**
 * Synthetic intake documents generated in the tests (no binary fixtures, no real personal data) and a drain helper
 * that runs the intake jobs through the real worker with every other agent paused.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES } from '@ccguk/domain';
import type { AppContext } from '../../../context.js';
import { startWorker } from '../../../agent/worker.js';
import { openGates } from '../../../agent/queue.js';
import { intakeJobHandlers } from '../../../agent/handlers/intake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// pdf-lib is a dependency of @ccguk/documents; resolve it from there (the API itself does not depend on it).
const requireFromDocuments = createRequire(path.resolve(here, '../../../../../../packages/documents/package.json'));

interface PdfLib {
  PDFDocument: { create(): Promise<{ addPage(size: [number, number]): { drawText(t: string, o: Record<string, unknown>): void }; embedFont(f: string): Promise<unknown>; save(): Promise<Uint8Array> }> };
  StandardFonts: { Helvetica: string };
}

/** A text PDF: one array of lines per page. */
export async function makeTextPdf(pages: string[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = requireFromDocuments('pdf-lib') as PdfLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

/** A PDF with pages but no text layer (what a scanner without OCR produces). */
export async function makeBlankPdf(pageCount = 1): Promise<Buffer> {
  const { PDFDocument } = requireFromDocuments('pdf-lib') as PdfLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

/** A multipart RFC 822 message with attachments. */
export function makeEml(input: { from: string; to: string; subject: string; body: string; date?: string; attachments?: Array<{ filename: string; mime: string; content: Buffer }> }): Buffer {
  const boundary = 'INTAKE-TEST-BOUNDARY-1';
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${input.date ?? 'Mon, 05 Oct 2026 10:00:00 +0100'}`,
    'Message-ID: <intake-test-1@example.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.body,
  ];
  for (const a of input.attachments ?? []) {
    const b64 = a.content.toString('base64').replace(/(.{76})/g, '$1\r\n');
    lines.push(`--${boundary}`, `Content-Type: ${a.mime}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, 'Content-Transfer-Encoding: base64', '', b64);
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/** ISO-BMFF header of a HEIC photo (enough for the sniffer; not a decodable image). */
export function makeHeicHeader(): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'latin1');
  box.write('heic', 8, 'latin1');
  box.write('mif1', 16, 'latin1');
  box.write('heic', 20, 'latin1');
  return box;
}

/** Run queued intake jobs through the real worker until nothing is left (other agents paused by the gates). */
export async function drainIntake(ctx: AppContext, now: string, maxRounds = 12): Promise<Array<{ type: string; outcome: string }>> {
  const w = startWorker(ctx, { owner: 'intake-test', handlers: intakeJobHandlers });
  const gates = { ...openGates(), pausedAgents: [...AGENT_NAMES.filter((a) => a !== 'intake'), 'system'] };
  const all: Array<{ type: string; outcome: string }> = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const settled = await w.tick(now, gates);
    if (!settled.length) break;
    all.push(...settled.map((s) => ({ type: s.type, outcome: s.outcome })));
  }
  await w.stop(100);
  return all;
}

/** Jobs of a type (newest last). */
export function jobsOf(ctx: AppContext, type: string): Array<{ id: string; status: string; payload: unknown; idempotency_key: string | null }> {
  return (ctx.handle.sqlite.prepare('SELECT id, status, payload, idempotency_key FROM agent_jobs WHERE type = ? ORDER BY created_at, rowid').all(type) as Array<{ id: string; status: string; payload: string; idempotency_key: string | null }>).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function auditRows(ctx: AppContext, action: string): Array<{ user_id: string; run_id: string | null; entity_id: string; before: unknown; after: Record<string, unknown> }> {
  return (ctx.handle.sqlite.prepare('SELECT user_id, run_id, entity_id, before, after FROM audit_log WHERE action = ? ORDER BY rowid').all(action) as Array<{ user_id: string; run_id: string | null; entity_id: string; before: string | null; after: string }>).map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: JSON.parse(r.after) }));
}
