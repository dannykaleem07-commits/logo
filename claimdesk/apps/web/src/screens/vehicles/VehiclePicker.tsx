import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { FuelType, OnFileMatch, Transmission } from '@ccguk/domain';
import { isApiError } from '../../api/client';
import {
  SEGMENT_LABEL,
  CATALOGUE_SEGMENTS,
  segmentLabel,
  useCatalogueFeatures,
  useCatalogueMakes,
  useCatalogueModel,
  useCatalogueModels,
  useCreateCustomCatalogue,
  useOnFile,
  type CustomCatalogueLevel
} from '../../api/vehiclesApi';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DateInput, Field, Select, TextInput } from '../../components/Form';
import { useToast } from '../../components/Toast';
import { useManagerMode } from '../../app/managerMode';
import { MANAGER_WARNING_PREFIX } from '../../lib/managerMode';
import { todayISO } from '../../lib/dates';
import { CopyDetailsPanel } from './CopyDetailsPanel';
import { FeaturesPicker } from './FeaturesPicker';
import { OnFileMatches } from './OnFileMatches';
import { Section } from './Section';
import {
  applyOnFile,
  BODY_LABEL,
  bodyOptions,
  CASCADE_LABEL,
  bodyOptionValue,
  customEntryBody,
  effectiveSource,
  engineOptions,
  findMake,
  findModel,
  FUEL_LABEL,
  FUEL_TYPES,
  fuelOptions,
  generationOptions,
  isClientVehicleOnClaim,
  linkToCatalogue,
  NOT_LISTED,
  NOT_LISTED_LABEL,
  parseBodyOption,
  resolveFromModel,
  setBody,
  setEngine,
  setEngineFree,
  setFuel,
  setGeneration,
  setMake,
  setModel,
  setSegment,
  setTransmission,
  setTrim,
  setTrimFree,
  setYear,
  SOURCE_LABEL,
  TRANSMISSION_LABEL,
  transmissionOptions,
  trimOptions,
  yearOptions,
  type CascadeStep,
  type VehiclePickerValue,
  type VehicleSourceInput
} from './vehiclePickerModel';

export type { VehiclePickerValue, VehicleSourceInput };

export interface VehiclePickerProps {
  value: VehiclePickerValue;
  onChange(next: VehiclePickerValue): void;
  mode: 'claim' | 'edit' | 'fleet';
  /** false in the Vehicle tab (registration is fixed). */
  showRegistration?: boolean;
  lookupMode: 'live' | 'manual';
  /** FNOL: reuse an existing vehicle. */
  onUseOnFile?(match: OnFileMatch): void;
  errors?: Partial<Record<keyof VehiclePickerValue, string>>;
  /** Amber messages (e.g. a check relaxed in manager mode) — shown when the field has no error. */
  warnings?: Partial<Record<keyof VehiclePickerValue, string>>;
  /**
   * 'inline' (default): Details and Features are closed sections at the end of the picker. 'external': the host places
   * <VehicleDetailsSection> and <VehicleFeaturesSection> itself (the fleet unit dialog puts them after the GTA panel).
   */
  detailsPlacement?: 'inline' | 'external';
  disabled?: boolean;
}

export const MANUAL_MODE_NOTICE = 'No DVLA/DVSA keys are set up, so ClaimDesk searches its own records. Use Total Car Check to read the details, then copy them in.';

const toInt = (s: string): number | undefined => {
  const t = s.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(t)) return undefined;
  return Number(t);
};

/**
 * One vehicle form for three uses (§D.9): New claim (`claim`), the claim Vehicle tab "Edit details" (`edit`) and the
 * fleet unit dialog (`fleet`). Sections: registration + search (on-file matches, Total Car Check, paste) when the
 * registration is shown → the catalogue cascade → details → features and extras. All state logic is in vehiclePickerModel.ts.
 */
