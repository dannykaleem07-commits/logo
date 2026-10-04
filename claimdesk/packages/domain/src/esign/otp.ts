/**
 * HMAC-based one-time passcodes for the in-house e-signature flow (BLUEPRINT §3.8, §9).
 * Stateless: the server keeps only `secret`; the token binds document id, document hash, contact, issue time and code.
 * node:crypto is pure computation; no clock is read here — callers pass `issuedAt` and `now`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ISODateTime } from '../types.js';

export const OTP_DEFAULT_TTL_MINUTES = 10;

export interface GenerateOtpInput {
  secret: string;
  documentId: string;
  documentSha256: string;
  contact: string; // email or phone used for delivery
  channel: 'email' | 'sms';
  issuedAt: ISODateTime;
  ttlMinutes?: number;
  /** Optional per-issue nonce so two OTPs issued in the same second differ. */
  nonce?: string;
}

export interface GeneratedOtp {
  code: string; // 6 digits
  token: string; // hex HMAC-SHA256 of documentId|sha|contact|issuedAt|code
  expiresAt: ISODateTime;
  channel: 'email' | 'sms';
}

export function normaliseContact(contact: string): string {
  const c = contact.trim();
  if (c.includes('@')) return c.toLowerCase();
  // phone: digits only, +44 → 0
  let digits = c.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  return digits.replace(/\D/g, '');
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function addMinutes(iso: ISODateTime, minutes: number): ISODateTime {
  const t = Date.parse(iso);
  return new Date(t + minutes * 60_000).toISOString();
}

/** HOTP-style dynamic truncation of an HMAC to a 6-digit code. */
function codeFromHmac(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const offset = bytes[bytes.length - 1]! & 0x0f;
  const bin = ((bytes[offset]! & 0x7f) << 24) | ((bytes[offset + 1]! & 0xff) << 16) | ((bytes[offset + 2]! & 0xff) << 8) | (bytes[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

export function otpBase(input: Pick<GenerateOtpInput, 'documentId' | 'documentSha256' | 'contact' | 'issuedAt' | 'nonce'>): string {
  return [input.documentId, input.documentSha256.toLowerCase(), normaliseContact(input.contact), input.issuedAt, input.nonce ?? ''].join('|');
}

export function generateOtp(input: GenerateOtpInput): GeneratedOtp {
  if (!input.secret) throw new Error('OTP secret is required');
  if (Number.isNaN(Date.parse(input.issuedAt))) throw new Error('issuedAt must be an ISO date-time');
  const ttl = input.ttlMinutes ?? OTP_DEFAULT_TTL_MINUTES;
  const base = otpBase(input);
  const code = codeFromHmac(hmacHex(input.secret, `code|${base}`));
  const token = hmacHex(input.secret, `token|${base}|${code}`);
  return { code, token, expiresAt: addMinutes(input.issuedAt, ttl), channel: input.channel };
}

export interface VerifyOtpInput {
  secret: string;
  token: string;
  documentId: string;
  documentSha256: string;
  contact: string;
  issuedAt: ISODateTime;
  code: string;
  now: ISODateTime;
  ttlMinutes?: number;
  nonce?: string;
}

export type OtpFailureReason = 'expired' | 'code_mismatch' | 'malformed' | 'not_yet_valid';

export interface VerifyOtpResult {
  ok: boolean;
  reason?: OtpFailureReason;
  expiresAt?: ISODateTime;
}

export function verifyOtp(input: VerifyOtpInput): VerifyOtpResult {
  const issued = Date.parse(input.issuedAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(issued) || Number.isNaN(now) || !input.secret) return { ok: false, reason: 'malformed' };
  const code = (input.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/i.test(input.token ?? '')) return { ok: false, reason: 'malformed' };

  const ttl = input.ttlMinutes ?? OTP_DEFAULT_TTL_MINUTES;
  const expiresAt = addMinutes(input.issuedAt, ttl);
  if (now < issued - 60_000) return { ok: false, reason: 'not_yet_valid', expiresAt };
  if (now > Date.parse(expiresAt)) return { ok: false, reason: 'expired', expiresAt };

  const base = otpBase(input);
  const expected = hmacHex(input.secret, `token|${base}|${code}`);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(input.token.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'code_mismatch', expiresAt };
  return { ok: true, expiresAt };
}
