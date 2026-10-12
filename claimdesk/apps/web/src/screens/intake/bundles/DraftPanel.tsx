// owned by intake-web
/**
 * Draft claim (docs/SMART-INTAKE.md §11.4): one reconciled claim read from all the files together. Each row shows the
 * value, a confidence bar, its status (Conflict / Low confidence / Missing / Set by you / Invalid), the source chip
 * ("V5C · p1" → provenance drawer) and a pencil to set the value yourself. Your values always win and are kept as
 * corrections for the Knowledge Builder.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Checkbox, TextArea, TextInput } from '../../../components/Form';
import { isApiError } from '../../../api/client';
import type { BundleDetail, DraftField, FieldSource, WitnessDraft } from '../../../api/bundlesApi';
import { ConfidenceBar, SourceChip } from './bundleParts';
import { circumstancesNote, FIELD_STATUS_LABEL, FIELD_STATUS_TONE, fieldsBySection } from './bundleModel';

export interface DraftActions {
  setField: (key: string, value: string | null, note?: string) => Promise<unknown>;
  setWitnesses: (witnesses: Array<{ name: string; phone?: string; relationship: string }>, answered: boolean) => Promise<unknown>;
  linkParty: (partyId: string | null) => void;
  openSource: (field: DraftField, s: FieldSource) => void;
}

function errorText(e: unknown): string {
  if (isApiError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function FieldRow({ field, actions, closed }: { field: DraftField; actions: DraftActions; closed: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const long = field.key === 'accident.circumstances';
  const start = () => {
    setValue(field.value ?? '');
    setError(null);
    setEditing(true);
  };
  const save = async (v: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await actions.setField(field.key, v);
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={`bdl-field bdl-field-${field.status}`} data-key={field.key}>
      <div className="bdl-field-label">
        {field.label}
        {field.keyField && <span className="bdl-key" title="Key detail">•</span>}
        {field.sensitive && (
          <Badge tone="grey" title="Personal or sensitive">
            private
          </Badge>
        )}
      </div>
      {editing ? (
        <div className="bdl-field-edit">
          {long ? (
            <TextArea label={`New value for ${field.label}`} value={value} onChange={setValue} rows={4} error={error ?? undefined} autoFocus />
          ) : (
            <TextInput
              label={`New value for ${field.label}`}
              value={value}
              onChange={setValue}
              error={error ?? undefined}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save(value.trim() || null);
                if (e.key === 'Escape') setEditing(false);
              }}
            />
          )}
          <div className="row">
            <Button size="sm" variant="primary" onClick={() => void save(value.trim() || null)} loading={saving}>
              Save
            </Button>
            {field.status === 'owner_set' && (
              <Button size="sm" variant="ghost" onClick={() => void save(null)} disabled={saving} title="Go back to what the documents say">
                Use the documents’ value
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="bdl-field-value">
          <span className={field.value ? 'bdl-value' : 'muted'}>{field.display ?? field.value ?? '—'}</span>
          {!field.validator.ok && field.validator.message && <div className="small bdl-error">{field.validator.message}</div>}
          {field.note && <div className="small muted">{field.note}</div>}
        </div>
      )}
      <div className="bdl-field-side">
        {field.value ? <ConfidenceBar value={field.confidence} /> : null}
        {field.status !== 'ok' && <Badge tone={FIELD_STATUS_TONE[field.status]}>{FIELD_STATUS_LABEL[field.status]}</Badge>}
        {field.source && <SourceChip source={field.source} onOpen={(s) => actions.openSource(field, s)} />}
        {field.alternatives.length > 0 && field.status !== 'conflict' && (
          <span className="small muted" title={field.alternatives.map((a) => a.display).join(', ')}>
            +{field.alternatives.length} other {field.alternatives.length === 1 ? 'reading' : 'readings'}
          </span>
        )}
        {!closed && !editing && (
          <Button size="sm" variant="ghost" onClick={start} aria-label={`Edit ${field.label}`} title="Set it yourself">
            ✎
          </Button>
        )}
      </div>
    </div>
  );
}

interface WitnessRow {
  name: string;
  phone: string;
  relationship: string;
}

function WitnessEditor({ initial, answered, onSave, onCancel }: { initial: WitnessDraft[]; answered: boolean; onSave: (rows: WitnessRow[], none: boolean) => Promise<void>; onCancel: () => void }) {
  const [rows, setRows] = useState<WitnessRow[]>(() => (initial.length ? initial.map((w) => ({ name: w.name, phone: w.phone ?? '', relationship: w.relationship ?? '' })) : []));
  const [none, setNone] = useState(answered && initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (i: number, k: keyof WitnessRow, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const submit = async () => {
    const clean = rows.filter((r) => r.name.trim());
    if (!none && clean.some((r) => !r.relationship.trim())) {
      setError('Say how each witness knows the client (for example “none — passer-by”).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(none ? [] : clean, none);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="stack-sm">
      <Checkbox label="There were no witnesses" checked={none} onChange={setNone} />
      {!none &&
        rows.map((r, i) => (
          <div key={i} className="bdl-witness-row">
            <TextInput label="Name" value={r.name} onChange={(v) => set(i, 'name', v)} />
            <TextInput label="Phone" type="tel" value={r.phone} onChange={(v) => set(i, 'phone', v)} />
            <TextInput label="How they know the client" value={r.relationship} onChange={(v) => set(i, 'relationship', v)} />
            <Button size="sm" variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label={`Remove witness ${i + 1}`}>
              Remove
            </Button>
          </div>
        ))}
      {!none && (
        <Button size="sm" onClick={() => setRows((r) => [...r, { name: '', phone: '', relationship: '' }])}>
          Add a witness
        </Button>
      )}
      {error && <div className="field-error">{error}</div>}
      <div className="row">
        <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
          Save witnesses
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Witnesses({ detail, actions, closed }: { detail: BundleDetail; actions: DraftActions; closed: boolean }) {
  const [editing, setEditing] = useState(false);
  const { witnesses, witnessesAnswered } = detail.draft;
  return (
    <div className="bdl-section">
      <div className="row-between">
        <h4 className="bdl-subhead">Witnesses</h4>
        {!closed && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit witnesses
          </Button>
        )}
      </div>
      {editing ? (
        <WitnessEditor
          initial={witnesses}
          answered={witnessesAnswered}
          onCancel={() => setEditing(false)}
          onSave={async (rows, none) => {
            await actions.setWitnesses(
              rows.map((r) => ({ name: r.name.trim(), ...(r.phone.trim() ? { phone: r.phone.trim() } : {}), relationship: r.relationship.trim() })),
              none || rows.length > 0,
            );
            setEditing(false);
          }}
        />
      ) : witnesses.length ? (
        <ul className="bdl-list">
          {witnesses.map((w, i) => (
            <li key={`${w.name}-${i}`}>
              <span className="bdl-value">{w.name}</span>
              {w.phone ? ` · ${w.phone}` : ''}
              {w.relationship ? ` · ${w.relationship}` : <Badge tone="amber">how they know the client?</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{witnessesAnswered ? 'No witnesses (the documents say so).' : 'The documents do not say whether there were witnesses — ask on the call.'}</p>
      )}
    </div>
  );
}

export function DraftPanel({ detail, actions, closed }: { detail: BundleDetail; actions: DraftActions; closed: boolean }) {
  const sections = fieldsBySection(detail.draft.fields);
  const circ = circumstancesNote(detail);
  const party = detail.draft.existingParty;
  return (
    <Card title="Draft claim" id="bundle-draft">
      {party && (
        <div className="notice notice-info bdl-banner">
          Same person as the client on{' '}
          {party.claims.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ', ' : ''}
              <Link to={`/claims/${encodeURIComponent(c.id)}`}>{c.reference}</Link>
            </span>
          ))}{' '}
          ({party.how === 'licence' ? 'same licence number' : 'same name and date of birth'}) — use that record?
          {!closed && (
            <span className="row">
              <Button size="sm" onClick={() => actions.linkParty(party.partyId)}>
                Use {party.name}’s record
              </Button>
              <Button size="sm" variant="ghost" onClick={() => actions.linkParty(null)}>
                Keep a new record
              </Button>
            </span>
          )}
        </div>
      )}
      {sections.length === 0 && <p className="small muted">Nothing read yet — the draft appears as the files are read.</p>}
      {sections.map((s) => (
        <div key={s.section} className="bdl-section">
          <h4 className="bdl-subhead">{s.label}</h4>
          {s.fields.map((f) => (
            <div key={f.key}>
              <FieldRow field={f} actions={actions} closed={closed} />
              {f.key === 'accident.circumstances' && circ && <div className={`small bdl-attr bdl-attr-${circ.tone}`}>{circ.text}</div>}
            </div>
          ))}
        </div>
      ))}
      <Witnesses detail={detail} actions={actions} closed={closed} />
    </Card>
  );
}
