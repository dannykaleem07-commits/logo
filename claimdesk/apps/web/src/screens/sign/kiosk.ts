// owned by ap-paperwork
/**
 * Pure helpers for the signing kiosk screen (docs/SUPREME-AUTOPILOT.md §E.2, §I.6): where the signer is, whether the
 * Sign button may be pressed, plain-English error text, and the signature image limit.
 */
import type { KioskSummary } from '../../api/signingApi';

/** Idle time before the screen blanks and asks for the Claims Team (§E.2 step 5). */
export const KIOSK_IDLE_MS = 5 * 60_000;
/** The server refuses larger drawn signatures (PNG). */
export const SIGNATURE_MAX_BYTES = 200 * 1024;

export type KioskStage = { kind: 'read'; index: number; total: number } | { kind: 'sign' } | { kind: 'done' };

/** The first unread document, else the signing step, else done. */
export function kioskStage(summary: Pick<KioskSummary, 'documents' | 'completed'>, readIds: ReadonlySet<string>): KioskStage {
  if (summary.completed) return { kind: 'done' };
  const docs = summary.documents;
  const i = docs.findIndex((d) => !d.read && !readIds.has(d.id));
  if (i >= 0) return { kind: 'read', index: i, total: docs.length };
  return { kind: 'sign' };
}

/** "Document 2 of 5". */
export function progressLabel(stage: KioskStage): string {
  return stage.kind === 'read' ? `Document ${stage.index + 1} of ${stage.total}` : stage.kind === 'sign' ? 'Sign' : 'Done';
}

export interface SignFormState {
  typedName: string;
  signaturePng: string | null;
  code: string;
  consent: boolean;
  codeRequested: boolean;
}

/** Why Sign is disabled (first reason), or null when it may be pressed. */
export function signBlocker(s: SignFormState): string | null {
  if (s.typedName.trim().length < 2) return 'Type your full name';
  if (!s.signaturePng) return 'Draw your signature';
  if (!s.consent) return 'Tick the box to agree to sign electronically';
  if (!s.codeRequested) return 'Ask for your code';
  if (!/^\d{6}$/.test(s.code.replace(/\s/g, ''))) return 'Enter the 6-digit code';
  return null;
}

/** Bytes of a base64 data URL (or bare base64). */
export function base64Bytes(dataUrl: string): number {
  const b64 = dataUrl.replace(/^data:[^,]*,/, '');
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const MESSAGES: Record<string, string> = {
  KIOSK_TOKEN: 'This signing link is not valid. Please ask the Claims Team to start again.',
  KIOSK_EXPIRED: 'This signing session has expired. Please ask the Claims Team to start again.',
  KIOSK_CLOSED: 'This signing session has ended. Please hand the device back to the Claims Team.',
  KIOSK_DEVICE: 'This signing link is already open on another device.',
  KIOSK_DONE: 'These documents are already signed. Please hand the device back to the Claims Team.',
  KIOSK_NOT_READ: 'Please read every document first.',
  OTP_INVALID: 'That code is not right. Please check it and try again.',
  OTP_LOCKED: 'Too many attempts. Please ask for a new code.',
  OTP_NO_CHALLENGE: 'Please ask for your code first.',
  DOCUMENT_CHANGED: 'A document changed. Please ask the Claims Team to start again.',
  SIGNATURE_IMAGE: 'Please draw your signature again.',
  KIOSK_PASSWORD: 'That password is not right.',
};

/** Plain-English text for a kiosk error code (falls back to the server's message). */
export function kioskMessage(code: string | undefined, fallback: string): string {
  return (code && MESSAGES[code]) || fallback;
}

/** Codes after which the kiosk cannot continue (the screen shows only the message and the hand-back button). */
export const FATAL_KIOSK_CODES: ReadonlySet<string> = new Set(['KIOSK_TOKEN', 'KIOSK_EXPIRED', 'KIOSK_CLOSED', 'KIOSK_DEVICE']);
