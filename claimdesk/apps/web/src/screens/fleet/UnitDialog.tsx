import { useEffect, useMemo, useState } from 'react';
import { ErrorAlert } from '../../components/ErrorAlert';
import type { FleetUnit, FleetUse, InsurancePolicy } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { isApiError } from '../../api/client';
import { useCreateFleetUnit } from '../../api/hooks';
import { useCreateFleetPolicy, useFleetPolicies, useLookupMode, type PolicyBody } from '../../api/vehiclesApi';
import { Button } from '../../components/Button';
import { Checkbox, DateInput, Field, Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { todayISO } from '../../lib/dates';
import { CopyDetailsPanel } from '../vehicles/CopyDetailsPanel';
import { VehiclePicker } from '../vehicles/VehiclePicker';
import { pickerFromVehicle, emptyPickerValue, type VehiclePickerValue } from '../vehicles/vehiclePickerModel';
import { buildUnitBody, buildUnitPatch, emptyUnitForm, FLEET_USES, FLEET_USE_LABEL, unitRegistration, unitToForm, UNIT_STATUSES, UNIT_STATUS_LABEL, validateUnitForm, type FleetUnitView, type UnitForm, type UnitFormErrors } from './fleet';
import { useUpdateFleetUnit } from './fleetApi';
import { FleetGtaPanel } from './FleetGtaPanel';

const ADD_POLICY = '__add_policy__';

function policyLabel(p: InsurancePolicy): string {
  return `${p.insurerName} · ${p.policyNumber} · ${p.coveredUses.map((u) => FLEET_USE_LABEL[u]).join(', ')} · to ${p.endDate}`;
}

/**
 * Add / edit a fleet unit (§F.1): the vehicle from the catalogue, a Total Car Check paste or typed (VehiclePicker,
 * fleet mode); the GTA group and daily rate pre-filled from the benchmark suggestion until edited; the policy from the
 * policies on file (or a new one). Pounds in the rate box, pence over the wire.
 */
export function UnitDialog({ open, unit, onClose }: { open: boolean; unit: FleetUnitView | null; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateFleetUnit();
  const update = useUpdateFleetUnit();
  const policiesQ = useFleetPolicies();
  const lookupMode = useLookupMode() ?? 'manual';
  const today = todayISO();
  const isNew = !unit;
  const [form, setForm] = useState<UnitForm>(() => (unit ? unitToForm(unit) : emptyUnitForm()));
  const [initialVehicle, setInitialVehicle] = useState<VehiclePickerValue>(() => (unit?.vehicle ? pickerFromVehicle(unit.vehicle) : emptyPickerValue()));
  const [errors, setErrors] = useState<UnitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [addingPolicy, setAddingPolicy] = useState(false);

  useEffect(() => {
    if (open) {
      const f = unit ? unitToForm(unit) : emptyUnitForm();
      setForm(f);
      setInitialVehicle(f.vehicle);
      setErrors({});
      setServerError(null);
    }
  }, [open, unit]);

  const set = <K extends keyof UnitForm>(k: K) => (v: UnitForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleUse = (use: FleetUse) => (on: boolean) => setForm((f) => ({ ...f, declaredUses: on ? [...new Set([...f.declaredUses, use])] : f.declaredUses.filter((u) => u !== use) }));

  const submit = async () => {
    const e = validateUnitForm(form, isNew);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setServerError(null);
    try {
      if (unit) {
        const res = await update.mutateAsync({ id: unit.id, body: buildUnitPatch(form, initialVehicle) });
        if (res?.warnings?.length) toast.warn(`Unit updated. ${res.warnings.length === 1 ? 'One vehicle value differs' : `${res.warnings.length} vehicle values differ`} from the verified DVLA/DVSA record (${res.warnings.map((w) => w.field).join(', ')}).`);
        else toast.success('Unit updated');
      } else {
        await create.mutateAsync(buildUnitBody(form));
        toast.success('Unit added to the fleet register');
      }
      onClose();
    } catch (err) {
      setServerError(isApiError(err) ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };

  const busy = create.isPending || update.isPending;
  const bothUses = form.declaredUses.includes('credit_hire') && form.declaredUses.includes('self_drive');
  const policies = policiesQ.data ?? [];
  const policyOptions = useMemo(() => {
    const opts = policies.map((p) => ({ value: p.id, label: policyLabel(p) }));
    if (form.policyId && !policies.some((p) => p.id === form.policyId)) opts.unshift({ value: form.policyId, label: `Policy ${form.policyId}` });
    return [...opts, { value: ADD_POLICY, label: 'Add policy…' }];
  }, [policies, form.policyId]);
  const reg = isNew ? form.vehicle.registration : unit ? unitRegistration(unit) : '';

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={unit ? `Edit unit ${formatRegistration(reg)}` : 'Add fleet unit'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {unit ? 'Save changes' : 'Add unit'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ErrorAlert message={serverError} />
        {isNew ? (
          <p className="xs muted" style={{ margin: 0 }}>
            A fleet registration can never be a client vehicle on a claim (lessons f, h).
          </p>
        ) : (
          <p className="xs muted" style={{ margin: 0 }}>
            Registration <span className="mono">{formatRegistration(reg)}</span> is fixed once the unit exists. Vehicle changes are saved on the vehicle record as unverified.
          </p>
        )}
        {!isNew && <CopyDetailsPanel registration={reg} value={form.vehicle} onChange={set('vehicle')} />}
        <VehiclePicker
          value={form.vehicle}
          onChange={set('vehicle')}
          mode="fleet"
          showRegistration={isNew}
          lookupMode={lookupMode}
          errors={{ ...(errors.vehicle ?? {}), ...(errors.registration ? { registration: errors.registration } : {}) }}
        />

        <FleetGtaPanel vehicle={form.vehicle} state={form.gta} onChange={set('gta')} date={today} errors={{ gtaGroup: errors.gtaGroup, dailyRatePence: errors.dailyRatePence }} />

        <fieldset className="fieldset">
          <legend>Use, cover and status</legend>
          <div className="form-grid">
            <div className="span-2">
              <Field label="Declared class of use" required error={errors.declaredUses} hint="Each unit's declared use must sit inside its policy cover. Collingwood will not cover credit hire and self-drive together (BLUEPRINT §3.12).">
                <div className="check-grid">
                  {FLEET_USES.map((u) => (
                    <Checkbox key={u} label={FLEET_USE_LABEL[u]} checked={form.declaredUses.includes(u)} onChange={toggleUse(u)} />
                  ))}
                </div>
              </Field>
            </div>
            <Select
              label="Policy"
              value={form.policyId}
              placeholder={policiesQ.isLoading ? 'Loading policies…' : 'No policy yet'}
              options={policyOptions}
              onChange={(v) => (v === ADD_POLICY ? setAddingPolicy(true) : set('policyId')(v))}
              error={errors.policyId}
              hint={bothUses ? 'Two uses declared: the policy must cover both.' : 'Fleet policy covering the declared uses.'}
            />
            <Select<FleetUnit['status']> label="Status" value={form.status} onChange={(v) => v && set('status')(v)} options={UNIT_STATUSES.map((s) => ({ value: s, label: UNIT_STATUS_LABEL[s] }))} />
            <Checkbox label="PHV / PCO licensed" checked={form.phvLicensed} onChange={set('phvLicensed')} hint="Required for PCO use (TfL PHV licence)." />
            <DateInput label="Service due" value={form.serviceDueDate} onChange={set('serviceDueDate')} />
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Keeper address on the V5C</legend>
          <p className="basis">PCNs and NIPs go to the V5C address. RENTX's CCJs arose from tickets posted to an old address (lesson l) — keep this current and tick the box only when the V5C shows the live address.</p>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <TextInput label="Address line 1" value={form.keeperLine1} onChange={set('keeperLine1')} />
            <TextInput label="Address line 2" value={form.keeperLine2} onChange={set('keeperLine2')} />
            <TextInput label="Town" value={form.keeperTown} onChange={set('keeperTown')} />
            <TextInput label="Postcode" value={form.keeperPostcode} onChange={set('keeperPostcode')} error={errors.keeperPostcode} autoCapitalize="characters" />
            <div className="span-2">
              <Checkbox label="The V5C shows the current registered-keeper address" checked={form.keeperAddressCurrent} onChange={set('keeperAddressCurrent')} hint="Untick to raise a KEEPER_ADDRESS_STALE alert until the V5C is updated with DVLA." />
            </div>
          </div>
        </fieldset>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      </form>
    </Modal>
    <AddPolicyDialog
      open={open && addingPolicy}
      defaultUses={form.declaredUses}
      onClose={() => setAddingPolicy(false)}
      onCreated={(p) => {
        set('policyId')(p.id);
        setAddingPolicy(false);
      }}
    />
    </>
  );
}

export interface PolicyForm {
  insurerName: string;
  policyNumber: string;
  coveredUses: FleetUse[];
  startDate: string;
  endDate: string;
}

export function validatePolicyForm(f: PolicyForm): Partial<Record<keyof PolicyForm, string>> {
  const e: Partial<Record<keyof PolicyForm, string>> = {};
  if (!f.insurerName.trim()) e.insurerName = 'Insurer name';
  if (!f.policyNumber.trim()) e.policyNumber = 'Policy number';
  if (f.coveredUses.length === 0) e.coveredUses = 'Tick the uses the policy covers';
  if (!f.startDate) e.startDate = 'Start date';
  if (!f.endDate) e.endDate = 'End date';
  else if (f.startDate && f.endDate < f.startDate) e.endDate = 'The end is before the start';
  return e;
}

/** Small "Add policy" form → POST /fleet/policies. */
function AddPolicyDialog({ open, defaultUses, onClose, onCreated }: { open: boolean; defaultUses: FleetUse[]; onClose: () => void; onCreated: (p: InsurancePolicy) => void }) {
  const createPolicy = useCreateFleetPolicy();
  const toast = useToast();
  const [form, setForm] = useState<PolicyForm>({ insurerName: '', policyNumber: '', coveredUses: [], startDate: '', endDate: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyForm, string>>>({});
  useEffect(() => {
    if (open) {
      setForm({ insurerName: '', policyNumber: '', coveredUses: [...defaultUses], startDate: todayISO(), endDate: '' });
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof PolicyForm>(k: K) => (v: PolicyForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => {
    const e = validatePolicyForm(form);
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: PolicyBody = { insurerName: form.insurerName.trim(), policyNumber: form.policyNumber.trim(), coveredUses: form.coveredUses, startDate: form.startDate, endDate: form.endDate };
    createPolicy.mutate(body, {
      onSuccess: (p) => {
        toast.success(`Policy ${p.policyNumber} added`);
        onCreated(p);
      }
    });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add policy"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={createPolicy.isPending}>
            Add policy
          </Button>
        </>
      }
    >
      <div className="stack">
        {createPolicy.error ? (
          <div className="notice notice-danger small" role="alert">
            {isApiError(createPolicy.error) ? `${createPolicy.error.code}: ${createPolicy.error.message}` : (createPolicy.error as Error).message}
          </div>
        ) : null}
        <div className="form-grid">
          <TextInput label="Insurer" required value={form.insurerName} onChange={set('insurerName')} error={errors.insurerName} />
          <TextInput label="Policy number" required value={form.policyNumber} onChange={set('policyNumber')} error={errors.policyNumber} />
          <DateInput label="Start" required value={form.startDate} onChange={set('startDate')} error={errors.startDate} />
          <DateInput label="End" required value={form.endDate} onChange={set('endDate')} error={errors.endDate} />
          <div className="span-2">
            <Field label="Uses covered" required error={errors.coveredUses}>
              <div className="check-grid">
                {FLEET_USES.map((u) => (
                  <Checkbox key={u} label={FLEET_USE_LABEL[u]} checked={form.coveredUses.includes(u)} onChange={(on) => set('coveredUses')(on ? [...new Set([...form.coveredUses, u])] : form.coveredUses.filter((x) => x !== u))} />
                ))}
              </div>
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}
