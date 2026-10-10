// owned by ap-clash
/**
 * Clash panel (docs/SUPREME-AUTOPILOT.md §C.5): block findings red with "Override as manager" (class A/B, only in
 * manager mode, reason box), warn amber with "I've read this" (acknowledge, reason), info grey. Shown in the booking
 * dialog, the Autopilot tab and Flags. Class C blocks are never overridable and say so.
 */
import { useState } from 'react';
import type { ClashFinding } from '@ccguk/domain';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { TextInput } from '../../../components/Form';
import { clashBasis, clashLabel, isGreenBlocking, isOverridable, MIN_REASON, SEVERITY_LABEL, SEVERITY_TONE, sortFindings, type ShownFinding } from '../lib/clashes';

export interface ClashPanelProps {
  findings: ClashFinding[];
  managerMode: boolean;
  onAcknowledge(id: string, reason: string): void;
  onOverride(reason: string): void;
}

export function ClashPanel({ findings, managerMode, onAcknowledge, onOverride }: ClashPanelProps) {
  const rows = sortFindings(findings as ShownFinding[]);
  const [ackId, setAckId] = useState<string | undefined>();
  const [ackReason, setAckReason] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');
  const openBlocks = rows.filter((f) => f.severity === 'block' && f.status !== 'overridden' && f.status !== 'resolved');
  const neverOverridable = openBlocks.filter((f) => !isOverridable(f));
  const canOverride = openBlocks.length > 0 && neverOverridable.length === 0;

  if (!rows.length) {
    return (
      <div className="clash-panel" aria-live="polite">
        <p className="muted">No clashes found.</p>
      </div>
    );
  }

  return (
    <div className="clash-panel" aria-live="polite">
      <ul className="clash-list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {rows.map((f) => {
          const key = f.id ?? f.dedupeKey;
          const done = f.status === 'acknowledged' || f.status === 'overridden' || f.status === 'resolved';
          return (
            <li key={key} className={`clash clash-${f.severity}`} style={{ borderLeft: `4px solid var(--${SEVERITY_TONE[f.severity]}, currentColor)`, paddingLeft: 8, opacity: done ? 0.75 : 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
                <strong>{clashLabel(f.code)}</strong>
                {f.severity === 'block' && !isOverridable(f) && <Badge tone="grey">Never overridable</Badge>}
                {isGreenBlocking(f) && !done && <Badge tone="amber">Autopilot asks you first</Badge>}
                {f.status && f.status !== 'open' && <Badge tone="grey">{f.status}</Badge>}
              </div>
              <p style={{ margin: '4px 0' }}>{f.message}</p>
              {clashBasis(f.code) && (
                <p className="muted small" style={{ margin: 0 }}>
                  {clashBasis(f.code)}
                </p>
              )}
              {f.relatedClaims && f.relatedClaims.length > 0 && (
                <p className="small" style={{ margin: '4px 0 0' }}>
                  Related: {f.relatedClaims.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 ? ', ' : ''}
                      <a href={`/claims/${c.id}`}>{c.reference}</a>
                    </span>
                  ))}
                </p>
              )}
              {f.severity === 'warn' && f.id && f.status === 'open' && (
                <div style={{ marginTop: 4 }}>
                  {ackId === f.id ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <TextInput label="Why is this fine?" value={ackReason} onChange={setAckReason} />
                      <Button
                        variant="primary"
                        disabled={ackReason.trim().length < MIN_REASON}
                        onClick={() => {
                          onAcknowledge(f.id!, ackReason.trim());
                          setAckId(undefined);
                          setAckReason('');
                        }}
                      >
                        Save
                      </Button>
                      <Button variant="ghost" onClick={() => setAckId(undefined)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setAckId(f.id)}>
                      I&apos;ve read this
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {openBlocks.length > 0 && (
        <div className="clash-override" style={{ marginTop: 12 }}>
          {neverOverridable.length > 0 ? (
            <p className="field-error">
              {neverOverridable.map((f) => clashLabel(f.code)).join(', ')}: this cannot be overridden. Choose another car or period, or fix the cause.
            </p>
          ) : !managerMode ? (
            <p className="muted">A manager can override these blocks with a reason (turn manager mode on).</p>
          ) : overriding ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <TextInput label="Reason for the override (kept in the audit trail)" value={reason} onChange={setReason} />
              <Button
                variant="danger"
                disabled={reason.trim().length < MIN_REASON}
                onClick={() => {
                  onOverride(reason.trim());
                  setOverriding(false);
                  setReason('');
                }}
              >
                Override and continue
              </Button>
              <Button variant="ghost" onClick={() => setOverriding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            canOverride && (
              <Button variant="danger" onClick={() => setOverriding(true)}>
                Override as manager
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
