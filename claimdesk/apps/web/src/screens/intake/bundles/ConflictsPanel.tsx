// owned by intake-web
/**
 * Conflicts (docs/SMART-INTAKE.md §11.4, improvement 2): two documents disagree. Each option shows its value, every
 * source, the rank ("best source: V5C") and the AI's note; the best source is preselected but nothing is final until
 * you choose (or accept all the preselected ones). Register stays disabled while any conflict is open.
 */
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import type { Conflict, FieldSource } from '../../../api/bundlesApi';
import { SourceChip } from './bundleParts';
import { bestSourceText, chipSources, orderedOptions } from './bundleModel';

export function ConflictsPanel({
  conflicts,
  onChoose,
  onAcceptAll,
  onSource,
  busy,
  closed,
}: {
  conflicts: Conflict[];
  onChoose: (conflictId: string, value: string) => void;
  onAcceptAll: () => void;
  onSource: (title: string, s: FieldSource) => void;
  busy: boolean;
  closed: boolean;
}) {
  if (!conflicts.length) return null;
  const open = conflicts.filter((c) => c.status === 'open');
  const resolved = conflicts.filter((c) => c.status === 'resolved');
  return (
    <Card
      title={open.length ? `${open.length} ${open.length === 1 ? 'detail conflicts' : 'details conflict'}` : 'Conflicts resolved'}
      className="bdl-conflicts"
      id="bundle-conflicts"
      actions={
        open.length > 0 && !closed ? (
          <Button size="sm" variant="primary" onClick={onAcceptAll} disabled={busy}>
            Accept all preselected
          </Button>
        ) : undefined
      }
    >
      {open.length > 0 && <p className="small muted">The documents disagree. The best source is preselected; nothing is overwritten until you choose.</p>}
      <div className="stack-sm">
        {open.map((c) => (
          <fieldset key={c.id} className="bdl-conflict">
            <legend>{c.label}</legend>
            <div className="bdl-options">
              {orderedOptions(c).map((o) => (
                <div key={o.value} className={`bdl-option ${o.preselected ? 'bdl-option-pre' : ''}`.trim()}>
                  <div className="row-between">
                    <span className="bdl-value">{o.display}</span>
                    {o.preselected && <Badge tone="green">Preselected</Badge>}
                  </div>
                  <div className="bdl-chips">
                    {chipSources(o.sources).map((s, i) => (
                      <SourceChip key={`${s.fileId}-${i}`} source={s} onOpen={(x) => onSource(c.label, x)} />
                    ))}
                  </div>
                  {bestSourceText(o) && <div className="small muted">{bestSourceText(o)}</div>}
                  {o.aiWhy && <div className="small">AI: {o.aiWhy}</div>}
                  {!closed && (
                    <Button size="sm" variant={o.preselected ? 'primary' : 'secondary'} onClick={() => onChoose(c.id, o.value)} disabled={busy} aria-label={`Use ${o.display} for ${c.label}`}>
                      Use this
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="small muted">{c.why}</div>
          </fieldset>
        ))}
        {resolved.length > 0 && (
          <ul className="small muted bdl-resolved">
            {resolved.map((c) => {
              const chosen = c.options.find((o) => o.value === c.chosenValue);
              return (
                <li key={c.id}>
                  {c.label}: {chosen?.display ?? c.chosenValue ?? '—'}
                  {c.resolvedBy ? ` (chosen by ${c.resolvedBy.replace(/^agent:/, '')})` : ''}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
