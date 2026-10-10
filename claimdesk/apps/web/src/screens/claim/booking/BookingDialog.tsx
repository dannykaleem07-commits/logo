// owned by ap-booking
/**
 * Booking dialog (docs/SUPREME-AUTOPILOT.md §I.2): opened by "Find a car" (Hire tab, Autopilot tab, choose_car card)
 * and from an empty calendar cell. Left: the period (prefilled from the projected hire, with why), the use and the
 * needs checklist (edits saved to the claim's hire needs). Right: the ranked cars with factor chips, the pricing guide
 * figures and the driver outcome, then "Not available (n)" with every reason. Under them the Clash panel for the
 * selected car. Actions: Hold for 24 h, Hold and offer to client, Book now (client present). A class A refusal opens
 * the global "Override as manager" prompt (the client's override flow); a car taken a moment ago refreshes the list.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AvailabilityCandidate, FleetUse, HireNeeds } from '@ccguk/domain';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { Checkbox, DateTimeInput, Select, TextInput } from '../../../components/Form';
import { Money } from '../../../components/Money';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Loading } from '../../../components/Spinner';
import { useToast } from '../../../components/Toast';
import { isApiError } from '../../../api/client';
import { bookingsApi, factorChip, useAvailability, useBookingMutation, useClaimBookings, type ReservationView } from '../../../api/bookingsApi';
import { clashApi, useClashCheck } from '../../../api/clashApi';
import { useManagerMode } from '../../../app/managerMode';
import { ClashPanel } from '../components/ClashPanel';
import '../../fleet/booking.css';

export interface BookingDialogProps {
  open: boolean;
  claimId: string;
  onClose: () => void;
  /** Preselect a car (calendar cell, choose_car card). */
  initialUnitId?: string;
  /** Preset start (calendar cell). */
  initialStartAt?: string;
  onBooked?: (r: ReservationView) => void;
}

const USE_OPTIONS: Array<{ value: FleetUse; label: string }> = [
  { value: 'credit_hire', label: 'Credit hire' },
  { value: 'self_drive', label: 'Self-drive' },
  { value: 'pco', label: 'PCO / private hire' },
];

const OUTCOME_TONE = { eligible: 'green', refer: 'amber', ineligible: 'red', unknown: 'grey' } as const;
const OUTCOME_TEXT = { eligible: 'Driver eligible', refer: 'Driver needs referral', ineligible: 'Driver not eligible', unknown: 'Driver not assessed' } as const;

type NeedsDraft = Pick<HireNeeds, 'automaticOnly' | 'automaticPreferred' | 'towbar' | 'wheelchairAccessible' | 'handControls' | 'largeBoot' | 'isofixCount' | 'seatsMin' | 'evOk'>;

export function BookingDialog({ open, claimId, onClose, initialUnitId, initialStartAt, onBooked }: BookingDialogProps) {
  if (!open) return null;
  return <BookingDialogBody claimId={claimId} onClose={onClose} initialUnitId={initialUnitId} initialStartAt={initialStartAt} onBooked={onBooked} />;
}

