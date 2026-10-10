/**
 * Hire tab: hire agreements (with the pricing guide figures, late-entry marks and corrections), storage and recovery.
 * The cards and dialogs live in ./hire/. Starting a hire, editing its dates and rate, and ending it are described in
 * docs/V03-MANAGER-MODE-HIRE-PRICING.md §B and §C.
 */
import { useState } from 'react';
import type { HireAgreement, StorageRecord } from '@ccguk/domain';
import { useRecovery, useStorage } from '../../../api/hooks';
import { useHireList, type HireListItem } from '../../../api/hireApi';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { ClockPill } from '../../../components/ClockPill';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { pickList, type ClaimView } from '../claimFile';
import { useClaimClocks } from '../useClaimDerived';
import { BasisText } from '../components/BasisText';
import { offHireClocks, storageCapClock } from '../lib/clocksView';
import { HireCard } from './hire/HireCard';
import { StartHireDialog } from './hire/StartHireDialog';
import { EditHireDialog } from './hire/EditHireDialog';
import { EndHireDialog } from './hire/EndHireDialog';
import { RecoveryCard, StorageCard } from './hire/ServiceCards';
import { AddRecoveryDialog, AddStorageDialog, EndStorageDialog } from './hire/ServiceDialogs';
import './hire/hire.css';
// Autopilot fleet bookings (docs/SUPREME-AUTOPILOT.md §I.2, ap-booking)
import { BookingsCard } from '../booking/BookingsCard';

export function HireTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const hireQ = useHireList(claimId);
  const storageQ = useStorage(claimId);
  const recoveryQ = useRecovery(claimId);
  const hires = pickList<HireListItem>(hireQ.data, view.hire);
  const storage = pickList(storageQ.data, view.storage);
  const recovery = pickList(recoveryQ.data, view.recovery);
  const { clocks } = useClaimClocks(view);
  const now = new Date();
  const nowIso = now.toISOString();
  const offHire = offHireClocks(clocks).filter((c) => c.status === 'running' || c.status === 'breached');
  const storageCap = storageCapClock(clocks);
  const [ending, setEnding] = useState<HireAgreement | null>(null);
  const [editing, setEditing] = useState<HireListItem | null>(null);
  const [endingStorage, setEndingStorage] = useState<StorageRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const [addingStorage, setAddingStorage] = useState(false);
  const [addingRecovery, setAddingRecovery] = useState(false);

  return (
    <div className="stack">
      {offHire.length > 0 && (
        <div className="notice notice-warn" role="alert">
          <strong>Off-hire deadline.</strong>{' '}
          {offHire.map((c) => (
            <span key={c.id} className="row" style={{ display: 'inline-flex', gap: 8 }}>
              {c.label}: <DateText value={c.dueAt} time /> <ClockPill clock={c} now={now} /> <BasisText basis={c.basis} />
            </span>
          ))}{' '}
          Hire past the trigger is hard to recover: end the agreement with its trigger.
        </div>
      )}

      <BookingsCard claimId={claimId} />

      <Card
        title="Hire agreements"
        actions={
          <Button size="sm" variant="primary" onClick={() => setStarting(true)}>
            Start hire
          </Button>
        }
      >
        <ApiErrorNotice error={hireQ.error} what="load hire agreements" />
        {hires.length === 0 ? (
          <EmptyState title="No hire agreement yet">Choose a fleet car to start a hire. You will see its daily rate and the GTA guides for the car you give and the client's car before you agree the rate.</EmptyState>
        ) : (
          <div className="stack">
            {hires.map((h) => (
              <HireCard key={h.id} h={h} view={view} nowIso={nowIso} onEnd={() => setEnding(h)} onEdit={() => setEditing(h)} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Storage"
        actions={
          <Button size="sm" onClick={() => setAddingStorage(true)}>
            Add storage
          </Button>
        }
      >
        <ApiErrorNotice error={storageQ.error} what="load storage" />
        {storageCap && (storageCap.status === 'running' || storageCap.status === 'breached') && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <strong>Report + 48 hours.</strong> Insurers commonly cap storage at the engineer’s report plus 48 hours. Cap due <DateText value={storageCap.dueAt} time /> <ClockPill clock={storageCap} now={now} />. Send the collect-or-pay notice so further storage is the insurer’s choice.
          </div>
        )}
        {storage.length === 0 ? (
          <EmptyState title="No storage record">Rate card £45/day ex VAT. Storage ends on report issued, total loss confirmed, payment received, collection or salvage release.</EmptyState>
        ) : (
          <div className="stack">
            {storage.map((s) => (
              <StorageCard key={s.id} s={s} nowIso={nowIso} onEnd={() => setEndingStorage(s)} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Recovery"
        actions={
          <Button size="sm" onClick={() => setAddingRecovery(true)}>
            Add recovery
          </Button>
        }
      >
        <ApiErrorNotice error={recoveryQ.error} what="load recovery" />
        {recovery.length === 0 ? (
          <EmptyState title="No recovery record">Rate card £90 call-out + £3 per loaded mile + £25 admin, ex VAT. Recording a recovery writes the claimed amount to the ledger.</EmptyState>
        ) : (
          <div className="stack">
            {recovery.map((r) => (
              <RecoveryCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </Card>

      <EndHireDialog claimId={claimId} hire={ending} nowIso={nowIso} onClose={() => setEnding(null)} />
      {editing && <EditHireDialog key={editing.id} claimId={claimId} hire={editing} accidentAt={view.claim.accident?.occurredAt} onClose={() => setEditing(null)} />}
      <EndStorageDialog claimId={claimId} storage={endingStorage} nowIso={nowIso} onClose={() => setEndingStorage(null)} />
      <StartHireDialog claimId={claimId} view={view} open={starting} nowIso={nowIso} onClose={() => setStarting(false)} />
      <AddStorageDialog claimId={claimId} open={addingStorage} nowIso={nowIso} onClose={() => setAddingStorage(false)} />
      <AddRecoveryDialog claimId={claimId} view={view} open={addingRecovery} nowIso={nowIso} onClose={() => setAddingRecovery(false)} />
    </div>
  );
}
