import { useMemo } from 'react';
import { formatRegistration, formatGBP, normaliseRegistration } from '@ccguk/domain';
import type { StepProps } from './NewClaimPage';
import type { PartyRef } from '../../../api/client';
import { anyServiceAgreed, buildCreateClaimBody, buildFnolOffer, relaxedFnolErrors, STEPS, validateStep, vehicleSource, type Step } from './fnol';
import { useCatalogueFeatures, useCatalogueModel, segmentLabel } from '../../../api/vehiclesApi';
import { describeVehicle, featureLabels, SOURCE_LABEL } from '../../vehicles/vehiclePickerModel';
import { Checkbox, TextArea } from '../../../components/Form';
import { KeyValue } from '../../../components/KeyValue';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { formatDateTime } from '../../../lib/dates';
import { MANAGER_WARNING_PREFIX } from '../../../lib/managerMode';

/** The closing line of the review (0.3 §E8). */
export const OPEN_CLAIM_NOTE = 'Opening the claim saves it. Nothing is sent to the insurer.';

const CHANNEL_LABEL: Record<string, string> = { phone: 'Phone', whatsapp: 'WhatsApp', web_form: 'Web form', email: 'Email', in_person: 'In person' };
const DECISION_LABEL: Record<string, string> = { pending: 'Not decided yet', accepted: 'Accepted', declined: 'Declined' };

/** Which step a validation key belongs to, for the manager-mode summary's "Edit" links. */
function stepOfKey(key: string, state: Parameters<typeof validateStep>[1]): Step {
  for (const s of STEPS) if (key in validateStep(s.n, state)) return s.n;
  return 1;
}

