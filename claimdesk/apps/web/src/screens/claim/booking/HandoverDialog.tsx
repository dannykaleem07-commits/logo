// owned by ap-booking
/**
 * Handover and Return dialogs (docs/SUPREME-AUTOPILOT.md §I.5, §B.9). People only: the routes are human-only in the
 * perimeter. Handover: the checklist (pack signed, licence evidence, DVLA check, driver eligibility), odometer, fuel,
 * keys and the condition report, then **Start hire** — the hire record is created from the booking. Return: odometer
 * in, fuel, damage rows, collected time and the contractual end, then **End hire**; the server's off-hire warning
 * (days past the deadline are not recoverable) is shown.
 */
import { useMemo, useState } from 'react';
import type { DamageSeverity, HireEndTrigger } from '@ccguk/domain';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { DateTimeInput, Select, TextArea, TextInput } from '../../../components/Form';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Loading } from '../../../components/Spinner';
import { useToast } from '../../../components/Toast';
import { useClaim } from '../../../api/hooks';
import { isApiError } from '../../../api/client';
import { bookingsApi, useBooking, useBookingMutation } from '../../../api/bookingsApi';
import { useEligibility } from '../../../api/clashApi';
import '../../fleet/booking.css';

const FUEL_OPTIONS = Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: i === 8 ? 'Full (8/8)' : i === 0 ? 'Empty (0/8)' : `${i}/8` }));
const nowIso = () => new Date().toISOString();

export function HandoverDialog({ open, reservationId, onClose }: { open: boolean; reservationId: string; onClose: () => void }) {
  if (!open) return null;
  return <HandoverBody reservationId={reservationId} onClose={onClose} />;
}

