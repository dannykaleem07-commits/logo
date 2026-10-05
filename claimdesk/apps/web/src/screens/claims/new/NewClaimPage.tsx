import { useCallback, useEffect, useMemo, useState } from 'react';
import { flagName } from '../../../lib/flagNames';
import { plainText } from '../../../lib/plainText';
import { useNavigate } from 'react-router-dom';
import type { ClaimFlag } from '@ccguk/domain';
import { api, fnolErrorLines, withRelaxed } from '../../../api/client';
import { useInvalidateClaim, useMe } from '../../../api/hooks';
import { useManagerMode } from '../../../app/managerMode';
import { managerWarning, relaxedKeys } from '../../../lib/managerMode';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { useToast } from '../../../components/Toast';
import { LAST_STEP, STEPS, type FnolState, type KnownParty, type Step, type StepErrors, initialFnolState, relaxedStepErrors, relaxedFnolErrors, firstBlockingStep, buildCreateClaimBody, buildFollowUpEvents, buildOfferDecision } from './fnol';
import { StepDisclosure } from './StepDisclosure';
import { StepParties } from './StepParties';
import { StepVehicle } from './StepVehicle';
import { StepAccident } from './StepAccident';
import { StepReview } from './StepReview';

export interface StepProps {
  state: FnolState;
  update: (patch: Partial<FnolState> | ((s: FnolState) => FnolState)) => void;
  errors: StepErrors;
  /** Manager mode: relaxed checks, already prefixed "Allowed in manager mode: " (amber, never blocking). */
  warnings?: StepErrors;
  managerOn?: boolean;
}

/** Insurers already on file, so the claim references them by id instead of creating a duplicate party per claim. */
async function knownInsurers(state: FnolState): Promise<KnownParty[]> {
  const names = [state.thirdParty.insurerName, state.clientInsurer.name].map((n) => n.trim()).filter(Boolean);
  const out: KnownParty[] = [];
  for (const name of names) {
    try {
      out.push(...(await api.getParties({ q: name, role: 'insurer', limit: 10 })));
    } catch {
      // lookup is an optimisation only; the API creates the insurer party when no id is given
    }
  }
  return out;
}

/**
 * FNOL wizard, five steps (0.3 §E6): disclosure → claimant & driver → vehicle (lookup / manual, duplicate banner) →
 * accident & offers (own words, injuries → referral, then the script guard: vehicle offers → intervention register) →
 * services & review → submit: one POST /claims (claim, insurers, third party, witnesses, inline offer, services
 * agreed, injury referral, intake answers), then a services note, then the client's decision on the offer.
 *
 * Manager mode (§A.7): every step is clickable and only the five values the API needs block (`fnolHardKeys`); every
 * other check is an amber warning, the relaxed rule keys go with the POST (audited as WEB_VALIDATION) and the server
 * opens the claim with an "intake incomplete" flag (FNOL_INCOMPLETE override).
 */