function BookingDialogBody({ claimId, onClose, initialUnitId, initialStartAt, onBooked }: Omit<BookingDialogProps, 'open'>) {
  const toast = useToast();
  const manager = useManagerMode();
  const [startAt, setStartAt] = useState<string>(initialStartAt ?? '');
  const [expectedEndAt, setExpectedEndAt] = useState<string>('');
  const [use, setUse] = useState<FleetUse>('credit_hire');
  const [selected, setSelected] = useState<string | undefined>(initialUnitId);
  const [substitution, setSubstitution] = useState('');
  const [needs, setNeeds] = useState<NeedsDraft | null>(null);
  const [needsDirty, setNeedsDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => ({ claimId, startAt: startAt || null, expectedEndAt: expectedEndAt || null, use }), [claimId, startAt, expectedEndAt, use]);
  const avail = useAvailability(query);
  const bookings = useClaimBookings(claimId);
  const live = (bookings.data?.reservations ?? []).find((r) => r.status === 'held' || r.status === 'confirmed');

  // Prefill the period and the needs from the first answer (the projected hire).
  useEffect(() => {
    const d = avail.data;
    if (!d) return;
    if (!startAt) setStartAt(d.period.startAt);
    if (!expectedEndAt) setExpectedEndAt(d.period.expectedEndAt);
    if (!needs) setNeeds({ automaticOnly: d.needs.automaticOnly, automaticPreferred: d.needs.automaticPreferred, towbar: d.needs.towbar, wheelchairAccessible: d.needs.wheelchairAccessible, handControls: d.needs.handControls, largeBoot: d.needs.largeBoot, isofixCount: d.needs.isofixCount, seatsMin: d.needs.seatsMin, evOk: d.needs.evOk });
    if (!selected && d.ranked[0]) setSelected(d.ranked[0].fleetUnitId);
  }, [avail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const ranked = avail.data?.ranked ?? [];
  const excluded = avail.data?.excluded ?? [];
  const chosen: AvailabilityCandidate | undefined = ranked.find((c) => c.fleetUnitId === selected);
  const higher = chosen?.likeForLike.group.relation === 'higher';

  const clash = useClashCheck(chosen && avail.data ? { claimId, fleetUnitId: chosen.fleetUnitId, startAt: avail.data.period.startAt, expectedEndAt: avail.data.period.expectedEndAt, use, stage: 'hold', ...(live ? { excludeReservationId: live.id } : {}) } : undefined);

  const hold = useBookingMutation((v: { confirm: boolean }) =>
    bookingsApi.hold(claimId, {
      fleetUnitId: chosen!.fleetUnitId,
      use,
      startAt: avail.data!.period.startAt,
      expectedEndAt: avail.data!.period.expectedEndAt,
      ...(higher && substitution.trim() ? { substitutionReason: substitution.trim() } : {}),
      ...(live ? { replaceReservationId: live.id } : {}),
      confirm: v.confirm,
    }),
  );

  const saveNeeds = async () => {
    if (!needs) return;
    try {
      await clashApi.saveHireNeeds(claimId, needs);
      setNeedsDirty(false);
      void avail.refetch();
      toast.success('Hire needs saved');
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  const submit = async (mode: 'hold' | 'offer' | 'book') => {
    setError(null);
    setNotice(null);
    try {
      const out = await hold.mutateAsync({ confirm: mode === 'book' });
      const r = out.reservation;
      const warn = out.warnings.length ? ` (${out.warnings.length} warning${out.warnings.length === 1 ? '' : 's'} to read)` : '';
      if (mode === 'book') toast.success(`${r.registration} booked — agreement ${r.agreementNumber ?? ''}${warn}`);
      else if (mode === 'offer') toast.success(`${r.registration} held. The autopilot prepares the hire offer for you to check before it goes${warn}.`);
      else toast.success(`${r.registration} held for 24 hours${warn}`);
      onBooked?.(r);
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'RESERVATION_OVERLAP' && !e.override) {
        setNotice('That car was taken a moment ago — the list has been refreshed.');
        void avail.refetch();
        return;
      }
      if (isApiError(e) && e.override) return; // the manager-override prompt handled it (or was cancelled)
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  const setNeed = <K extends keyof NeedsDraft>(k: K, v: NeedsDraft[K]) => {
    setNeeds((n) => (n ? { ...n, [k]: v } : n));
    setNeedsDirty(true);
  };

  return (
    <Modal
      open
      size="lg"
      title="Find a car"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={!chosen || hold.isPending || (higher && !substitution.trim())} onClick={() => void submit('hold')}>
            Hold for 24 h
          </Button>
          <Button disabled={!chosen || hold.isPending || (higher && !substitution.trim())} onClick={() => void submit('offer')}>
            Hold and offer to client
          </Button>
          <Button variant="primary" loading={hold.isPending} disabled={!chosen || (higher && !substitution.trim())} onClick={() => void submit('book')}>
            Book now (client present)
          </Button>
        </>
      }
    >
      <div className="booking-dialog">
        <section className="booking-left stack-sm" aria-label="Period and needs">
          <DateTimeInput label="Start" value={startAt} onChange={(v) => setStartAt(v)} />
          <DateTimeInput label="Expected end" value={expectedEndAt} onChange={(v) => setExpectedEndAt(v)} hint={avail.data?.projection?.why.join(' ')} />
          <Select label="Use" value={use} onChange={(v) => v && setUse(v)} options={USE_OPTIONS} />
          {live && (
            <p className="small muted">
              This claim already has {live.registration} {live.status === 'held' ? 'held' : 'booked'} — a new choice replaces it.
            </p>
          )}
          {needs && (
            <fieldset className="booking-needs">
              <legend>Needs</legend>
              <Checkbox label="Automatic only" checked={needs.automaticOnly} onChange={(v) => setNeed('automaticOnly', v)} />
              <Checkbox label="Automatic preferred" checked={needs.automaticPreferred} onChange={(v) => setNeed('automaticPreferred', v)} />
              <TextInput label="Seats at least" type="number" value={needs.seatsMin === null ? '' : String(needs.seatsMin)} onChange={(v) => setNeed('seatsMin', v ? Math.max(1, Math.min(9, Number(v))) : null)} />
              <TextInput label="ISOFIX child seats" type="number" value={String(needs.isofixCount)} onChange={(v) => setNeed('isofixCount', Math.max(0, Math.min(4, Number(v) || 0)))} />
              <Checkbox label="Large boot" checked={needs.largeBoot} onChange={(v) => setNeed('largeBoot', v)} />
              <Checkbox label="Tow bar" checked={needs.towbar} onChange={(v) => setNeed('towbar', v)} />
              <Checkbox label="Wheelchair accessible" checked={needs.wheelchairAccessible} onChange={(v) => setNeed('wheelchairAccessible', v)} />
              <Checkbox label="Hand controls" checked={needs.handControls} onChange={(v) => setNeed('handControls', v)} />
              <Checkbox label="Cannot use an electric car" checked={needs.evOk === false} onChange={(v) => setNeed('evOk', v ? false : null)} />
              <Button size="sm" disabled={!needsDirty} onClick={() => void saveNeeds()}>
                Save needs and search again
              </Button>
            </fieldset>
          )}
        </section>

        <section className="booking-right stack-sm" aria-label="Cars">
          {notice && (
            <p className="booking-notice" role="status">
              {notice}
            </p>
          )}
          <ErrorAlert message={error} />
          {avail.isLoading && <Loading label="Searching the fleet…" />}
          {avail.isError && <ErrorAlert message={(avail.error as Error).message} />}
          {avail.data && (
            <>
              <ul className="booking-explain small">
                {avail.data.explanation.slice(0, 3).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {ranked.length === 0 && <p className="muted">No car is free, legal and ready for the whole period.</p>}
              <div role="radiogroup" aria-label="Ranked cars" className="booking-ranked">
                {ranked.map((c, i) => (
                  <label key={c.fleetUnitId} className={`booking-car${c.fleetUnitId === selected ? ' selected' : ''}`}>
                    <input type="radio" name="booking-car" value={c.fleetUnitId} checked={c.fleetUnitId === selected} onChange={() => setSelected(c.fleetUnitId)} />
                    <div className="booking-car-body">
                      <div className="row-between">
                        <span>
                          <span className="bk-plate">{c.registration}</span> <strong>{c.label}</strong>
                          {i === 0 && avail.data!.clearWinner && <Badge tone="green">Best match</Badge>}
                        </span>
                        <span className="booking-score" aria-label={`Score ${c.score} of 100`}>
                          <span className="booking-score-bar" style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
                          <span className="booking-score-num">{c.score}</span>
                        </span>
                      </div>
                      <div className="chip-row">
                        {Object.entries(c.factors).map(([k, f]) => (
                          <span key={k} className={`booking-chip${f.score >= 0.8 ? ' good' : f.score < 0.5 ? ' poor' : ''}`} title={`${k}: ${f.score} × weight ${f.weight}`}>
                            {factorChip(k, f)}
                          </span>
                        ))}
                      </div>
                      <div className="small row">
                        <span>
                          Fleet rate <Money pence={c.pricing.fleetDailyRatePence} />
                          /day
                        </span>
                        {c.pricing.clientCar.dailyRatePence !== null && (
                          <span className="muted">
                            like-for-like guide <Money pence={c.pricing.clientCar.dailyRatePence} />
                            /day (GTA benchmark only)
                          </span>
                        )}
                        <Badge tone={OUTCOME_TONE[c.driverOutcome]}>{OUTCOME_TEXT[c.driverOutcome]}</Badge>
                      </div>
                      {c.warnings.length > 0 && (
                        <ul className="booking-warnings small">
                          {c.warnings.map((w) => (
                            <li key={w.dedupeKey}>⚠ {w.message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              {higher && <TextInput label="Why a higher group? (substitution reason — required; only the like-for-like rate is recoverable)" value={substitution} onChange={setSubstitution} />}
              {excluded.length > 0 && (
                <details className="booking-excluded">
                  <summary>Not available ({excluded.length})</summary>
                  <ul>
                    {excluded.map((e) => (
                      <li key={e.fleetUnitId}>
                        <span className="bk-plate">{e.registration}</span> — {e.reasons.map((r) => r.message).join('; ')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {chosen && (
                <div className="booking-clashes">
                  <h3 className="small strong">Clash checks for {chosen.registration}</h3>
                  {clash.isLoading ? (
                    <Loading label="Checking…" />
                  ) : (
                    <ClashPanel
                      findings={clash.data?.findings ?? []}
                      managerMode={manager.on}
                      onAcknowledge={(id, reason) => void clashApi.acknowledge(id, reason).then(() => clash.refetch())}
                      onOverride={() => void submit('hold')}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
