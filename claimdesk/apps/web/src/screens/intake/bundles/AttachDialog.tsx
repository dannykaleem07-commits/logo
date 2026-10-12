// owned by intake-web
/**
 * Attach to an existing claim (docs/SMART-INTAKE.md §6.9, §11.4): find the claim, see what is on file next to what the
 * documents say, tick the details to apply now. The files are filed on the claim; unticked details that differ wait
 * for you in one Needs-you card; empty fields may fill automatically under the normal rules.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Select, TextInput } from '../../../components/Form';
import { Modal } from '../../../components/Modal';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useClaim, useClaims } from '../../../api/hooks';
import type { AttachBody, AttachResult, BundleDetail } from '../../../api/bundlesApi';
import { SECTION_LABEL } from './bundleModel';

/** Where each bundle key sits on a claim bundle (GET /claims/:id), read defensively. */
const ON_FILE_PATH: Record<string, string> = {
  'client.name': 'claimant.name',
  'client.dateOfBirth': 'claimant.dateOfBirth',
  'client.phone': 'claimant.phone',
  'client.email': 'claimant.email',
  'client.drivingLicenceNumber': 'claimant.drivingLicenceNumber',
  'driver.name': 'driver.name',
  'vehicle.registration': 'vehicle.registration',
  'vehicle.vin': 'vehicle.vin',
  'vehicle.make': 'vehicle.make',
  'vehicle.model': 'vehicle.model',
  'vehicle.colour': 'vehicle.colour',
  'tp.registration': 'thirdPartyVehicle.registration',
  'tp.insurerName': 'atFaultInsurer.name',
  'tp.insurerRef': 'claim.atFaultInsurerRef',
  'accident.occurredAt': 'claim.accident.occurredAt',
  'accident.location': 'claim.accident.location',
  'accident.circumstances': 'claim.accident.circumstances',
  'accident.policeReference': 'claim.accident.policeReference',
};

export function onFileValue(claimBundle: unknown, key: string): string | null {
  const path = ON_FILE_PATH[key];
  if (!path || !claimBundle) return null;
  let cur: unknown = claimBundle;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : null;
}

const norm = (v: string | null): string => (v ?? '').replace(/\s+/g, '').toUpperCase();

export function AttachDialog({
  open,
  detail,
  initialClaimId,
  initialGroupKey,
  onClose,
  onAttach,
}: {
  open: boolean;
  detail: BundleDetail;
  initialClaimId?: string;
  initialGroupKey?: string;
  onClose: () => void;
  onAttach: (body: AttachBody) => Promise<AttachResult>;
}) {
  const [q, setQ] = useState('');
  const [claimId, setClaimId] = useState(initialClaimId ?? '');
  const [groupKey, setGroupKey] = useState(initialGroupKey ?? 'main');
  const [apply, setApply] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const search = useClaims({ q: q.trim() || undefined, limit: 20 }, { enabled: open });
  const claim = useClaim(claimId || undefined);
  const groups = detail.groups.filter((g) => g.kind !== 'excluded' && g.fileIds.length > 0);
  const fields = useMemo(() => detail.draft.fields.filter((f) => f.value), [detail.draft.fields]);

  // Tick by default: details the claim does not hold yet.
  useEffect(() => {
    if (!claim.data) return;
    setApply(new Set(fields.filter((f) => !onFileValue(claim.data, f.key)).map((f) => f.key)));
  }, [claim.data, fields]);

  const submit = async () => {
    if (!claimId) return;
    setBusy(true);
    setError(null);
    try {
      await onAttach({ claimId, groupKey, apply: [...apply] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string, on: boolean) =>
    setApply((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  return (
    <Modal
      open={open}
      title="Attach to an existing claim"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!claimId}>
            Attach
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <TextInput label="Find the claim" placeholder="Reference, registration or name" value={q} onChange={setQ} type="search" />
        <div className="bdl-claim-list" role="listbox" aria-label="Claims">
          {search.isLoading && <p className="small muted">Searching…</p>}
          {(search.data ?? []).map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={claimId === c.id} className={`bdl-claim-option ${claimId === c.id ? 'selected' : ''}`.trim()} onClick={() => setClaimId(c.id)}>
              <strong>{c.reference}</strong> <span className="small muted">{[c.claimantName, c.registration].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {!search.isLoading && !(search.data ?? []).length && <p className="small muted">No claims found.</p>}
        </div>
        {groups.length > 1 && (
          <Select label="Which files" value={groupKey} onChange={(v) => setGroupKey(v || 'main')} options={groups.map((g) => ({ value: g.key, label: `${g.label} (${g.fileIds.length})` }))} />
        )}
        {claimId && (
          <div className="table-wrap">
            <table className="table bdl-diff">
              <thead>
                <tr>
                  <th>Apply</th>
                  <th>Detail</th>
                  <th>On the claim</th>
                  <th>In the documents</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const onFile = claim.data ? onFileValue(claim.data, f.key) : null;
                  const same = onFile !== null && norm(onFile) === norm(f.value);
                  return (
                    <tr key={f.key} className={same ? 'muted' : undefined}>
                      <td>
                        <input type="checkbox" aria-label={`Apply ${SECTION_LABEL[f.section]} ${f.label}`} checked={apply.has(f.key)} disabled={same} onChange={(e) => toggle(f.key, e.target.checked)} />
                      </td>
                      <td>
                        <span className="small muted">{SECTION_LABEL[f.section]} · </span>
                        {f.label}
                      </td>
                      <td>{claim.isLoading ? '…' : onFile ?? '—'}</td>
                      <td className="bdl-value">{f.display ?? f.value}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">The files are filed on the claim. Details you do not tick and that differ from the claim wait for you in Needs you.</p>
        <ApiErrorNotice error={error} what="attach the files" />
      </div>
    </Modal>
  );
}
