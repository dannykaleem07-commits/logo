import { useState } from 'react';
import type { ClaimFlag } from '@ccguk/domain';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { useToast } from '../../../components/Toast';
import { useClearClaimFlag } from '../claimApi';
import { ReasonDialog } from './ReasonDialog';

/** Block / warn / info flags on the claim, each cleared with a reason that the API logs. */
export function FlagsBanner({ claimId, flags, showCleared = false }: { claimId: string; flags: ClaimFlag[]; showCleared?: boolean }) {
  const [clearing, setClearing] = useState<ClaimFlag | null>(null);
  const clear = useClearClaimFlag(claimId);
  const toast = useToast();
  const visible = showCleared ? flags : flags.filter((f) => !f.clearedAt);
  if (visible.length === 0) return null;
  return (
    <div className="flag-list" role="region" aria-label="Claim flags">
      {visible.map((f, i) => (
        <div key={`${f.code}-${f.raisedAt}-${i}`} className={`flag-item ${f.severity} ${f.clearedAt ? 'cleared' : ''}`} role={f.severity === 'block' && !f.clearedAt ? 'alert' : undefined}>
          <div className="flag-body">
            <div>
              <strong>{f.severity === 'block' ? 'Hard stop' : f.severity === 'warn' ? 'Warning' : 'Note'}:</strong> {f.message}
            </div>
            <div className="flag-code">
              {f.code} · raised <DateText value={f.raisedAt} time /> by {f.raisedBy}
              {f.clearedAt ? (
                <>
                  {' '}
                  · cleared <DateText value={f.clearedAt} time /> {f.clearedBy ? `by ${f.clearedBy}` : ''}: {f.clearedReason}
                </>
              ) : null}
            </div>
          </div>
          {!f.clearedAt && (
            <Button size="sm" variant={f.severity === 'block' ? 'danger' : 'secondary'} onClick={() => setClearing(f)}>
              Clear with reason
            </Button>
          )}
        </div>
      ))}
      <ReasonDialog
        open={clearing !== null}
        title={`Clear flag ${clearing?.code ?? ''}`}
        danger={clearing?.severity === 'block'}
        busy={clear.isPending}
        error={clear.error}
        onClose={() => {
          setClearing(null);
          clear.reset();
        }}
        onConfirm={(reason) => {
          if (!clearing) return;
          clear.mutate(
            { code: clearing.code, reason },
            {
              onSuccess: () => {
                toast.success(`Flag ${clearing.code} cleared — reason logged`);
                setClearing(null);
              }
            }
          );
        }}
      >
        <div className={`flag-item ${clearing?.severity ?? 'info'}`}>
          <div className="flag-body">{clearing?.message}</div>
        </div>
        {clearing?.severity === 'block' && <p className="small">A hard stop protects the file (duplicate registration, fleet unit as a client vehicle, legacy detail). Clear it only when the underlying problem is fixed; the reason is audited.</p>}
      </ReasonDialog>
    </div>
  );
}
