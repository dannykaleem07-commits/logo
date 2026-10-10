// owned by ap-clash
/**
 * Needs-you eligibility_review (docs/SUPREME-AUTOPILOT.md §I.7, §H.3): the criteria that applied (labelled "check
 * against your policy" when they are the defaults), the outcome reasons, the driver's details, and the insurer's
 * written acceptance: choose the uploaded evidence and record it (the resolver refuses without evidence on the claim).
 * "Ask the client for more" and "Decline hire" are the item's own options.
 */
import { useState } from 'react';
import type { DriverCriteria } from '@ccguk/domain';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Select, TextInput } from '../../../components/Form';
import { KeyValue } from '../../../components/KeyValue';
import { useToast } from '../../../components/Toast';
import { useClaim } from '../../../api/hooks';
import { useResolveNeedsYou } from '../../../api/needsYouApi';
import { DriverProfileForm } from '../../claim/components/DriverProfileForm';
import { CRITERIA_NOTICE, summarise } from '../../settings/fleet/criteria';
import type { NeedsYouPanelProps } from './types';

interface Payload {
  claimId?: string;
  partyId?: string;
  outcome?: string;
  subject?: 'need' | 'means';
  reasons?: Array<{ code?: string; outcome?: string; message?: string }>;
  criteria?: DriverCriteria | null;
  criteriaSource?: 'policy' | 'settings_default';
  need?: { level?: string; reasons?: string[]; mitigationRisks?: string[] };
  means?: { basis?: string; warning?: string | null; missing?: string[] };
}

const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = { eligible: 'green', refer: 'amber', ineligible: 'red', unknown: 'grey' };

export function EligibilityReviewPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  const claimId = item.claimId ?? p.claimId;
  const claim = useClaim(claimId);
  const resolve = useResolveNeedsYou();
  const toast = useToast();
  const [evidenceId, setEvidenceId] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const evidence = claim.data?.evidence ?? [];

  const accept = () =>
    resolve.mutate(
      { id: item.id, body: { optionId: 'insurer_accepted', edits: { evidenceId }, ...(note.trim() ? { note: note.trim() } : {}) } },
      { onSuccess: () => toast.success("Insurer's acceptance recorded"), onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) },
    );

  return (
    <div className="stack-sm">
      {p.subject === 'need' && p.need && (
        <>
          <div className="row">
            <strong>Need for a car</strong>
            <Badge tone="amber">{p.need.level}</Badge>
          </div>
          <ul>{[...(p.need.reasons ?? []), ...(p.need.mitigationRisks ?? [])].map((r) => <li key={r}>{r}</li>)}</ul>
        </>
      )}
      {p.subject === 'means' && p.means && (
        <>
          <strong>Means</strong>
          <p>{p.means.warning}</p>
          {p.means.missing?.length ? <ul>{p.means.missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
        </>
      )}
      {p.partyId && (
        <>
          <div className="row">
            <strong>Driver</strong>
            {p.outcome && <Badge tone={OUTCOME_TONE[p.outcome] ?? 'grey'}>{p.outcome === 'refer' ? 'Refer to the insurer' : p.outcome}</Badge>}
          </div>
          {p.reasons?.length ? (
            <ul>
              {p.reasons.map((r, i) => (
                <li key={`${r.code}-${i}`}>
                  <Badge tone={OUTCOME_TONE[r.outcome ?? 'unknown'] ?? 'grey'}>{r.outcome}</Badge> {r.message}
                </li>
              ))}
            </ul>
          ) : null}
          {p.criteria && (
            <KeyValue
              items={[
                { label: 'Criteria', value: p.criteriaSource === 'policy' ? "The car's policy" : 'Default criteria — check against your policy' },
                { label: 'In short', value: summarise(p.criteria) },
              ]}
            />
          )}
          {p.criteriaSource !== 'policy' && <p className="muted small">{CRITERIA_NOTICE}</p>}
          {!closed && (
            <div className="stack-sm">
              <strong>The insurer accepted this driver in writing</strong>
              <Select<string>
                label="Their written acceptance (upload it to the claim's evidence first)"
                value={evidenceId}
                placeholder={evidence.length ? 'Choose the document' : 'No evidence on the claim yet'}
                onChange={setEvidenceId}
                options={evidence.map((e) => ({ value: e.id, label: `${e.filename}${e.description ? ` — ${e.description}` : ''}` }))}
              />
              <TextInput label="Note (optional)" value={note} onChange={setNote} />
              <div className="row">
                <Button variant="primary" disabled={!evidenceId} loading={resolve.isPending} onClick={accept}>
                  Record the insurer&apos;s acceptance
                </Button>
                <Button variant="ghost" onClick={() => setEditing((x) => !x)}>
                  {editing ? 'Hide driver details' : 'Correct the driver details'}
                </Button>
              </div>
              {editing && <DriverProfileForm partyId={p.partyId} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
