import { useEffect, useState } from 'react';
import type { FleetUse } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { api, isApiError, type AllocateCheckResult } from '../../api/client';
import { Button } from '../../components/Button';
import { Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/Badge';
import { FLEET_USES, FLEET_USE_LABEL, unitRegistration, type FleetUnitView } from './fleet';

/**
 * Class-of-use allocation guard (BLUEPRINT §3.12): unit + intended use → POST /fleet/:id/allocate-check.
 * The reasons come from the API (domain `canAllocate`); the web only shows them.
 */
export function AllocateCheckDialog({ open, units, initialUnitId, onClose }: { open: boolean; units: FleetUnitView[]; initialUnitId?: string; onClose: () => void }) {
  const [unitId, setUnitId] = useState(initialUnitId ?? '');
  const [use, setUse] = useState<FleetUse | ''>('');
  const [claimId, setClaimId] = useState('');
  const [result, setResult] = useState<AllocateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setUnitId(initialUnitId ?? '');
      setUse('');
      setClaimId('');
      setResult(null);
      setError(null);
    }
  }, [open, initialUnitId]);

  const unit = units.find((u) => u.id === unitId);

  const run = async () => {
    if (!unitId || !use) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.allocateCheck(unitId, { use, claimId: claimId.trim() || undefined });
      setResult(res);
    } catch (e) {
      setError(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Allocation check" footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={run} disabled={!unitId || !use} loading={busy}>Check cover</Button></>}>
      <div className="stack">
        <p className="basis">Allocating a unit outside its declared use and policy cover leaves the hire uninsured and the hire charge unrecoverable. The check reads the unit's declared uses and its policy's covered uses (BLUEPRINT §3.12).</p>
        <div className="form-grid">
          <Select label="Fleet unit" value={unitId} onChange={setUnitId} placeholder="Choose a unit" options={units.map((u) => ({ value: u.id, label: `${formatRegistration(unitRegistration(u))} · ${u.vehicle?.make ?? ''} ${u.vehicle?.model ?? ''} · ${u.gtaGroup}`.replace(/\s+/g, ' ').trim(), disabled: u.status === 'disposed' }))} required />
          <Select<FleetUse> label="Intended use" value={use} onChange={setUse} placeholder="Choose the use" options={FLEET_USES.map((u) => ({ value: u, label: FLEET_USE_LABEL[u] }))} required />
          <div className="span-2">
            <TextInput label="Claim id (optional)" value={claimId} onChange={setClaimId} hint="When given, the API also runs the cross-file registration check against that claim." />
          </div>
        </div>
        {unit && (
          <div className="row small">
            <span className="muted">Declared uses:</span>
            {unit.declaredUses.length === 0 ? <Badge tone="red">none declared</Badge> : unit.declaredUses.map((u) => <Badge key={u} tone={u === use ? 'blue' : 'grey'}>{FLEET_USE_LABEL[u]}</Badge>)}
            {unit.status !== 'available' && <Badge tone="amber">unit is {unit.status.replace('_', ' ')}</Badge>}
          </div>
        )}
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div className={`result-box ${result.allowed ? 'allowed' : 'blocked'}`} role="status">
            <h4>{result.allowed ? 'Allocation allowed' : 'Allocation blocked'}</h4>
            {result.policy && (
              <div className="small" style={{ marginBottom: 6 }}>
                Policy {result.policy.insurerName} covers: {result.policy.coveredUses.map((u) => FLEET_USE_LABEL[u]).join(', ') || 'nothing recorded'}
              </div>
            )}
            {result.reasons.length > 0 ? (
              <ul className="small">
                {result.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <div className="small">{result.allowed ? 'Declared use and policy cover both include this use.' : 'No reason returned — treat as blocked.'}</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
