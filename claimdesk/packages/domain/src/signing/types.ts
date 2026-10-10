// owned by ap-foundation (contracts); packs.ts (STAGE_PACKS data) and the chase schedule by ap-paperwork
/**
 * Paperwork and signing contracts (docs/SUPREME-AUTOPILOT.md §D.6, §E): stage packs, signature requests (kiosk and
 * wet ink) and kiosk sessions. Pure types only. E-signature stays human-only (`assertHuman`).
 */
import type { ISODateTime, Id } from '../types.js';

export type PackStage = 'signup' | 'hire_offer' | 'hire_start' | 'off_hire' | 'billing' | 'payment' | 'closure';
export const PACK_STAGES: readonly PackStage[] = ['signup', 'hire_offer', 'hire_start', 'off_hire', 'billing', 'payment', 'closure'];

export interface PackItemDef {
  templateId: string;
  variant?: string;
  format: 'html' | 'docx';
  purpose: 'sign' | 'give' | 'send_insurer' | 'internal';
  signer?: 'client' | 'hirer' | 'driver';
  /** PredicateId over AutopilotFacts (autopilot/predicates.ts). */
  when?: string;
}

export type PackItemStatus = 'pending' | 'drafted' | 'reviewed' | 'approved' | 'sent' | 'signed' | 'not_needed';
export type DocumentPackStatus = 'preparing' | 'reviewing' | 'awaiting_approval' | 'approved' | 'sent' | 'signed' | 'superseded' | 'cancelled';

export interface DocumentPack {
  id: Id;
  claimId: Id;
  stage: PackStage;
  reservationId?: Id;
  items: Array<PackItemDef & { documentId?: Id; status: PackItemStatus; reviewId?: Id }>;
  status: DocumentPackStatus;
  approvedBy?: string;
  approvedAt?: ISODateTime;
  sentAt?: ISODateTime;
  outboxId?: Id;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type SignatureRequestMethod = 'kiosk_otp_email' | 'kiosk_handler_code' | 'wet_email' | 'wet_post';
export type SignatureRequestStatus = 'prepared' | 'sent' | 'chased' | 'returned' | 'signed' | 'declined' | 'cancelled';

export interface SignatureRequest {
  id: Id;
  packId?: Id;
  documentId: Id;
  claimId: Id;
  signerPartyId: Id;
  method: SignatureRequestMethod;
  status: SignatureRequestStatus;
  sentAt?: ISODateTime;
  chaseCount: number;
  lastChasedAt?: ISODateTime;
  nextChaseAt?: ISODateTime;
  returnedEvidenceId?: Id;
  signedAt?: ISODateTime;
  confirmedBy?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Append-only history row (`signature_request_events`). */
export interface SignatureRequestEvent {
  id: Id;
  signatureRequestId: Id;
  fromStatus?: SignatureRequestStatus;
  toStatus: SignatureRequestStatus;
  actor: string;
  note?: string;
  at: ISODateTime;
}

/** A kiosk session (`kiosk_sessions`): the token itself is never stored, only its sha256. */
export interface KioskSession {
  id: Id;
  packId: Id;
  claimId: Id;
  signerPartyId: Id;
  tokenSha256: string;
  lan: boolean;
  createdBy: string;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  openedAt?: ISODateTime;
  openedIp?: string;
  openedUserAgent?: string;
  completedAt?: ISODateTime;
  closedReason?: string;
}
