import { useEffect, useState } from 'react';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Link } from 'react-router-dom';
import type { MotTest, OdometerReading, OdometerSource, Vehicle } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { api, isApiError, type VehicleLookupResult } from '../../../api/client';
import { useAddOdometer, useInvalidateClaim, useMileageConflicts, useVehicleLookup } from '../../../api/hooks';
import { useCatalogueFeatures, useLookupMode, usePatchVehicle } from '../../../api/vehiclesApi';
import { Modal } from '../../../components/Modal';
import { VehiclePicker } from '../../vehicles/VehiclePicker';
import { CopyDetailsPanel } from '../../vehicles/CopyDetailsPanel';
import { patchHasChanges, pickerFromVehicle, validatePicker, vehiclePatchFrom, type VehiclePickerValue } from '../../vehicles/vehiclePickerModel';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge, VerificationBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { KeyValue } from '../../../components/KeyValue';
import { DateText } from '../../../components/DateText';
import { DateInput, Select, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { todayISO } from '../../../lib/dates';
import type { ClaimView } from '../claimFile';
import { EvidencePicker } from '../components/EvidencePicker';
import { conflictLabel, conflictsFrom, emptyOdometerForm, identificationRows, LOOKUP_PROVIDER_LABEL, motDefectCounts, motRows, ODOMETER_SOURCE_LABEL, ODOMETER_SOURCE_OPTIONS, odometerBodyFrom, sortLookups, sortReadings } from '../lib/vehicle';

export function VehicleTab({ view }: { view: ClaimView }) {
  const v = view.vehicle;
  const lookup = useVehicleLookup();
  const invalidate = useInvalidateClaim();
  const toast = useToast();
  const [result, setResult] = useState<VehicleLookupResult | null>(null);
  const [editing, setEditing] = useState(false);
  const lookupMode = useLookupMode();
  const vocabulary = useCatalogueFeatures().data;
  const conflictsQ = useMileageConflicts(v.id);
  const conflicts = conflictsFrom(conflictsQ.data);
  const linked = view.linkedClaims ?? view.claim.linkedClaimIds.map((id) => ({ id, reference: id, status: '' }));

  const runLookup = () => {
    // No DVLA/DVSA keys: the lookup cannot fetch anything, so open the details form (Total Car Check + catalogue).
    if (lookupMode === 'manual') {
      setEditing(true);
      return;
    }
    lookup.mutate(v.registration, {
      onSuccess: (r) => {
        setResult(r);
        if (r.status === 'ok') toast.success('Lookup complete — DVLA VES / DVSA MOT records stored on the vehicle');
        else setEditing(true);
        invalidate(view.claim.id);
      }
    });
  };

  const motColumns: Column<MotTest>[] = [
    { key: 'date', header: 'Test date', render: (t) => <DateText value={t.completedDate} /> },
    { key: 'result', header: 'Result', render: (t) => <Badge tone={t.result === 'PASSED' || t.result === 'PRS' ? 'green' : t.result === 'FAILED' ? 'red' : 'grey'}>{t.result}</Badge> },
    { key: 'expiry', header: 'Expiry', render: (t) => <DateText value={t.expiryDate} /> },
    { key: 'odo', header: 'Odometer', numeric: true, render: (t) => (t.odometerMiles !== undefined ? `${t.odometerMiles.toLocaleString('en-GB')} ${t.odometerUnit ?? 'mi'}` : '—') },
    {
      key: 'defects',
      header: 'Defects',
      className: 'wrap',
      render: (t) => {
        const c = motDefectCounts(t);
        return (
          <details>
            <summary className="xs" style={{ cursor: 'pointer' }}>
              {c.dangerous ? <Badge tone="red">{c.dangerous} dangerous</Badge> : null} {c.major ? <Badge tone="red">{c.major} major</Badge> : null} {c.minor ? <Badge tone="amber">{c.minor} minor</Badge> : null} {c.advisory ? <Badge tone="grey">{c.advisory} advisory</Badge> : null}
              {t.defects.length === 0 && <span className="muted">none</span>}
            </summary>
            <ul className="xs" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {t.defects.map((d, i) => (
                <li key={i}>
                  <strong>{d.type}</strong> {d.text}
                </li>
              ))}
            </ul>
          </details>
        );
      }
    },
    { key: 'no', header: 'Test no.', render: (t) => <span className="xs mono">{t.testNumber ?? '—'}</span> }
  ];

  const readingColumns: Column<OdometerReading>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateText value={r.date} /> },
    { key: 'miles', header: 'Miles', numeric: true, render: (r) => r.miles.toLocaleString('en-GB') },
    { key: 'source', header: 'Source', render: (r) => ODOMETER_SOURCE_LABEL[r.source] ?? r.source },
    { key: 'evidence', header: 'Evidence', render: (r) => (r.evidenceId ? <a href={api.evidenceFileUrl(r.evidenceId)} target="_blank" rel="noreferrer">file</a> : <span className="muted">—</span>) },
    { key: 'note', header: 'Note', className: 'wrap', render: (r) => r.note ?? '' }
  ];

  return (
    <div className="stack">
      {linked.length > 0 && (
        <div className="notice notice-warn" role="alert">
          <strong>Cross-file link.</strong> {formatRegistration(v.registration)} also appears on{' '}
          {linked.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ', '}
              <Link to={`/claims/${l.id}`}>{l.reference}</Link>
            </span>
          ))}
          . Each registration is unique per incident: separate ledger, documents and insurer on each file (lessons f, h).
        </div>
      )}
      {v.ownership === 'fleet' && (
        <div className="notice notice-danger" role="alert">
          <strong>Hard stop.</strong> This registration is a CCGUK fleet unit. A fleet vehicle cannot be the client vehicle on a claim.
        </div>
      )}

      <div className="grid-2">
        <Card
          title={
            <span className="row">
              Identification <span className="reg-plate">{formatRegistration(v.registration)}</span>
            </span>
          }
          actions={
            <>
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit details
              </Button>
              <Button size="sm" variant="primary" loading={lookup.isPending} onClick={runLookup} title={lookupMode === 'manual' ? 'No DVLA/DVSA keys are set up: opens the details form with Total Car Check and the catalogue' : undefined}>
                {lookupMode === 'manual' ? 'Lookup' : v.lookups.some((l) => l.provider === 'dvla_ves' || l.provider === 'dvsa_mot') ? 'Re-lookup' : 'Lookup (DVLA VES + MOT)'}
              </Button>
            </>
          }
        >
          <KeyValue items={identificationRows(v, vocabulary).map((r) => ({ label: r.label, value: r.value ?? <span className="muted">—</span> }))} />
          <ApiErrorNotice error={lookup.error} what="look up the vehicle" />
          {result && (
            <div className={`notice ${result.status === 'ok' ? 'notice-success' : 'notice-warn'} small`} style={{ marginTop: 12 }}>
              {result.status === 'ok' ? (
                <>
                  <strong>Lookup OK.</strong> {result.vehicle.make} {result.vehicle.model} {result.vehicle.yearOfManufacture ?? ''} · {result.vehicle.fuelType ?? ''} · MOT {result.vehicle.motStatus ?? '—'} {result.vehicle.motExpiryDate ? `to ${result.vehicle.motExpiryDate}` : ''} · tax {result.vehicle.taxStatus ?? '—'}
                  {result.motHistory ? ` · ${result.motHistory.length} MOT tests` : ''}
                  {result.warnings?.length ? <div className="xs">{result.warnings.join(' · ')}</div> : null}
                </>
              ) : (
                <>
                  <strong>Manual entry required.</strong> {result.reason ?? 'No DVLA / DVSA keys configured or the services failed.'} Keyed details stay unverified until a document (V5C, MOT certificate) backs them.
                </>
              )}
              {result.fleetUnit && <div className="xs strong">Registration matches fleet unit {result.fleetUnit.id} — hard stop.</div>}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <div className="small strong">Lookups</div>
            {v.lookups.length === 0 ? (
              <p className="xs muted">No lookup record yet. Everything on this card is unverified.</p>
            ) : (
              <ul className="list">
                {sortLookups(v.lookups).map((l) => (
                  <li key={l.id} style={{ padding: '6px 0' }}>
                    <div className="list-main">
                      <div className="small">
                        {LOOKUP_PROVIDER_LABEL[l.provider]} · {l.kind}
                      </div>
                      <div className="xs muted">
                        <DateText value={l.requestedAt} time /> by {l.requestedBy}
                        {l.costPence ? ` · cost ${(l.costPence / 100).toFixed(2)}` : ''}
                      </div>
                    </div>
                    <VerificationBadge verification={l.verification} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Mileage conflicts" actions={<Badge tone={conflicts.length ? 'red' : 'green'} dot>{conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}` : 'consistent'}</Badge>}>
          <ApiErrorNotice error={conflictsQ.error} what="check mileage" />
          {conflicts.length === 0 ? (
            <p className="small muted">The API compares every reading (MOT, accident report, handover, collection, engineer, photos). Non-monotonic readings or variance beyond tolerance are flagged here (lesson e) and must be resolved before the engineer’s report or the PAV issues.</p>
          ) : (
            <ul className="checklist">
              {conflicts.map((c, i) => (
                <li key={i}>
                  <span className="tick no">!</span>
                  <span>
                    <div className="strong">{conflictLabel(c.code)}</div>
                    <div className="small">{c.message}</div>
                    {c.a && c.b && (
                      <div className="xs muted">
                        {c.a.date} {ODOMETER_SOURCE_LABEL[c.a.source]} {c.a.miles.toLocaleString('en-GB')} mi ↔ {c.b.date} {ODOMETER_SOURCE_LABEL[c.b.source]} {c.b.miles.toLocaleString('en-GB')} mi
                      </div>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view.thirdPartyVehicle && (
            <div style={{ marginTop: 16 }}>
              <div className="small strong">Third-party vehicle</div>
              <KeyValue items={[{ label: 'Registration', value: <span className="reg-plate" style={{ fontSize: '0.8em' }}>{formatRegistration(view.thirdPartyVehicle.registration)}</span> }, { label: 'Make / model', value: `${view.thirdPartyVehicle.make} ${view.thirdPartyVehicle.model}` }]} />
            </div>
          )}
        </Card>
      </div>

      <Card title="Odometer readings" flush actions={<span className="small muted">{v.odometer.length} reading{v.odometer.length === 1 ? '' : 's'}</span>}>
        <OdometerForm view={view} />
        <Table columns={readingColumns} rows={sortReadings(v.odometer)} rowKey={(r, i) => `${r.date}-${r.source}-${i}`} caption="Odometer readings" empty={<EmptyState title="No odometer readings">Add the MOT reading, the accident-report reading and photographed readings at handover and collection.</EmptyState>} />
      </Card>

      <Card title="MOT history" flush actions={<span className="small muted">DVSA MOT history API</span>}>
        <Table columns={motColumns} rows={motRows(v)} rowKey={(t) => `${t.completedDate}-${t.testNumber ?? ''}`} caption="MOT history" empty={<EmptyState title="No MOT history on file">Run the lookup to pull the DVSA history (free API; key required).</EmptyState>} />
      </Card>

      <EditVehicleDialog open={editing} vehicle={v} lookupMode={lookupMode ?? 'manual'} links={result?.externalLinks} onClose={() => setEditing(false)} onSaved={() => invalidate(view.claim.id)} />
    </div>
  );
}

/**
 * "Edit details" (§E.5): the VehiclePicker in edit mode (registration fixed) with the Total Car Check button and the
 * paste panel → PATCH /vehicles/:id. Values that differ from a verified DVLA/DVSA lookup are saved (handler intent) and
 * reported; the verified lookups themselves are never changed.
 */
function EditVehicleDialog({ open, vehicle, lookupMode, links, onClose, onSaved }: { open: boolean; vehicle: Vehicle; lookupMode: 'live' | 'manual'; links?: VehicleLookupResult['externalLinks']; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const patch = usePatchVehicle();
  const [initial, setInitial] = useState<VehiclePickerValue>(() => pickerFromVehicle(vehicle));
  const [value, setValue] = useState<VehiclePickerValue>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof VehiclePickerValue, string>>>({});
  useEffect(() => {
    if (!open) return;
    const start = pickerFromVehicle(vehicle);
    setInitial(start);
    setValue(start);
    setErrors({});
    // reset only when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    const e = validatePicker(value, { requireMakeModel: false });
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = vehiclePatchFrom(initial, value);
    if (!patchHasChanges(body)) {
      toast.push('Nothing has changed.');
      onClose();
      return;
    }
    patch.mutate(
      { id: vehicle.id, body },
      {
        onSuccess: (res) => {
          onSaved();
          if (res.warnings.length) toast.warn(`Saved. ${res.warnings.length === 1 ? 'One value differs' : `${res.warnings.length} values differ`} from the verified DVLA/DVSA record (${res.warnings.map((w) => w.field).join(', ')}) — the verified record is unchanged.`);
          else toast.success('Vehicle details saved (unverified until a document backs them).');
          onClose();
        }
      }
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Vehicle details — ${formatRegistration(vehicle.registration)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={patch.isPending}>
            Save details
          </Button>
        </>
      }
    >
      <div className="stack">
        {lookupMode === 'manual' && <div className="notice notice-info small">No DVLA/DVSA keys are set up. Read the details on Total Car Check and copy them in, or pick the vehicle from the catalogue. Everything saved here is unverified until the V5C or MOT certificate backs it.</div>}
        <ErrorAlert message={patch.error ? (isApiError(patch.error) ? `${patch.error.code}: ${patch.error.message}` : (patch.error as Error).message) : null} className="small" />
        <CopyDetailsPanel registration={vehicle.registration} value={value} onChange={setValue} links={links} />
        <VehiclePicker value={value} onChange={setValue} mode="edit" showRegistration={false} lookupMode={lookupMode} errors={errors} />
      </div>
    </Modal>
  );
}

function OdometerForm({ view }: { view: ClaimView }) {
  const today = todayISO();
  const [form, setForm] = useState(() => emptyOdometerForm(today));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useAddOdometer(view.vehicle.id);
  const toast = useToast();
  const submit = () => {
    const r = odometerBodyFrom(form, today);
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    add.mutate(r.body, {
      onSuccess: () => {
        toast.success('Reading added — conflicts re-checked');
        setForm(emptyOdometerForm(today));
      }
    });
  };
  return (
    <form
      className="inline-form"
      aria-label="Add odometer reading"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="form-grid">
        <Select<OdometerSource> label="Source" required value={form.source} onChange={(v) => setForm((f) => ({ ...f, source: v }))} options={ODOMETER_SOURCE_OPTIONS} placeholder="Choose…" error={errors.source} />
        <DateInput label="Date" required value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} error={errors.date} max={today} />
        <TextInput label="Miles" required value={form.miles} onChange={(v) => setForm((f) => ({ ...f, miles: v }))} inputMode="numeric" error={errors.miles} />
        <TextInput label="Note" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} placeholder="e.g. dashboard photo at delivery" />
        <div className="span-4">
          <EvidencePicker label="Photo / document showing the reading" single evidence={view.evidence} value={form.evidenceId ? [form.evidenceId] : []} onChange={(ids) => setForm((f) => ({ ...f, evidenceId: ids[0] ?? '' }))} error={errors.evidenceId} kinds={['photo', 'engineer_report', 'v5c', 'mot_certificate', 'document', 'pdf', 'screenshot']} />
        </div>
      </div>
      <div className="form-actions">
        <span className="hint">Readings are append-only; a wrong one is answered with a corrected reading and a note.</span>
        <Button type="submit" variant="primary" loading={add.isPending}>
          Add reading
        </Button>
      </div>
      <ApiErrorNotice error={add.error} what="add the reading" />
    </form>
  );
}