export function VehiclePicker(props: VehiclePickerProps): JSX.Element {
  const { value, onChange, mode, showRegistration = true, lookupMode, onUseOnFile, errors = {}, warnings = {}, detailsPlacement = 'inline', disabled } = props;
  const managerOn = useManagerMode().on;
  const uid = useId();
  const toast = useToast();
  const today = todayISO();
  const makesQ = useCatalogueMakes();
  const makes = makesQ.data;
  const make = useMemo(() => (value.catalogue?.makeSlug ? makes?.find((m) => m.slug === value.catalogue!.makeSlug) : undefined) ?? findMake(makes, value.make), [makes, value.catalogue, value.make]);
  const makeSlug = value.catalogue?.makeSlug || make?.slug;
  const modelsQ = useCatalogueModels(makeSlug, value.yearOfManufacture);
  const models = modelsQ.data;
  const modelSlug = value.catalogue?.modelSlug;
  const modelQ = useCatalogueModel(makeSlug && modelSlug ? makeSlug : undefined, modelSlug);
  const model = modelQ.data && modelQ.data.slug === modelSlug ? modelQ.data : undefined;
  const featuresQ = useCatalogueFeatures();
  const addCustom = useCreateCustomCatalogue();
  const [free, setFree] = useState<Set<CascadeStep>>(new Set());
  const [freeText, setFreeText] = useState<Partial<Record<CascadeStep, string>>>({});
  const [searchReg, setSearchReg] = useState('');
  const onFileQ = useOnFile(searchReg, { enabled: showRegistration && Boolean(searchReg) });

  // A vehicle saved without catalogue ids (seeded, older records, DVLA upper case) is linked to the catalogue model
  // once the model list is in, so the generation, body, engine and trim lists appear. Never while the model is being
  // typed (the Model box links an exact name itself).
  const typedModelText = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!make || !models || value.catalogue?.modelSlug || !value.model.trim()) return;
    if (typedModelText.current === value.model) return;
    const next = linkToCatalogue(value, make, models);
    if (next !== value) onChange(next);
  }, [make, models, value, onChange]);

  // Once the model detail is loaded, fill the catalogue ids the value implies (after a paste or an on-file pick).
  const resolvedKey = useRef('');
  useEffect(() => {
    if (!model) return;
    const key = [model.slug, value.variant, value.yearOfManufacture, value.engineCapacityCc, value.fuelType].join('|');
    if (resolvedKey.current === key) return;
    resolvedKey.current = key;
    const next = resolveFromModel(value, model);
    if (next !== value) onChange(next);
  }, [model, value, onChange]);

  const isFree = (s: CascadeStep) => free.has(s);
  const setStepFree = (s: CascadeStep, on: boolean) =>
    setFree((f) => {
      const n = new Set(f);
      if (on) n.add(s);
      else n.delete(s);
      return n;
    });

  const addToCatalogue = (level: CustomCatalogueLevel, name: string) => {
    const r = customEntryBody(level, value, name);
    if (!r.ok) {
      toast.warn(r.error);
      return;
    }
    addCustom.mutate(r.body, {
      onSuccess: () => toast.success(`${name.trim()} added to your catalogue (unverified, like the rest of the catalogue).`),
      onError: (e) => toast.error(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message)
    });
  };

  const gen = model && value.catalogue?.generationId ? model.generations.find((g) => g.id === value.catalogue!.generationId) : undefined;
  const genOpts = generationOptions(model, value.yearOfManufacture);
  const bodyOpts = bodyOptions(model, gen?.id);
  const fuelOpts = gen ? fuelOptions(model, gen.id, value.yearOfManufacture) : [];
  const engineOpts = gen ? engineOptions(model, gen.id, { fuel: value.fuelType, year: value.yearOfManufacture }) : [];
  const transOpts = gen ? transmissionOptions(model, gen.id, value.catalogue?.engineId) : [];
  const trimOpts = gen ? trimOptions(model, gen.id, { bodyType: value.bodyType, engineId: value.catalogue?.engineId, year: value.yearOfManufacture }) : [];
  const typedModel = Boolean(value.model.trim()) && !value.catalogue?.modelSlug;
  const typedMake = Boolean(value.make.trim()) && !make;
  const source = effectiveSource(value);
  const versionSummary = [gen?.name ?? '', value.bodyType ?? '', value.engineCapacityCc ? `${value.engineCapacityCc.toLocaleString('en-GB')} cc` : '', value.variant.trim()].filter(Boolean).join(' · ');
  const listId = (name: string) => `${uid}-${name}`;

  const AddButton = ({ level, name, label = 'Add to catalogue' }: { level: CustomCatalogueLevel; name: string; label?: string }) => (
    <Button size="sm" variant="ghost" onClick={() => addToCatalogue(level, name)} disabled={disabled || !name.trim()} loading={addCustom.isPending}>
      {label}
    </Button>
  );

  /** A cascade Select with "Not listed — type it". */
  const stepSelect = (step: CascadeStep, opts: Array<{ value: string; label: string }>, current: string, onPick: (v: string) => void, extra?: { hint?: string; error?: string; placeholder?: string }) => (
    <Select
      label={CASCADE_LABEL[step]}
      value={current}
      placeholder={extra?.placeholder ?? 'Choose…'}
      options={[...opts, { value: NOT_LISTED, label: NOT_LISTED_LABEL }]}
      onChange={(v) => {
        if (v === NOT_LISTED) setStepFree(step, true);
        else onPick(v);
      }}
      hint={extra?.hint}
      error={extra?.error}
      disabled={disabled}
    />
  );

  const backToList = (step: CascadeStep) => (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStepFree(step, false)} disabled={disabled}>
      Choose from the list
    </button>
  );

  return (
    <div className="stack">
      {showRegistration && (
        <div className="stack-sm">
          <div className="field">
            <label className="field-label" htmlFor={listId('reg')}>
              Registration{mode === 'fleet' ? <span className="req">*</span> : null}
            </label>
            <div className="input-group">
              <input
                id={listId('reg')}
                className="input input-reg"
                value={value.registration}
                placeholder="AB12 CDE"
                autoCapitalize="characters"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={errors.registration ? true : undefined}
                onChange={(e) => onChange({ ...value, registration: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setSearchReg(value.registration);
                  }
                }}
              />
              <Button onClick={() => setSearchReg(value.registration)} disabled={disabled || !value.registration.trim()} loading={onFileQ.isFetching}>
                Search
              </Button>
            </div>
            {errors.registration ? (
              <div className="field-error" role="alert">
                {errors.registration}
              </div>
            ) : warnings.registration ? (
              <div className="field-warning" role="status">
                <span className="field-warning-icon" aria-hidden="true">
                  ⚠
                </span>{' '}
                {warnings.registration}
              </div>
            ) : (
              <div className="field-hint">{lookupMode === 'manual' ? MANUAL_MODE_NOTICE : 'Searches the vehicles ClaimDesk already holds. Total Car Check and the catalogue below fill in anything missing.'}</div>
            )}
          </div>
          {searchReg && onFileQ.data && (
            <>
              {mode === 'fleet' &&
                isClientVehicleOnClaim(onFileQ.data) &&
                (managerOn ? (
                  <div className="notice notice-warn small" role="status">
                    {MANAGER_WARNING_PREFIX}this registration is a client vehicle on a claim. Saving it as a fleet unit is recorded as a manager override.
                  </div>
                ) : (
                  <div className="notice notice-danger small" role="alert">
                    <strong>Client vehicle on a claim.</strong> A fleet unit cannot also be a client vehicle, so saving will be refused. A manager can override this in manager mode.
                  </div>
                ))}
              <OnFileMatches
                matches={onFileQ.data}
                onUse={(m) => (onUseOnFile ? onUseOnFile(m) : onChange(applyOnFile(value, m)))}
                useLabel={onUseOnFile ? 'Use this vehicle' : 'Use these details'}
                blockFleet={mode === 'claim' && !managerOn}
                warnFleet={mode === 'claim' && managerOn}
                disabled={disabled}
              />
            </>
          )}
          {onFileQ.error ? <div className="notice notice-warn small">Could not search the records: {(onFileQ.error as Error).message}</div> : null}
          {value.registration.trim() && <CopyDetailsPanel registration={value.registration} value={value} onChange={onChange} disabled={disabled} />}
        </div>
      )}

      <fieldset className="fieldset">
        <legend>
          Make and model <Badge tone="amber">unverified</Badge> <span className="xs muted">· {SOURCE_LABEL[source.provider]}</span>
        </legend>
        <div className="form-grid">
          <TextInput
            label="Make"
            required={mode !== 'edit'}
            value={value.make}
            list={listId('makes')}
            autoComplete="off"
            disabled={disabled}
            error={errors.make}
            placeholder="Start typing, e.g. Ford"
            hint={make ? (make.custom ? 'Your catalogue addition' : `${make.modelCount} model${make.modelCount === 1 ? '' : 's'} in the catalogue`) : typedMake ? 'Not in the catalogue — kept as typed.' : makesQ.isError ? 'The catalogue is not available; type the make.' : undefined}
            onChange={(t) => onChange(setMake(value, t))}
            onBlur={() => {
              if (make && value.make !== make.make && !value.catalogue) onChange({ ...value, make: make.make });
            }}
          />
          <datalist id={listId('makes')}>
            {(makes ?? []).map((m) => (
              <option key={m.slug} value={m.make} />
            ))}
          </datalist>
          {typedMake && (
            <div className="row" style={{ alignSelf: 'end' }}>
              <AddButton level="make" name={value.make} label={`Add “${value.make.trim()}” to the catalogue`} />
            </div>
          )}

          <TextInput
            label="Model"
            required={mode !== 'edit'}
            value={value.model}
            list={listId('models')}
            autoComplete="off"
            disabled={disabled}
            error={errors.model}
            placeholder={makeSlug ? 'Start typing, e.g. Fiesta' : 'Type the model'}
            hint={value.catalogue?.modelSlug ? segmentLabel(value.segment) : typedModel ? (makeSlug ? 'Not in the catalogue — kept as typed.' : undefined) : modelsQ.isFetching ? 'Loading models…' : undefined}
            onChange={(t) => {
              typedModelText.current = t;
              const hit = findModel(models, t);
              onChange(hit && makeSlug ? setModel(value, { ...hit, name: t }, makeSlug, model) : setModel(value, t, undefined, model));
            }}
            onBlur={() => {
              const hit = findModel(models, value.model);
              if (hit && value.model !== hit.name) onChange({ ...value, model: hit.name });
            }}
          />
          <datalist id={listId('models')}>
            {(models ?? []).map((m) => (
              <option key={m.slug} value={m.name} />
            ))}
          </datalist>
          {typedModel && (
            <>
              <Select
                label="Segment"
                value={value.segment ?? ''}
                placeholder="Not known"
                options={CATALOGUE_SEGMENTS.map((s) => ({ value: s, label: SEGMENT_LABEL[s] }))}
                onChange={(s) => onChange(setSegment(value, s || undefined))}
                hint="Used for the GTA group suggestion when the model is not in the catalogue."
                disabled={disabled}
              />
              {value.make.trim() && (
                <div className="row" style={{ alignSelf: 'end' }}>
                  <AddButton level="model" name={value.model} label={`Add “${value.model.trim()}” to the catalogue`} />
                </div>
              )}
            </>
          )}

          {isFree('year') ? (
            <TextInput
              label="Year of manufacture"
              value={value.yearOfManufacture ? String(value.yearOfManufacture) : ''}
              inputMode="numeric"
              placeholder="2019"
              disabled={disabled}
              error={errors.yearOfManufacture}
              hint={backToList('year')}
              onChange={(t) => onChange(setYear(value, toInt(t), model))}
            />
          ) : (
            stepSelect('year', yearOptions(make, today, value.yearOfManufacture), value.yearOfManufacture ? String(value.yearOfManufacture) : '', (v) => onChange(setYear(value, v ? Number(v) : undefined, model)), {
              error: errors.yearOfManufacture,
              placeholder: 'Not known'
            })
          )}

          <Select<FuelType>
            label="Fuel"
            value={value.fuelType ?? ''}
            placeholder="Not known"
            options={(fuelOpts.length && !isFree('fuel') ? fuelOpts : FUEL_TYPES.map((f) => ({ value: f, label: FUEL_LABEL[f] }))) as Array<{ value: FuelType; label: string }>}
            onChange={(f) => onChange(setFuel(value, f || undefined, model))}
            error={errors.fuelType}
            disabled={disabled}
          />

          <Select<Transmission>
            label="Transmission"
            value={value.transmission ?? ''}
            placeholder="Not known"
            options={(transOpts.length ? transOpts : (['manual', 'automatic', 'unknown'] as const).map((t) => ({ value: t, label: TRANSMISSION_LABEL[t] }))) as Array<{ value: Transmission; label: string }>}
            onChange={(t) => onChange(setTransmission(value, t || undefined, model))}
            error={errors.transmission}
            disabled={disabled}
          />

        </div>
        <div style={{ marginTop: 12 }}>
          <Section
            forceOpen={Boolean(errors.doors || errors.seats || errors.engineCapacityCc || errors.powerPs || errors.variant)}
            summary={
              <>
                Version, body and engine<span className="section-note">{versionSummary || 'optional — helps the GTA group suggestion'}</span>
              </>
            }
          >
            <div className="form-grid">
              {model && genOpts.length > 0 && (
                <>
                  {isFree('generation') ? (
                    <TextInput
                      label="Generation"
                      value={freeText.generation ?? ''}
                      onChange={(t) => setFreeText((f) => ({ ...f, generation: t }))}
                      placeholder="e.g. Mk8 (2017–2023)"
                      disabled={disabled}
                      hint={
                        <span className="row">
                          {backToList('generation')}
                          <AddButton level="generation" name={freeText.generation ?? ''} />
                        </span>
                      }
                    />
                  ) : (
                    stepSelect('generation', genOpts, value.catalogue?.generationId ?? '', (v) => onChange(setGeneration(value, v || undefined, model)), {
                      hint: model.generations.length > genOpts.length ? `Showing the generations on sale in ${value.yearOfManufacture}.` : undefined
                    })
                  )}
                </>
              )}

              {gen && bodyOpts.length > 0 && !isFree('body') ? (
                stepSelect('body', bodyOpts, bodyOptionValue(value), (v) => onChange(setBody(value, parseBodyOption(v), model)), {
                  hint: value.seats ? `${value.seats} seats` : undefined
                })
              ) : (
                <>
                  <TextInput
                    label="Body type"
                    value={value.bodyType ?? ''}
                    list={listId('bodies')}
                    disabled={disabled}
                    onChange={(t) => onChange({ ...value, bodyType: t || undefined })}
                    hint={gen && bodyOpts.length > 0 ? backToList('body') : undefined}
                  />
                  <datalist id={listId('bodies')}>
                    {Object.values(BODY_LABEL).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  <TextInput label="Doors" value={value.doors ? String(value.doors) : ''} inputMode="numeric" disabled={disabled} error={errors.doors} onChange={(t) => onChange({ ...value, doors: toInt(t) })} />
                  <TextInput label="Seats" value={value.seats ? String(value.seats) : ''} inputMode="numeric" disabled={disabled} error={errors.seats} onChange={(t) => onChange({ ...value, seats: toInt(t) })} />
                </>
              )}

              {gen && engineOpts.length > 0 && !isFree('engine') ? (
                stepSelect('engine', engineOpts, value.catalogue?.engineId ?? '', (v) => onChange(setEngine(value, v || undefined, model)), {
                  hint: value.engineCapacityCc ? `${value.engineCapacityCc.toLocaleString('en-GB')} cc${value.powerPs ? ` · ${value.powerPs} PS` : ''}` : undefined
                })
              ) : (
                <>
                  <TextInput
                    label="Engine size (cc)"
                    value={value.engineCapacityCc ? String(value.engineCapacityCc) : ''}
                    inputMode="numeric"
                    placeholder="1598"
                    disabled={disabled}
                    error={errors.engineCapacityCc}
                    onChange={(t) => onChange(setEngineFree(value, { engineCapacityCc: toInt(t), powerPs: value.powerPs }, model))}
                    hint={gen && engineOpts.length > 0 ? backToList('engine') : undefined}
                  />
                  <TextInput
                    label="Power (PS)"
                    value={value.powerPs ? String(value.powerPs) : ''}
                    inputMode="numeric"
                    disabled={disabled}
                    error={errors.powerPs}
                    onChange={(t) => onChange(setEngineFree(value, { engineCapacityCc: value.engineCapacityCc, powerPs: toInt(t) }, model))}
                  />
                  {gen && isFree('engine') && (
                    <TextInput
                      label="Engine name for the catalogue"
                      value={freeText.engine ?? ''}
                      placeholder="e.g. 1.5 TSI 150PS petrol"
                      disabled={disabled}
                      onChange={(t) => setFreeText((f) => ({ ...f, engine: t }))}
                      hint={<AddButton level="engine" name={freeText.engine ?? ''} />}
                    />
                  )}
                </>
              )}

              {gen && trimOpts.length > 0 && !isFree('trim') ? (
                stepSelect('trim', trimOpts, value.catalogue?.trimId ?? '', (v) => onChange(setTrim(value, v || undefined, model)), {
                  error: errors.variant,
                  // a pasted or stored variant that names no listed trim stays visible until a trim is chosen
                  ...(value.variant.trim() && !value.catalogue?.trimId ? { hint: `Pasted / stored: ${value.variant.trim()}` } : value.catalogue?.trimId && value.variant.trim() && trimOpts.find((o) => o.value === value.catalogue?.trimId)?.label !== value.variant.trim() ? { hint: `Recorded as: ${value.variant.trim()}` } : {})
                })
              ) : (
                <TextInput
                  label="Trim / variant"
                  value={value.variant}
                  placeholder="e.g. Zetec, SE, R-Line"
                  disabled={disabled}
                  error={errors.variant}
                  onChange={(t) => onChange(setTrimFree(value, t, model))}
                  hint={
                    gen ? (
                      <span className="row">
                        {trimOpts.length > 0 && backToList('trim')}
                        <AddButton level="trim" name={value.variant} />
                      </span>
                    ) : undefined
                  }
                />
              )}
            </div>
          </Section>
        </div>
        {modelQ.isError && value.catalogue?.modelSlug && <p className="xs muted">The catalogue detail for this model could not be loaded; type the remaining details.</p>}
        <p className="xs muted" style={{ marginTop: 8, marginBottom: 0 }}>
          The vehicle catalogue is reference data compiled from general knowledge of the UK market — confirm against the V5C, the DVLA record or Total Car Check.
        </p>
      </fieldset>

      {detailsPlacement === 'inline' && (
        <>
          <VehicleDetailsSection value={value} onChange={onChange} errors={errors} disabled={disabled} />
          <VehicleFeaturesSection value={value} onChange={onChange} disabled={disabled} />
        </>
      )}
    </div>
  );
}