/** Step 5 — services agreed, then a read-only review of exactly what will be saved. */
export function StepReview({ state, update, onEdit, managerOn = false }: StepProps & { onEdit: (s: Step) => void }) {
  const svc = state.services;
  const setSvc = (k: keyof typeof svc) => (v: boolean | string) => update((s) => ({ ...s, services: { ...s.services, [k]: v } }));
  const now = useMemo(() => new Date().toISOString(), []);
  const body = buildCreateClaimBody(state, { now });
  const offer = buildFnolOffer(state);
  const refName = (ref: PartyRef | undefined): string => (!ref ? '—' : 'id' in ref ? 'existing record' : ref.name);
  const relaxed = managerOn ? Object.entries(relaxedFnolErrors(state, true).warnings) : [];
  const claimant = 'id' in body.claimant ? undefined : body.claimant;
  const vehicleDetails = 'id' in body.vehicle ? undefined : body.vehicle;
  const source = vehicleSource(state.vehicle);
  const vocab = useCatalogueFeatures().data;
  const spec = vehicleDetails?.spec;
  const handSource = vehicleDetails?.source;
  const onFile = state.vehicle.onFile;
  const sourceBadge =
    source === 'on_file' ? (
      <Badge tone="blue">vehicle on file · existing record</Badge>
    ) : source === 'lookup' ? (
      <Badge tone="green">DVLA / DVSA lookup{'id' in body.vehicle ? ' · on file' : ''}</Badge>
    ) : (
      <span>
        {handSource ? SOURCE_LABEL[handSource.provider] : 'Typed by hand'} <Badge tone="amber">unverified</Badge>
      </span>
    );
  // "Volkswagen Golf · Mk7 (2013–2020) · Match Edition · 1.5 TSI EVO 150PS petrol" from the catalogue detail
  const cat = spec?.catalogue;
  const catModel = useCatalogueModel(cat?.makeSlug, cat?.modelSlug).data;
  const catGen = cat?.generationId ? catModel?.generations.find((g) => g.id === cat.generationId) : undefined;
  const catalogueMatch = cat
    ? [
        [vehicleDetails?.make, catModel?.name ?? vehicleDetails?.model].filter(Boolean).join(' '),
        catGen?.name ?? (cat.generationId ? 'generation matched' : ''),
        (cat.trimId ? catGen?.trims.find((t) => t.id === cat.trimId)?.name : undefined) ?? (cat.trimId ? 'trim matched' : ''),
        (cat.engineId ? catGen?.engines.find((e) => e.id === cat.engineId)?.label : undefined) ?? (cat.engineId ? 'engine matched' : '')
      ]
        .filter(Boolean)
        .join(' · ')
    : '—';
  const EditBtn = ({ step }: { step: Step }) => (
    <Button size="sm" variant="ghost" onClick={() => onEdit(step)}>
      Edit
    </Button>
  );

  return (
    <div className="stack">
      <h2>Services agreed</h2>
      <p className="muted small">
        Agreeing a service starts the clock for the New Claim Advice Form: due within 1 working day{' '}
        <span title="GTA 4.1 — used as a benchmark only; CCGUK is not a GTA subscriber" aria-label="Source: GTA 4.1, benchmark only; CCGUK is not a GTA subscriber">
          ⓘ
        </span>
      </p>
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
                { label: 'Channel', value: CHANNEL_LABEL[state.channel] ?? state.channel },
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
                {
                  label: 'Make / model',
                  value:
                    (vehicleDetails
                      ? [vehicleDetails.make, vehicleDetails.model, vehicleDetails.variant]
                      : onFile
                        ? [onFile.make, onFile.model, onFile.variant]
                        : state.vehicle.lookup?.status === 'ok'
                          ? [state.vehicle.lookup.vehicle.make, state.vehicle.lookup.vehicle.model, state.vehicle.lookup.vehicle.variant]
                          : []
                    )
                      .filter(Boolean)
                      .join(' ') || '—'
                },
                { label: 'Source', value: sourceBadge },
                { label: 'Year / engine / fuel', value: vehicleDetails ? describeVehicle({ make: '', model: '', variant: '', yearOfManufacture: vehicleDetails.yearOfManufacture, engineCapacityCc: vehicleDetails.engineCapacityCc, fuelType: vehicleDetails.fuelType, transmission: vehicleDetails.transmission }) || '—' : '—', hidden: !vehicleDetails },
                { label: 'Body', value: [vehicleDetails?.bodyType, spec?.doors ? `${spec.doors} doors` : '', spec?.seats ? `${spec.seats} seats` : ''].filter(Boolean).join(' · ') || '—', hidden: !vehicleDetails },
                { label: 'Power', value: spec?.powerPs ? `${spec.powerPs} PS` : '—', hidden: !spec?.powerPs },
                { label: 'Colour / VIN', value: [vehicleDetails?.colour, vehicleDetails?.vin].filter(Boolean).join(' · ') || '—', hidden: !vehicleDetails },
                { label: 'First registered / MOT / tax', value: [vehicleDetails?.monthOfFirstRegistration, vehicleDetails?.motExpiryDate ? `MOT ${vehicleDetails.motExpiryDate}` : '', vehicleDetails?.taxDueDate ? `tax ${vehicleDetails.taxDueDate}` : ''].filter(Boolean).join(' · ') || '—', hidden: !vehicleDetails },
                { label: 'Segment', value: segmentLabel(spec?.segment) ?? '—', hidden: !spec?.segment },
                { label: 'Catalogue match', value: catalogueMatch, hidden: !spec?.catalogue },
                { label: 'Standard features', value: spec?.features.length ? featureLabels(vocab, spec.features).join(', ') : '—', hidden: !spec?.features.length },
                { label: 'Added extras', value: spec?.extras.length ? featureLabels(vocab, spec.extras).join(', ') : '—', hidden: !spec?.extras.length },
                { label: 'Copied fields', value: handSource?.appliedFields?.length ? handSource.appliedFields.join(', ') : '—', hidden: handSource?.provider !== 'totalcarcheck_manual' },
                { label: 'Odometer (client)', value: vehicleDetails?.odometer?.[0] ? `${vehicleDetails.odometer[0].miles.toLocaleString('en-GB')} miles` : '—', hidden: !vehicleDetails?.odometer?.length },
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
                { label: 'Witnesses', value: body.witnesses?.length ? `${body.witnesses.map((w) => w.name).join(', ')} (recorded as witnesses; checked for connections to the client)` : 'None — the question was asked' },
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
            <EditBtn step={4} />
          </div>
          <div className="card-body">
            {offer ? (
              <KeyValue
                items={[
                  { label: 'Offered by', value: offer.offerorName },
                  { label: 'When / how', value: `${offer.receivedAt ? formatDateTime(offer.receivedAt) : 'time not given'} · ${offer.channel}` },
                  { label: 'What', value: [offer.vehicleClassOffered, offer.terms?.otherTerms].filter(Boolean).join(' — ') || 'as described by the client' },
                  { label: 'Rate', value: offer.dailyRatePence !== undefined ? `${formatGBP(offer.dailyRatePence)}/day ${offer.rateIncludesVat ? 'inc VAT' : 'ex VAT'}` : 'none stated' },
                  { label: "Client's decision", value: DECISION_LABEL[state.offer.clientDecision] ?? state.offer.clientDecision },
                  { label: 'Reply due', value: <Badge tone="amber">within 1 working day</Badge> }
                ]}
              />
            ) : (
              <p className="small">No vehicle offer reported. The register stays empty; if an offer arrives later, log it from the claim file.</p>
            )}
          </div>
        </div>
      </div>
      {relaxed.length > 0 && (
        <div className="manager-note" role="status">
          <strong>{MANAGER_WARNING_PREFIX}the claim opens with these gaps and an “intake incomplete” flag listing them.</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {relaxed.map(([key, msg]) => (
              <li key={key}>
                {msg}{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(stepOfKey(key, state))}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="notice">
        <strong>{OPEN_CLAIM_NOTE}</strong> The first document (New Claim Advice Form) is drafted, checked and approved on the claim file.
      </div>
    </div>
  );
}
