// owned by claimai-web
/**
 * One action line of an AI input (docs/CLAIM-AI-INPUT.md §14.2): tick box (when it can be ticked), title, tier chip,
 * detail, "why", the value on file, the quoted words, how it was read, inline edits for the editable fields, and — once
 * applied — its state, message, link, Undo and Try again.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateInput, DateTimeInput, TextInput } from '../../../components/Form';
import type { ActionEdits, AgentScope, AiAction, EditableField } from '../../../api/claimAiApi';
import {
  AGENT_SCOPE_LABEL,
  AGENT_SCOPES,
  canRetryLine,
  canUndoLine,
  confidenceNote,
  FROM_LABEL,
  londonDate,
  SOURCE_LABEL,
  STATE_LABEL,
  STATE_TONE,
  TIER_TONE,
  tierLabel,
  toggleScope,
  whenText,
} from './aiInputModel';

export interface ActionLineProps {
  action: AiAction;
  mode: 'preview' | 'result';
  ticked?: boolean;
  onTick?: (ticked: boolean) => void;
  edits?: ActionEdits;
  onEdit?: (patch: ActionEdits) => void;
  error?: string | null;
  onUndo?: () => void;
  onRetry?: () => void;
  busy?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** London calendar day → an ISO instant at 12:00 London-ish (UTC noon keeps the day in both BST and GMT). */
const dayToIso = (d: string): string => (d ? `${d}T12:00:00.000Z` : '');

function EditField({ field, action, edits, onEdit }: { field: EditableField; action: AiAction; edits: ActionEdits; onEdit: (p: ActionEdits) => void }) {
  const p = action.params;
  switch (field) {
    case 'at':
      return action.precision === 'datetime' ? (
        <DateTimeInput label="When it happened" value={edits.at ?? action.at ?? ''} onChange={(v) => onEdit({ at: v })} />
      ) : (
        <DateInput label="Date it happened" value={londonDate(edits.at ?? action.at)} onChange={(v) => onEdit({ at: dayToIso(v) })} />
      );
    case 'dueAt':
      return <DateTimeInput label="Due" value={edits.dueAt ?? (str(p.dueAt) || action.at || '')} onChange={(v) => onEdit({ dueAt: v })} />;
    case 'until': {
      const current = edits.until !== undefined ? edits.until : ((p.until as string | null | undefined) ?? null);
      return (
        <div className="aiin-until">
          <DateInput label="Until" value={londonDate(current)} onChange={(v) => onEdit({ until: v || null })} hint={current ? 'Lifts at the start of that day' : 'Until you remove it'} />
          {current && (
            <Button size="sm" variant="ghost" onClick={() => onEdit({ until: null })}>
              Until I say
            </Button>
          )}
        </div>
      );
    }
    case 'text':
      return <TextInput label="Wording" value={edits.text ?? str(p.text ?? p.note ?? p.summary)} onChange={(v) => onEdit({ text: v })} />;
    case 'value':
      return <TextInput label="Value" value={edits.value ?? str(p.value)} onChange={(v) => onEdit({ value: v })} />;
    case 'appliesTo': {
      const current = edits.appliesTo ?? ((Array.isArray(p.appliesTo) ? p.appliesTo : ['all']) as AgentScope[]);
      return (
        <fieldset className="aiin-scopes">
          <legend className="field-label">Who follows it</legend>
          {AGENT_SCOPES.map((s) => (
            <button key={s} type="button" className="aiin-chip-toggle" aria-pressed={current.includes(s)} onClick={() => onEdit({ appliesTo: toggleScope(current, s) })}>
              {AGENT_SCOPE_LABEL[s]}
            </button>
          ))}
        </fieldset>
      );
    }
    default:
      return null;
  }
}

export function ActionLine({ action: a, mode, ticked = false, onTick, edits = {}, onEdit, error, onUndo, onRetry, busy = false }: ActionLineProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const preview = mode === 'preview';
  const tickable = preview && a.tickable && Boolean(onTick);
  const confidence = confidenceNote(a);
  const canEdit = preview && a.editable.length > 0 && Boolean(onEdit) && (a.tickable ? ticked : true);
  const result = a.result;
  return (
    <li className={`aiin-line aiin-tier-${a.tier} aiin-state-${a.state}`} data-key={a.key}>
      <div className="aiin-line-head">
        {tickable ? (
          <input id={`${id}-tick`} type="checkbox" className="aiin-tick" checked={ticked} onChange={(e) => onTick?.(e.target.checked)} />
        ) : (
          <span className="aiin-tick-space" aria-hidden="true" />
        )}
        <div className="aiin-line-main">
          {tickable ? (
            <label htmlFor={`${id}-tick`} className="aiin-line-title">
              {a.title}
            </label>
          ) : (
            <span className="aiin-line-title">{a.title}</span>
          )}
          <span className="aiin-line-chips">
            <Badge tone={TIER_TONE[a.tier]}>{tierLabel(a)}</Badge>
            {!preview && <Badge tone={STATE_TONE[a.state]}>{STATE_LABEL[a.state]}</Badge>}
            <span className={`aiin-source aiin-source-${a.source}`} title={`Read from ${FROM_LABEL[a.from]}`}>
              {SOURCE_LABEL[a.source]}
            </span>
          </span>
        </div>
      </div>
      <div className="aiin-line-body">
        {a.at && a.type === 'event' && !a.title.includes(whenText(a.at, a.precision)) && <div className="small">{whenText(a.at, a.precision)}</div>}
        {a.detail && <div className="small">{a.detail}</div>}
        {a.current !== null && a.current !== undefined && a.current !== '' && (
          <div className="small">
            <span className="muted">On file now:</span> <span className="strong">{a.current}</span>
          </div>
        )}
        {a.why && <div className="small aiin-why">{a.why}</div>}
        {a.quote && (
          <div className="small aiin-quote">
            <span className="muted">From {FROM_LABEL[a.from]}:</span> <mark>“{a.quote}”</mark>
          </div>
        )}
        {confidence && <div className="small aiin-warn">{confidence}</div>}
        {canEdit && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {editing ? 'Done changing' : 'Change'}
            </Button>
            {editing && (
              <div className="aiin-edits">
                {a.editable.map((f) => (
                  <EditField key={f} field={f} action={a} edits={edits} onEdit={(p) => onEdit?.(p)} />
                ))}
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {!preview && result?.message && <div className="small">{result.message}</div>}
        {!preview && result?.error && (
          <div className="small aiin-error" role="alert">
            {result.error.message}
          </div>
        )}
        {!preview && a.state === 'applied' && !a.undo.available && a.undo.why && <div className="xs muted">Undo: {a.undo.why}</div>}
        {(a.link || (!preview && (canUndoLine(a) || canRetryLine(a)))) && (
          <div className="row aiin-line-actions">
            {a.link && (
              <Link className="small" to={a.link}>
                Open
              </Link>
            )}
            {!preview && canUndoLine(a) && onUndo && (
              <Button size="sm" onClick={onUndo} loading={busy}>
                Undo
              </Button>
            )}
            {!preview && canRetryLine(a) && onRetry && (
              <Button size="sm" variant="primary" onClick={onRetry} loading={busy}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
