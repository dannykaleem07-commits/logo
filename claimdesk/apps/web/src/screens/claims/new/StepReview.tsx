import { useMemo } from 'react';
import { formatRegistration, formatGBP, normaliseRegistration } from '@ccguk/domain';
import type { StepProps } from './NewClaimPage';
import type { PartyRef } from '../../../api/client';
import { anyServiceAgreed, buildCreateClaimBody, buildFnolOffer, vehicleSource, type Step } from './fnol';
import { Checkbox, TextArea } from '../../../components/Form';
import { KeyValue } from '../../../components/KeyValue';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { formatDateTime } from '../../../lib/dates';

/** Step 6 — services agreed, then a read-only review of exactly what will be posted. */
export function StepReview({ state, update, onEdit }: StepProps & { onEdit: (s: Step) => void }) {
  const svc = state.services;
  const setSvc = (k: keyof typeof svc) => (v: boolean | string) => update((s) => ({ ...s, services: { ...s.services, [k]: v } }));
  const now = useMemo(() => new Date().toISOString(), []);
  const body = buildCreateClaimBody(state, { now });
  const offer = buildFnolOffer(state);
  const refName = (ref: PartyRef | undefined): string => (!ref ? '—' : 'id' in ref ? `existing party ${ref.id}` : ref.name);
  const claimant = 'id' in body.claimant ? undefined : body.claimant;
  const vehicleDetails = 'id' in body.vehicle ? undefined : body.vehicle;
  const source = vehicleSource(state.vehicle);
  const EditBtn = ({ step }: { step: Step }) => (
    <Button size="sm" variant="ghost" onClick={() => onEdit(step)}>
      Edit
    </Button>
  );

  return (
    <div className="stack">
      <h2>Services agreed</h2>
      <p className="muted small">Agreeing a service starts the GTA 4.1 clock: the New Claim Advice Form is due within 1 working day (benchmark; CCGUK is not a subscriber).</p>
      <div className="grid-2">
        <Checkbox label="Credit hire" checked={svc.hire} onChange={setSvc('hire')} hint="Replacement vehicle on credit; need, period, rate and impecuniosity evidence gates apply." />
        <Checkbox label="Recovery" checked={svc.recovery} onChange={setSvc('recovery')} hint="£90 call-out + £3/loaded mile + £25 admin (rate card)." />
        <Checkbox label="Storage" checked={svc.storage} onChange={setSvc('storage')} hint="£45/day; insurers commonly cap at engineer's report + 48 h." />
        <Checkbox label="Engineer's inspection" checked={svc.engineer} onChange={setSvc('engineer')} hint="Independent report; fee note produced with the instruction date." />
      </div>
      <TextArea label="Notes on services" value={svc.notes} onChange={(v) => setSvc('notes')(v)} rows={2} />
      {!anyServiceAgreed(svc) && <div className="notice notice-warn">No service is agreed yet. The claim opens at FNOL/triage and the NCAF clock will not start until a service is agreed.</div>}

      <h2>Review</h2>
      <div className="grid-2">
        <div className="card review-block">
          <div className="card-header">
            <span className="card-title">Disclosure & claimant</span>
            <EditBtn step={2} />
          </div>
          <div className="card-body">
            <KeyValue
              items={[
                { label: 'Disclosure read', value: formatDateTime(state.disclosure.readAt) },
                { label: 'Channel', value: state.channel },
                { label: 'Claimant', value: refName(body.claimant) },
                { label: 'Contact', value: [claimant?.phone, claimant?.email].filter(Boolean).join(' · ') || '—' },
                { label: 'Driver', value: body.driver ? refName(body.driver) : 'Claimant was driving' },
                { label: 'Own insurer', value: body.clientInsurer || body.clientPolicyNumber ? [body.clientInsurer ? refName(body.clientInsurer) : undefined, body.clientPolicyNumber].filter(Boolean).join(' · ') : '—' }
              ]}
            />
          </div>
        </div>
        <div className="card review-block">
          <div className="card-header">
            <span className="card-title">Vehicle</span>
            <EditBtn step={3} />
          </div>
          <div className="card-body">
            <KeyValue
              items={[
                { label: 'Registration', value: <span className="reg-plate">{formatRegistration(normaliseRegistration(state.vehicle.registration))}</span> },
                { label: 'Make / model', value: (vehicleDetails ? [vehicleDetails.make, vehicleDetails.model, vehicleDetails.variant] : state.vehicle.lookup?.status === 'ok' ? [state.vehicle.lookup.vehicle.make, state.vehicle.lookup.vehicle.model, state.vehicle.lookup.vehicle.variant] : []).filter(Boolean).join(' ') || '—' },
                { label: 'Source', value: source === 'manual' ? <Badge tone="amber">manual · unverified</Badge> : <Badge tone="green">DVLA / DVSA lookup{'id' in body.vehicle ? ' · on file' : ''}</Badge> },
                { label: 'Linked claims', value: state.vehicle.lookup?.linkedClaims?.length ? <Badge tone="amber">{state.vehicle.lookup.linkedClaims.length} — linked file will be created</Badge> : 'None' }
              ]}
            />
          </div>
        </div>
        <div className="card review-block">
          <div className="card-header">
            <span className="card-title">Accident</span>
            <EditBtn step={4} />
          </div>
          <div className="card-body">
            <KeyValue
              items={[
                { label: 'When', value: formatDateTime(body.accident.occurredAt) },
                { label: 'Where', value: body.accident.location },
                { label: 'Third party', value: [state.thirdParty.registrationUnknown ? 'registration unknown (failed to stop)' : state.thirdParty.registration.trim() && formatRegistration(normaliseRegistration(state.thirdParty.registration)), state.thirdParty.driverName.trim(), body.atFaultInsurer ? refName(body.atFaultInsurer) : ''].filter(Boolean).join(' · ') || '—' },
                { label: 'Witnesses', value: body.witnesses?.length ? `${body.witnesses.map((w) => w.name).join(', ')} (the API records them as witness parties and runs the connected-party check)` : 'None — the question was asked' },
                { label: 'Account taken cold', value: body.takenCold ? 'Confirmed' : <Badge tone="amber">not confirmed</Badge> },
                { label: 'Injuries', value: body.accident.injuries ? <Badge tone="amber">Yes — referral out, no fee</Badge> : 'No' },
                { label: 'Roadworthy / driveable / airbags', value: `${body.accident.roadworthyAfter ? 'yes' : 'no'} / ${body.accident.driveable ? 'yes' : 'no'} / ${body.accident.airbagsDeployed ? 'deployed' : 'not deployed'}` }
              ]}
            />
            <p className="small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
              <span className="muted">Own words: </span>
              {body.accident.circumstances}
            </p>
          </div>
        </div>
        <div className="card review-block">
          <div className="card-header">
            <span className="card-title">Vehicle offers</span>
            <EditBtn step={5} />
          </div>
          <div className="card-body">
            {offer ? (
              <KeyValue
                items={[
                  { label: 'Offered by', value: offer.offerorName },
                  { label: 'When / how', value: `${offer.receivedAt ? formatDateTime(offer.receivedAt) : 'time not given'} · ${offer.channel}` },
                  { label: 'What', value: [offer.vehicleClassOffered, offer.terms?.otherTerms].filter(Boolean).join(' — ') || 'as described by the client' },
                  { label: 'Rate', value: offer.dailyRatePence !== undefined ? `${formatGBP(offer.dailyRatePence)}/day ${offer.rateIncludesVat ? 'inc VAT' : 'ex VAT'}` : 'none stated' },
                  { label: "Client's decision", value: state.offer.clientDecision },
                  { label: 'Reply due', value: <Badge tone="amber">within 1 working day</Badge> }
                ]}
              />
            ) : (
              <p className="small">No vehicle offer reported. The register stays empty; if an offer arrives later, log it from the claim file.</p>
            )}
          </div>
        </div>
      </div>
      <div className="notice">
        <strong>On submit:</strong> one POST /claims (claimant, vehicle, accident{body.atFaultInsurer ? ', at-fault insurer' : ''}{anyServiceAgreed(svc) ? ', services agreed → GTA 4.1 clock' : ''}{offer ? ', intervention offer → 1 WD reply clock' : ''}{body.injuryReferralTo ? ', injury referral task (no fee)' : ''}){state.offer.clientDecision !== 'pending' && offer ? " → client's decision on the register" : ''}. Nothing is sent to any insurer. The first document (New Claim Advice Form) is drafted, checked and approved on the claim file.
      </div>
    </div>
  );
}
