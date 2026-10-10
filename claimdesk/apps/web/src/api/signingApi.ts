// owned by ap-paperwork
/**
 * Paperwork and signing client (docs/SUPREME-AUTOPILOT.md §D.6, §E, §H.4). Web code never imports API code, so the
 * HTTP shapes of apps/api/src/routes/{signing,kiosk}.ts are declared here.
 *
 *   GET   /claims/:id/packs · POST /claims/:id/packs { stage, reservationId?, restart? } · GET /packs/:id
 *   POST  /packs/:id/approve { send?, note? } · /send-for-signature · /reject { reason } · /kiosk
 *   GET   /claims/:id/signatures · POST /documents/:id/mark-signed
 *   Kiosk (token auth): GET /kiosk/:token · GET …/documents/:docId/pdf · POST …/read · …/otp/start · …/sign · …/close
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentPack, PackStage, SignatureRequest } from '@ccguk/domain';
import { buildUrl, request, seg } from './client';

export interface PackItemView {
  key: string;
  templateId: string;
  variant?: string;
  purpose: 'sign' | 'give' | 'send_insurer' | 'internal';
  signer?: string;
  status: DocumentPack['items'][number]['status'];
  documentId?: string;
  title?: string;
  documentStatus?: string;
  format?: string;
  reviewId?: string;
  verdict?: string;
  issues?: Array<{ code?: string; severity?: string; message?: string }>;
  signedAt?: string;
  sentAt?: string;
}

export interface PackView extends DocumentPack {
  label: string;
  stepId: string;
  signer: { partyId: string; name: string; email?: string };
  view: PackItemView[];
  sendTo: Array<{ target: 'client' | 'at_fault_insurer'; address?: string; documents: number }>;
  signatureRequests: SignatureRequest[];
}

export interface KioskCreated {
  sessionId: string;
  token: string;
  path: string;
  lanUrl?: string;
  expiresAt: string;
  signer: { partyId: string; name: string };
}

export interface SignatureView {
  documentId: string;
  title: string;
  templateId: string;
  signerName: string;
  signedAt: string;
  certificateId: string;
  method: string;
  evidenceId?: string;
  packId?: string;
}

export const signingQk = {
  packs: (claimId: string) => ['packs', claimId] as const,
  signatures: (claimId: string) => ['signatures', claimId] as const,
};

export const signingApi = {
  packs: (claimId: string) => request<{ packs: PackView[] }>(`/claims/${seg(claimId)}/packs`),
  pack: (packId: string) => request<{ pack: PackView }>(`/packs/${seg(packId)}`),
  prepare: (claimId: string, body: { stage: PackStage; reservationId?: string | null; restart?: boolean }) =>
    request<{ pack: PackView; created: unknown[]; failed: Array<{ templateId: string; variant?: string; code: string; message: string }>; reused: boolean }>(`/claims/${seg(claimId)}/packs`, { method: 'POST', body }),
  approve: (packId: string, body: { send?: boolean; note?: string }) => request<{ pack: PackView; approved: string[] }>(`/packs/${seg(packId)}/approve`, { method: 'POST', body }),
  send: (packId: string) => request<{ pack: PackView }>(`/packs/${seg(packId)}/send-for-signature`, { method: 'POST', body: {} }),
  reject: (packId: string, reason: string) => request<{ pack: PackView }>(`/packs/${seg(packId)}/reject`, { method: 'POST', body: { reason } }),
  kiosk: (packId: string) => request<KioskCreated>(`/packs/${seg(packId)}/kiosk`, { method: 'POST', body: {} }),
  signatures: (claimId: string) => request<{ signatures: SignatureView[]; requests: SignatureRequest[]; packs: PackView[] }>(`/claims/${seg(claimId)}/signatures`),
  markSigned: (documentId: string, body: { evidenceId: string; signedOn: string; method: 'wet_ink' | 'scan'; signerPartyId?: string }) =>
    request<{ certificateId: string }>(`/documents/${seg(documentId)}/mark-signed`, { method: 'POST', body }),
};

export function useClaimPacks(claimId: string | undefined) {
  return useQuery({ queryKey: signingQk.packs(claimId ?? ''), queryFn: () => signingApi.packs(claimId!), enabled: Boolean(claimId), refetchInterval: 15_000 });
}

export function usePackActions(claimId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: signingQk.packs(claimId) });
    void qc.invalidateQueries({ queryKey: signingQk.signatures(claimId) });
  };
  return {
    prepare: useMutation({ mutationFn: (body: { stage: PackStage; reservationId?: string | null; restart?: boolean }) => signingApi.prepare(claimId, body), onSettled: done }),
    approve: useMutation({ mutationFn: ({ packId, send }: { packId: string; send: boolean }) => signingApi.approve(packId, { send }), onSettled: done }),
    send: useMutation({ mutationFn: (packId: string) => signingApi.send(packId), onSettled: done }),
    reject: useMutation({ mutationFn: ({ packId, reason }: { packId: string; reason: string }) => signingApi.reject(packId, reason), onSettled: done }),
    kiosk: useMutation({ mutationFn: (packId: string) => signingApi.kiosk(packId) }),
  };
}

// ---------------------------------------------------------------------------
// Kiosk (token auth; the page is outside the app shell)
// ---------------------------------------------------------------------------

export interface KioskSummary {
  sessionId: string;
  packLabel: string;
  signer: { name: string };
  documents: Array<{ id: string; title: string; purpose: 'sign' | 'give'; read: boolean; signed: boolean }>;
  otp: { delivery: 'email' | 'handler'; contactMasked?: string };
  expiresAt: string;
  completed: boolean;
}

export interface KioskOtp {
  channel: 'email' | 'handler';
  contactMasked?: string;
  expiresAt: string;
  handlerCode?: string;
  devCode?: string;
}

export const kioskApi = {
  summary: (token: string) => request<KioskSummary>(`/kiosk/${seg(token)}`),
  pdfUrl: (token: string, docId: string) => buildUrl(`/kiosk/${seg(token)}/documents/${seg(docId)}/pdf`),
  read: (token: string, documentId: string) => request<{ read: string[] }>(`/kiosk/${seg(token)}/read`, { method: 'POST', body: { documentId } }),
  otp: (token: string) => request<KioskOtp>(`/kiosk/${seg(token)}/otp/start`, { method: 'POST', body: {} }),
  sign: (token: string, body: { typedName: string; drawnSignaturePngBase64: string; code: string; consent: true }) =>
    request<{ signed: Array<{ documentId: string; certificateId: string }>; given: string[]; completedAt: string }>(`/kiosk/${seg(token)}/sign`, { method: 'POST', body }),
  close: (token: string, password: string) => request<{ closed: true }>(`/kiosk/${seg(token)}/close`, { method: 'POST', body: { password } }),
};