const DETAIL_FIELDS: ReadonlyArray<keyof VehiclePickerValue> = ['colour', 'vin', 'monthOfFirstRegistration', 'motExpiryDate', 'taxDueDate'];

/** "More vehicle details" (colour, VIN, first registered, MOT, tax): closed until opened, or until one holds an error. */
export function VehicleDetailsSection({ value, onChange, errors = {}, disabled }: { value: VehiclePickerValue; onChange(next: VehiclePickerValue): void; errors?: Partial<Record<keyof VehiclePickerValue, string>>; disabled?: boolean }) {
  const uid = useId();
  const filled = DETAIL_FIELDS.filter((k) => Boolean(value[k])).length;
  return (
    <Section
      forceOpen={DETAIL_FIELDS.some((k) => Boolean(errors[k]))}
      summary={
        <>
          More vehicle details<span className="section-note">{filled ? `${filled} of ${DETAIL_FIELDS.length} filled` : 'colour, VIN, MOT, tax'}</span>
        </>
      }
    >
      <div className="form-grid">
        <TextInput label="Colour" value={value.colour ?? ''} disabled={disabled} error={errors.colour} onChange={(t) => onChange({ ...value, colour: t || undefined })} />
        <TextInput label="VIN" value={value.vin ?? ''} inputClassName="input-reg" disabled={disabled} error={errors.vin} onChange={(t) => onChange({ ...value, vin: t || undefined })} hint="17 characters, from the V5C." />
        <Field label="First registered (month)" error={errors.monthOfFirstRegistration} htmlFor={`${uid}-month`}>
          <input id={`${uid}-month`} type="month" className="input" value={value.monthOfFirstRegistration ?? ''} disabled={disabled} onChange={(e) => onChange({ ...value, monthOfFirstRegistration: e.target.value || undefined })} />
        </Field>
        <DateInput label="MOT expiry" value={value.motExpiryDate ?? ''} disabled={disabled} error={errors.motExpiryDate} onChange={(d) => onChange({ ...value, motExpiryDate: d || undefined })} />
        <DateInput label="Tax due" value={value.taxDueDate ?? ''} disabled={disabled} error={errors.taxDueDate} onChange={(d) => onChange({ ...value, taxDueDate: d || undefined })} />
      </div>
    </Section>
  );
}

