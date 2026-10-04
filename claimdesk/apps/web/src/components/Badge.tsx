import type { ReactNode } from 'react';
import type { ClaimStatus, DocumentStatus, Verification, GateResult, ClaimFlag, Clock, PlaybookAction } from '@ccguk/domain';
import {
  claimStatusLabel,
  claimStatusTone,
  clockStatusTone,
  documentStatusTone,
  DOCUMENT_STATUS_LABEL,
  gateTone,
  priorityTone,
  PRIORITY_LABEL,
  severityTone,
  verificationLabel,
  verificationTone,
  type Tone
} from '../lib/status';

export interface BadgeProps {
  tone?: Tone;
  dot?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'grey', dot = false, title, children, className = '' }: BadgeProps) {
  return (
    <span className={`badge badge-${tone} ${dot ? 'badge-dot' : ''} ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: ClaimStatus | string }) {
  const known = status as ClaimStatus;
  return <Badge tone={claimStatusTone(known) ?? 'grey'}>{claimStatusLabel(status)}</Badge>;
}

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <Badge tone={documentStatusTone(status)} dot={status === 'blocked'}>
      {DOCUMENT_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: ClaimFlag['severity'] }) {
  return <Badge tone={severityTone(severity)}>{severity}</Badge>;
}

/** Verification is data (ARCHITECTURE convention 6): green verified, amber unverified/stale, red failed. */
export function VerificationBadge({ verification }: { verification: Verification | Verification['status'] | undefined }) {
  const v = typeof verification === 'string' ? undefined : verification;
  const title = v ? [v.sourceUrl, v.verifiedAt ? `verified ${v.verifiedAt}` : '', v.verifiedBy ? `by ${v.verifiedBy}` : '', v.sourceNote].filter(Boolean).join(' · ') : undefined;
  return (
    <Badge tone={verificationTone(verification)} dot title={title}>
      {verificationLabel(verification)}
    </Badge>
  );
}

export function GateBadge({ gate }: { gate: GateResult }) {
  return (
    <Badge tone={gateTone(gate.status)} dot title={gate.missing.length ? `Missing: ${gate.missing.join('; ')}` : 'Complete'}>
      {gate.gate}
    </Badge>
  );
}

export function ClockStatusBadge({ status }: { status: Clock['status'] }) {
  return <Badge tone={clockStatusTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}

export function PriorityBadge({ priority }: { priority: PlaybookAction['priority'] }) {
  return <Badge tone={priorityTone(priority)}>{PRIORITY_LABEL[priority]}</Badge>;
}