export function NewClaimPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateClaim();
  const managerOn = useManagerMode().on;
  const meId = useMe().data?.id;
  const [state, setState] = useState<FnolState>(initialFnolState);
  const [step, setStep] = useState<Step>(1);
  const [touched, setTouched] = useState<Set<Step>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const update = useCallback<StepProps['update']>((patch) => {
    setState((s) => (typeof patch === 'function' ? patch(s) : { ...s, ...patch }));
  }, []);

  // E7: the handler defaults to the signed-in user.
  useEffect(() => {
    if (meId) setState((s) => (s.handlerId ? s : { ...s, handlerId: meId }));
  }, [meId]);

  const relaxed = useMemo(() => relaxedStepErrors(step, state, managerOn), [step, state, managerOn]);
  const shown = touched.has(step);
  const errors = shown ? relaxed.errors : {};
  const warnings = useMemo(() => {
    if (!shown || !managerOn) return {};
    const out: StepErrors = {};
    for (const [k, msg] of Object.entries(relaxed.warnings)) out[k] = managerWarning(msg) ?? msg;
    return out;
  }, [shown, managerOn, relaxed]);
  const maxReached = useMemo(() => {
    if (managerOn) return LAST_STEP; // every step is clickable in manager mode
    let last: Step = 1;
    for (const s of STEPS) {
      if (Object.keys(relaxedStepErrors(s.n, state, false).errors).length > 0) break;
      last = s.n;
    }
    return Math.min(LAST_STEP, last + 1) as Step;
  }, [state, managerOn]);

  const goNext = () => {
    const errs = relaxedStepErrors(step, state, managerOn).errors;
    setTouched((t) => new Set(t).add(step));
    if (Object.keys(errs).length > 0) {
      toast.warn('Complete the highlighted fields before continuing.');
      return;
    }
    if (step < LAST_STEP) setStep((step + 1) as Step);
  };
  const goBack = () => step > 1 && setStep((step - 1) as Step);

  const submit = async () => {
    const invalid = firstBlockingStep(state, managerOn);
    if (invalid) {
      setTouched(new Set(STEPS.map((s) => s.n)));
      setStep(invalid);
      toast.warn(managerOn ? 'Even in manager mode a claim needs the claimant’s name, a registration, the accident date and time, the location and the client’s account.' : 'Some steps are incomplete.');
      return;
    }
    const relaxedRules = managerOn ? relaxedKeys('fnol', relaxedFnolErrors(state, true).warnings) : [];
    setSubmitting(true);
    setSubmitError(null);
    const now = new Date().toISOString();
    let claimId: string | undefined;
    try {
      const known = await knownInsurers(state);
      const body = buildCreateClaimBody(state, { now, knownParties: known });
      const { claim, intake } = await api.createClaim(relaxedRules.length ? withRelaxed(body, relaxedRules) : body);
      claimId = claim.id;
      const problems: string[] = [];

      // The API created the witness parties and ran the connected-party check (intake.witnesses / NON_INDEPENDENT_WITNESS flag).
      for (const ev of buildFollowUpEvents(state, now)) {
        try {
          await api.postEvent(claim.id, ev);
        } catch (e) {
          problems.push(`note "${ev.summary}": ${(e as Error).message}`);
        }
      }

      // The offer itself went inline with the FNOL; a decision already given is recorded on the register entry.
      const decision = buildOfferDecision(state, now);
      if (decision) {
        let offerId = intake?.offer?.id;
        if (!offerId) {
          try {
            const offers = await api.getOffers(claim.id);
            offerId = offers.find((o) => o.offerorName.trim().toLowerCase() === state.offer.offerorName.trim().toLowerCase())?.id;
          } catch {
            offerId = undefined;
          }
        }
        if (!offerId) problems.push("client's decision on the offer: the register entry could not be found — record it on the Offers tab");
        else {
          try {
            await api.updateOffer(claim.id, offerId, decision);
          } catch (e) {
            problems.push(`client's decision on the offer: ${(e as Error).message}`);
          }
        }
      }

      invalidate(claim.id);
      const flags: ClaimFlag[] = intake?.flags ?? claim.flags ?? [];
      const hardStop = flags.find((f) => f.severity === 'block' && !f.clearedAt);
      if (hardStop) toast.error(`Claim ${claim.reference} opened with a hard stop (${flagName(hardStop.code)}): ${plainText(hardStop.message)}`);
      else if (flags.length) toast.warn(`Claim ${claim.reference} opened with ${flags.length} flag${flags.length === 1 ? '' : 's'}: ${flags.map((f) => flagName(f.code)).join(', ')} — see the Flags tab`);
      if (problems.length) toast.warn(`Some follow-ups failed: ${problems.join('; ')}. Add them from the claim file.`);
      else if (!hardStop && !flags.length) toast.success(`Claim ${claim.reference} opened.`);
      navigate(`/claims/${claim.id}`);
    } catch (e) {
      const lines = fnolErrorLines(e);
      const msg = lines.length ? `${(e as Error).message}: ${lines.join('; ')}` : (e as Error).message;
      setSubmitError(msg);
      toast.error(`Could not open the claim: ${(e as Error).message}`);
      if (claimId) navigate(`/claims/${claimId}`);
    } finally {
      setSubmitting(false);
    }
  };

  const props: StepProps = { state, update, errors, warnings, managerOn };

  return (
    <div className="page">
      <PageHeader title="New claim" subtitle="First notification of loss" crumbs={[{ label: 'Claims', to: '/claims' }, { label: 'New claim' }]} />
      <Card>
        <ol className="wizard-steps" aria-label="Steps">
          {STEPS.map((s) => {
            const cls = s.n === step ? 'current' : s.n < maxReached ? 'done' : '';
            return (
              <li key={s.n}>
                <button
                  type="button"
                  className={`wizard-step ${cls}`}
                  onClick={() => s.n <= maxReached && setStep(s.n)}
                  disabled={s.n > maxReached}
                  aria-current={s.n === step ? 'step' : undefined}
                >
                  <span className="n">{s.n}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
        <div style={{ marginTop: 20 }}>
          {step === 1 && <StepDisclosure {...props} />}
          {step === 2 && <StepParties {...props} />}
          {step === 3 && <StepVehicle {...props} />}
          {step === 4 && <StepAccident {...props} />}
          {step === 5 && <StepReview {...props} onEdit={setStep} />}
        </div>
        {submitError && (
          <div className="notice notice-danger" style={{ marginTop: 16 }} role="alert">
            {submitError}
          </div>
        )}
        <div className="wizard-footer">
          <Button onClick={goBack} disabled={step === 1 || submitting}>
            Back
          </Button>
          {step < LAST_STEP ? (
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={submit} loading={submitting}>
              Open claim
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