/** "Features & extras (n selected)": closed until opened. */
export function VehicleFeaturesSection({ value, onChange, disabled }: { value: VehiclePickerValue; onChange(next: VehiclePickerValue): void; disabled?: boolean }) {
  const featuresQ = useCatalogueFeatures();
  const makeSlug = value.catalogue?.makeSlug;
  const modelSlug = value.catalogue?.modelSlug;
  const modelQ = useCatalogueModel(makeSlug && modelSlug ? makeSlug : undefined, modelSlug);
  const model = modelQ.data && modelQ.data.slug === modelSlug ? modelQ.data : undefined;
  const gen = model && value.catalogue?.generationId ? model.generations.find((g) => g.id === value.catalogue!.generationId) : undefined;
  const n = value.features.length + value.extras.length;
  return (
    <Section
      summary={
        <>
          Features &amp; extras<span className="section-note">({n} selected)</span>
        </>
      }
    >
      <FeaturesPicker
        vocabulary={featuresQ.data}
        loading={featuresQ.isLoading}
        features={value.features}
        extras={value.extras}
        disabled={disabled}
        trimStandard={gen && value.catalogue?.trimId ? (gen.trims.find((t) => t.id === value.catalogue!.trimId)?.features ?? []) : undefined}
        onChange={(f) => onChange({ ...value, ...f })}
      />
    </Section>
  );
}