function HandoverBody({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const toast = useToast();
  const booking = useBooking(reservationId);
  const claimId = booking.data?.claimId;
  const claim = useClaim(claimId);
  const elig = useEligibility(claimId);
  const [at, setAt] = useState(nowIso());
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState('8');
  const [keys, setKeys] = useState('1');
  const [licenceEvidenceId, setLicenceEvidenceId] = useState('');
  const [dvlaAt, setDvlaAt] = useState('');
  const [dvlaSummary, setDvlaSummary] = useState('');
  const [conditionDocumentId, setConditionDocumentId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const evidence = useMemo(() => (claim.data?.evidence ?? []).map((e) => ({ value: e.id, label: `${e.filename ?? e.kind} (${e.kind.replace(/_/g, ' ')})` })), [claim.data]);
  const docs = useMemo(() => (claim.data?.documents ?? []).map((d) => ({ value: d.id, label: `${d.templateId} — ${d.status}` })), [claim.data]);
  const start = useBookingMutation(() =>
    bookingsApi.handover(reservationId, {
      at,
      odometerOut: Number(odometer),
      fuelEighths: Number(fuel),
      keys: Number(keys) || 1,
      licenceEvidenceId: licenceEvidenceId || null,
      dvlaCheck: dvlaAt && dvlaSummary.trim() ? { checkedAt: dvlaAt, summary: dvlaSummary.trim() } : null,
      conditionDocumentId: conditionDocumentId || null,
      notes: notes.trim() || null,
    }),
  );
  const signed = booking.data?.signedPack;
  const driver = elig.data?.summary.driver;
  const valid = Boolean(at) && /^\d+$/.test(odometer);

  const submit = async () => {
    setError(null);
    try {
      const out = await start.mutateAsync(undefined);
      toast.success(`Hire ${out.hire.agreementNumber} started${out.enforceabilityGaps.length ? ` — ${out.enforceabilityGaps.length} paperwork gap(s) flagged on the claim` : ''}`);
      onClose();
    } catch (e) {
      if (isApiError(e) && e.override) return; // the manager-override prompt handled it
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={booking.data ? `Handover — ${booking.data.registration}` : 'Handover'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={start.isPending} disabled={!valid} onClick={() => void submit()}>
            Start hire
          </Button>
        </>
      }
    >
      {booking.isLoading ? (
        <Loading />
      ) : (
        <div className="stack-sm">
          <ul className="check-list" aria-label="Before the car goes out">
            <li className={signed?.signed ? 'ok' : 'no'}>
              {signed?.signed ? '✓ Hire paperwork signed' : `✗ Hire paperwork not signed${signed?.missing.length ? `: ${signed.missing.join(', ')}` : ''} — sign it in the kiosk from the claim's paperwork packs`}
            </li>
            <li className={licenceEvidenceId ? 'ok' : 'no'}>{licenceEvidenceId ? '✓ Licence evidence chosen' : '✗ Licence evidence — capture a photo of the licence first (Capture page), then choose it below'}</li>
            <li className={dvlaAt && dvlaSummary ? 'ok' : 'no'}>{dvlaAt && dvlaSummary ? '✓ DVLA check recorded' : '✗ DVLA licence check — record the date and what it showed'}</li>
            <li className={driver?.outcome === 'eligible' ? 'ok' : 'no'}>{driver ? (driver.outcome === 'eligible' ? '✓ Driver eligible' : `✗ Driver ${driver.outcome}`) : 'Driver eligibility not assessed'}</li>
          </ul>
          <div className="grid-2">
            <DateTimeInput label="Handed over at" value={at} onChange={(v) => setAt(v)} required />
            <TextInput label="Odometer out (miles)" value={odometer} onChange={setOdometer} inputMode="numeric" required />
            <Select label="Fuel" value={fuel} onChange={setFuel} options={FUEL_OPTIONS} />
            <TextInput label="Keys handed over" value={keys} onChange={setKeys} inputMode="numeric" />
            <Select label="Licence evidence" value={licenceEvidenceId} onChange={setLicenceEvidenceId} options={evidence} placeholder="Choose evidence…" />
            <Select label="Condition report (CCGUK-06)" value={conditionDocumentId} onChange={setConditionDocumentId} options={docs} placeholder="Choose document…" />
            <DateTimeInput label="DVLA check done at" value={dvlaAt} onChange={(v) => setDvlaAt(v)} />
            <TextInput label="DVLA check result" value={dvlaSummary} onChange={setDvlaSummary} placeholder="e.g. Full licence, 3 points SP30, no disqualifications" />
          </div>
          <TextArea label="Notes" value={notes} onChange={setNotes} rows={2} />
          <ErrorAlert message={error} />
        </div>
      )}
    </Modal>
  );
}

const TRIGGERS: Array<{ value: HireEndTrigger; label: string }> = [
  { value: 'repair_complete_24h', label: 'Repair complete (off hire within 24 h)' },
  { value: 'tl_payment_5wd', label: 'Total-loss payment received (5 working days)' },
  { value: 'insurer_termination_1wd', label: 'Insurer termination notice (1 working day)' },
  { value: 'cash_in_lieu', label: 'Cash in lieu received' },
  { value: 'client_returned', label: 'Client returned the car' },
  { value: 'replacement_purchased', label: 'Replacement vehicle bought' },
  { value: 'manual', label: 'Other (say why in the notes)' },
];
const SEVERITIES: Array<{ value: DamageSeverity; label: string }> = [
  { value: 'cosmetic', label: 'Cosmetic' },
  { value: 'minor', label: 'Minor' },
  { value: 'major', label: 'Major (blocks hire)' },
  { value: 'unroadworthy', label: 'Unroadworthy (blocks hire)' },
];

interface DamageDraft {
  panel: string;
  description: string;
  severity: DamageSeverity;
}

export function ReturnDialog({ open, reservationId, onClose }: { open: boolean; reservationId: string; onClose: () => void }) {
  if (!open) return null;
  return <ReturnBody reservationId={reservationId} onClose={onClose} />;
}

function ReturnBody({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const toast = useToast();
  const booking = useBooking(reservationId);
  const [collectedAt, setCollectedAt] = useState(nowIso());
  const [endAt, setEndAt] = useState(nowIso());
  const [trigger, setTrigger] = useState<HireEndTrigger>('repair_complete_24h');
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState('8');
  const [notes, setNotes] = useState('');
  const [damage, setDamage] = useState<DamageDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const end = useBookingMutation(() =>
    bookingsApi.returnCar(reservationId, {
      collectedAt,
      endAt,
      endTrigger: trigger,
      odometerIn: Number(odometer),
      fuelEighths: Number(fuel),
      damage: damage.filter((d) => d.panel.trim() && d.description.trim()).map((d) => ({ ...d, evidenceIds: [] })),
      notes: notes.trim() || null,
    }),
  );
  const valid = Boolean(collectedAt && endAt) && /^\d+$/.test(odometer);

  const submit = async () => {
    setError(null);
    try {
      const out = await end.mutateAsync(undefined);
      const w = out.warnings.map((x) => x.message);
      toast.success(`Hire ${out.hire.agreementNumber} ended — valet and inspection booked on the car`);
      if (w.length) {
        setWarnings(w);
        return; // keep the dialog open so the owner reads the off-hire warning
      }
      onClose();
    } catch (e) {
      if (isApiError(e) && e.override) return;
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  const setRow = (i: number, patch: Partial<DamageDraft>) => setDamage((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal
      open
      size="lg"
      title={booking.data ? `Return — ${booking.data.registration}` : 'Return'}
      onClose={onClose}
      footer={
        warnings.length ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={end.isPending} disabled={!valid} onClick={() => void submit()}>
              End hire
            </Button>
          </>
        )
      }
    >
      {warnings.length > 0 ? (
        <div className="booking-notice" role="alert">
          {warnings.map((w, i) => (
            <p key={i} style={{ margin: 0 }}>
              ⚠ {w}
            </p>
          ))}
        </div>
      ) : (
        <div className="stack-sm">
          <div className="grid-2">
            <DateTimeInput label="Car collected at" value={collectedAt} onChange={(v) => setCollectedAt(v)} required />
            <DateTimeInput label="Contractual end of hire" value={endAt} onChange={(v) => setEndAt(v)} required hint="Normally the off-hire deadline for what ended the need; days after it are not recoverable." />
            <Select label="What ended the hire" value={trigger} onChange={(v) => v && setTrigger(v)} options={TRIGGERS} />
            <TextInput label="Odometer in (miles)" value={odometer} onChange={setOdometer} inputMode="numeric" required />
            <Select label="Fuel" value={fuel} onChange={setFuel} options={FUEL_OPTIONS} />
          </div>
          <fieldset className="booking-needs">
            <legend>Damage found</legend>
            {damage.length === 0 && <p className="muted small">None recorded.</p>}
            {damage.map((d, i) => (
              <div key={i} className="damage-row">
                <TextInput label="Panel" value={d.panel} onChange={(v) => setRow(i, { panel: v })} />
                <TextInput label="What" value={d.description} onChange={(v) => setRow(i, { description: v })} />
                <Select label="Severity" value={d.severity} onChange={(v) => v && setRow(i, { severity: v })} options={SEVERITIES} />
                <Button size="sm" variant="ghost" onClick={() => setDamage((rows) => rows.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button size="sm" onClick={() => setDamage((rows) => [...rows, { panel: '', description: '', severity: 'minor' }])}>
              Add damage
            </Button>
            <p className="muted small">Add photos on the Capture page; they are filed as evidence on the claim.</p>
          </fieldset>
          <TextArea label="Notes" value={notes} onChange={setNotes} rows={2} />
          <ErrorAlert message={error} />
        </div>
      )}
    </Modal>
  );
}
