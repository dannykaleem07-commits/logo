// owned by ap-paperwork
/**
 * Paperwork packs (docs/SUPREME-AUTOPILOT.md §D.6, §E): each stage pack with its documents (purpose, review verdict,
 * signed / sent), and the owner's actions — Approve and send, Approve only, Send for signature, Sign in person (kiosk,
 * with the QR code when the office tablet is on), Reject, Prepare again. Every action is human-only on the server.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PackStage } from '@ccguk/domain';
import { useClaimPacks, usePackActions, type KioskCreated, type PackView } from '../../../api/signingApi';
import { useClaimBookings } from '../../../api/bookingsApi';
import { ApiErrorNotice, Badge, Button, Card, EmptyState, Modal, Select } from '../../../components';
import { QrCode } from '../../sign/QrCode';
import { ITEM_STATUS_LABEL, PACK_STATUS_LABEL, PACK_STATUS_TONE, PURPOSE_LABEL, STAGE_OPTIONS, packActions, packCounts, verdictTone } from './packsView';
import '../../sign/sign.css';

function KioskModal({ kiosk, onClose }: { kiosk: KioskCreated; onClose: () => void }) {
  return (
    <Modal open title="Sign in person" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <p>
          The signing screen for <strong>{kiosk.signer.name}</strong> is ready. It works for 30 minutes and only for this pack.
        </p>
        <p>
          <a className="btn btn-primary" href={kiosk.path} target="_blank" rel="noreferrer">
            Open the signing screen on this PC
          </a>
        </p>
        {kiosk.lanUrl && (
          <>
            <p>Or scan this with the office tablet (same Wi-Fi):</p>
            <QrCode value={kiosk.lanUrl} label="Signing link for the office tablet" />
            <p className="muted small">This link uses plain HTTP on the office network. Use it only on a trusted office Wi-Fi or this PC’s own hotspot. It opens on the first device that uses it.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function PackCard({ pack, claimId }: { pack: PackView; claimId: string }) {
  const actions = usePackActions(claimId);
  const [kiosk, setKiosk] = useState<KioskCreated | null>(null);
  const [error, setError] = useState<unknown>(null);
  const can = packActions(pack);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch(setError);
  };
  return (
    <Card
      title={
        <span className="row">
          {pack.label} <Badge tone={PACK_STATUS_TONE[pack.status]}>{PACK_STATUS_LABEL[pack.status]}</Badge>
        </span>
      }
    >
      <p className="muted small">
        {packCounts(pack.view)} · signer {pack.signer.name}
        {pack.sendTo.length ? ` · goes to ${pack.sendTo.map((s) => (s.target === 'client' ? 'the client' : 'the insurer') + (s.address ? ` (${s.address})` : '')).join(' and ')}` : ''}
      </p>
      <ul className="stack-sm">
        {pack.view
          .filter((i) => i.status !== 'not_needed')
          .map((i) => (
            <li key={i.key} className="packs-item-row">
              {i.documentId ? <Link to={`/claims/${claimId}/documents/${i.documentId}`}>{i.title ?? i.templateId}</Link> : <span>{i.templateId}</span>}
              <Badge tone="grey">{PURPOSE_LABEL[i.purpose]}</Badge>
              <Badge tone={i.status === 'signed' ? 'green' : i.status === 'pending' ? 'amber' : 'grey'}>{ITEM_STATUS_LABEL[i.status]}</Badge>
              {i.verdict && <Badge tone={verdictTone(i.verdict)}>review: {i.verdict}</Badge>}
            </li>
          ))}
      </ul>
      {pack.signatureRequests.length > 0 && (
        <p className="small muted">
          Waiting for signed copies: {pack.signatureRequests.filter((r) => r.status !== 'signed' && r.status !== 'cancelled').length} · reminders sent:{' '}
          {pack.signatureRequests.reduce((t, r) => t + r.chaseCount, 0)}
        </p>
      )}
      <div className="packs-actions">
        {can.includes('approve_send') && (
          <Button variant="primary" loading={actions.approve.isPending} onClick={() => run(actions.approve.mutateAsync({ packId: pack.id, send: true }))}>
            Approve and send
          </Button>
        )}
        {can.includes('approve_only') && (
          <Button loading={actions.approve.isPending} onClick={() => run(actions.approve.mutateAsync({ packId: pack.id, send: false }))}>
            Approve only (sign in person)
          </Button>
        )}
        {can.includes('send') && (
          <Button loading={actions.send.isPending} onClick={() => run(actions.send.mutateAsync(pack.id))}>
            Send for signature
          </Button>
        )}
        {can.includes('kiosk') && (
          <Button loading={actions.kiosk.isPending} onClick={() => run(actions.kiosk.mutateAsync(pack.id).then(setKiosk))}>
            Sign in person
          </Button>
        )}
        {can.includes('restart') && (
          <Button variant="ghost" loading={actions.prepare.isPending} onClick={() => run(actions.prepare.mutateAsync({ stage: pack.stage, reservationId: pack.reservationId ?? null, restart: true }))}>
            Prepare again
          </Button>
        )}
        {can.includes('reject') && (
          <Button
            variant="danger"
            loading={actions.reject.isPending}
            onClick={() => {
              const reason = window.prompt('Why is this paperwork rejected?');
              if (reason && reason.trim().length >= 3) run(actions.reject.mutateAsync({ packId: pack.id, reason: reason.trim() }));
            }}
          >
            Reject
          </Button>
        )}
      </div>
      {error != null && <ApiErrorNotice error={error} />}
      {kiosk && <KioskModal kiosk={kiosk} onClose={() => setKiosk(null)} />}
    </Card>
  );
}

export function PacksPanel({ claimId, reservationId: given }: { claimId: string; reservationId?: string }) {
  const packs = useClaimPacks(claimId);
  const bookings = useClaimBookings(given ? undefined : claimId);
  // The booking the hire paperwork is for: the one given, else the claim's current (confirmed / on hire / held) booking.
  const reservationId = given ?? bookings.data?.reservations.find((r) => r.status === 'confirmed' || r.status === 'on_hire' || r.status === 'held')?.id;
  const actions = usePackActions(claimId);
  const [stage, setStage] = useState<PackStage>('signup');
  const [error, setError] = useState<unknown>(null);
  const needsBooking = STAGE_OPTIONS.find((s) => s.value === stage)?.needsBooking ?? false;
  return (
    <div className="stack">
      <div className="row">
        <Select label="Prepare paperwork" value={stage} onChange={(v) => setStage(v as PackStage)} options={STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label }))} />
        <Button
          variant="primary"
          loading={actions.prepare.isPending}
          disabled={needsBooking && !reservationId}
          title={needsBooking && !reservationId ? 'Book a car first: this pack is for a booking' : undefined}
          onClick={() => {
            setError(null);
            actions.prepare.mutateAsync({ stage, ...(needsBooking && reservationId ? { reservationId } : {}) }).catch(setError);
          }}
        >
          Prepare
        </Button>
      </div>
      {error != null && <ApiErrorNotice error={error} />}
      {packs.error != null && <ApiErrorNotice error={packs.error} />}
      {packs.data && packs.data.packs.length === 0 && <EmptyState title="No paperwork packs yet">Packs are prepared by the Autopilot at each stage, or here.</EmptyState>}
      {packs.data?.packs.map((p) => (
        <PackCard key={p.id} pack={p} claimId={claimId} />
      ))}
    </div>
  );
}
