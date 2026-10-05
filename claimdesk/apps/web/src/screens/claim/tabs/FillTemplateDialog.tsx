import { useMemo, useReducer, type Dispatch } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isApiError } from '../../../api/client';
import { useDocxTemplates, useDocxValues, useGenerateDocxDocument, type ClaimTemplateValues, type DocxTemplateSummary, type FillPlanIssue, type PlanRow, type SlotInput } from '../../../api/templatesApi';
import { Badge, VerificationBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { Checkbox, DateInput, DateTimeInput, MoneyInput, Select, TextArea, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import type { ClaimView } from '../claimFile';
import { flagCounts } from '../lib/documents';
import {
  buildGenerateBody,
  computeSummary,
  effectiveInput,
  fillReducer,
  generateBlocker,
  groupsOf,
  GTA_BENCHMARK_CAVEAT,
  hasEdit,
  initialFillState,
  isGtaRow,
  missingRequired,
  narrowCellHint,
  openBlockingIssues,
  rowBadge,
  rowsOf,
  subjectBlocker,
  subjectOptions,
  summaryLine,
  warningIssues,
  type FillAction,
  type FillState
} from '../lib/fillValues';
import { defaultVariant, pickerGroups, recipientRoleLabel, templateStatusBadge } from '../../templates/templates';
import '../../templates/templates.css';

export interface FillTemplateDialogProps {
  view: ClaimView;
  onClose: () => void;
  /** Open with this template already chosen. */
  initialTemplateId?: string;
  /** Start from a prepared state (deep links and tests). */
  initialState?: Partial<FillState>;
}

/**
 * Claim → Documents → "Fill a CCGUK template" (§C.9): 1 choose the Word template (variant, subjects), 2 check the
 * values the claim supplies and enter or confirm the rest, 3 generate a draft .docx and open it. Signature boxes and
 * printed wording are never filled; suggested values print only when the handler ticks to confirm them.
 */
export function FillTemplateDialog({ view, onClose, initialTemplateId, initialState }: FillTemplateDialogProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const templatesQ = useDocxTemplates();
  const [state, dispatch] = useReducer(fillReducer, undefined, () => initialFillState({ templateId: initialTemplateId ?? '', ...initialState }));
  const templates = templatesQ.data ?? [];
  const template = templates.find((t) => t.id === state.templateId);
  const variant = state.variant ?? defaultVariant(template);
  const valuesQ = useDocxValues(view.claim.id, state.templateId || undefined, variant, state.subject, { enabled: Boolean(template) });
  const values = valuesQ.data;
  const generate = useGenerateDocxDocument(view.claim.id);
  const effectiveState: FillState = { ...state, variant };
  const rows = useMemo(() => rowsOf(values), [values]);
  const groups = useMemo(() => groupsOf(values), [values]);
  const subjectsNeeded = template?.subjects ?? values?.template.subjects ?? [];
  const subjectIssue = subjectBlocker(subjectsNeeded, state.subject);
  const blocker = state.step === 'check' ? generateBlocker(values, effectiveState) : undefined;

  const submit = () => {
    if (!values || blocker) return;
    const body = buildGenerateBody(effectiveState, rows);
    generate.mutate(body, {
      onSuccess: (doc) => {
        const c = flagCounts(doc.consistency);
        if (c.blocking > 0 || doc.status === 'blocked') toast.warn(`${doc.title} drafted with ${c.blocking} block flag${c.blocking === 1 ? '' : 's'} — clear each with a reason before approval`);
        else toast.success(`${doc.title} drafted as a Word document`);
        onClose();
        navigate(`/claims/${view.claim.id}/documents/${doc.id}`);
      }
    });
  };

  const footer =
    state.step === 'choose' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!template || Boolean(subjectIssue)} title={!template ? 'Choose a template' : subjectIssue} onClick={() => dispatch({ type: 'next' })}>
          Check the values
        </Button>
      </>
    ) : (
      <>
        <Button onClick={() => dispatch({ type: 'back' })}>Back</Button>
        <Button variant="primary" loading={generate.isPending} disabled={Boolean(blocker) || valuesQ.isFetching} title={blocker} onClick={submit}>
          Generate
        </Button>
      </>
    );

  return (
    <Modal open size="lg" title="Fill a CCGUK template" onClose={onClose} footer={footer}>
      <div className="stack">
        <div className="step-list" aria-label="Steps">
          <span className={`step ${state.step === 'choose' ? 'current' : 'done'}`}>1 · Choose</span>
          <span className={`step ${state.step === 'check' ? 'current' : ''}`}>2 · Check the values</span>
          <span className="step">3 · Generate</span>
        </div>
        {state.step === 'choose' ? (
          <ChooseStep view={view} state={state} dispatch={dispatch} templates={templates} loading={templatesQ.isLoading} error={templatesQ.error} template={template} variant={variant} values={values} />
        ) : (
          <div className="stack">
            <div className="row-between">
              <div>
                <strong>{template?.title ?? values?.template.title ?? state.templateId}</strong>
                {variant && template && <span className="xs muted"> · {template.variants.find((v) => v.id === variant)?.label ?? variant}</span>}
              </div>
              <Button size="sm" variant="ghost" loading={valuesQ.isFetching} onClick={() => void valuesQ.refetch()} title="Read the claim again; what you typed is kept">
                Refresh from claim
              </Button>
            </div>
            <ApiErrorNotice error={valuesQ.error} what="read the values from the claim" />
            {valuesQ.isLoading && <Loading label="Reading the claim…" />}
            {values && (
              <>
                <div className="fill-summary">{summaryLine(computeSummary(rows, effectiveState))}</div>
                <IssuesPanel issues={values.issues ?? []} rows={rows} state={effectiveState} templateId={state.templateId} />
                {groups.length === 0 && <EmptyState title="Nothing to fill">This template has no blanks mapped to the claim.</EmptyState>}
                {groups.map((g) => {
                  const open = !state.collapsed.includes(g.section);
                  const gs = computeSummary(g.rows, effectiveState);
                  const note = [`${g.rows.length} blank${g.rows.length === 1 ? '' : 's'}`, gs.toConfirm ? `${gs.toConfirm} to confirm` : '', gs.toEnter ? `${gs.toEnter} to enter` : ''].filter(Boolean).join(' · ');
                  return (
                    <details key={g.section} className="fill-section" open={open}>
                      <summary
                        onClick={(e) => {
                          e.preventDefault();
                          dispatch({ type: 'toggleSection', section: g.section });
                        }}
                      >
                        <span>{g.title}</span>
                        <span className="xs muted">{note}</span>
                      </summary>
                      {open && g.rows.map((row) => <ValueRow key={row.slotId} row={row} state={effectiveState} dispatch={dispatch} />)}
                    </details>
                  );
                })}
              </>
            )}
            <GenerateError error={generate.error} />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — choose
// ---------------------------------------------------------------------------

function ChooseStep({
  view,
  state,
  dispatch,
  templates,
  loading,
  error,
  template,
  variant,
  values
}: {
  view: ClaimView;
  state: FillState;
  dispatch: Dispatch<FillAction>;
  templates: DocxTemplateSummary[];
  loading: boolean;
  error: unknown;
  template: DocxTemplateSummary | undefined;
  variant: string | undefined;
  values: ClaimTemplateValues | undefined;
}) {
  const groups = useMemo(() => pickerGroups(templates), [templates]);
  const options = subjectOptions(values, view);
  const subjects = template?.subjects ?? [];
  return (
    <div className="stack">
      <ApiErrorNotice error={error} what="load the Word templates" />
      {loading ? (
        <Loading label="Loading the Word templates…" />
      ) : groups.length === 0 ? (
        <EmptyState title="No Word templates available">An administrator can add them under Settings → Document templates.</EmptyState>
      ) : (
        <div className="tpl-groups" role="list">
          {groups.map((g) => (
            <div key={g.id} role="listitem">
              <div className="tpl-group-title">{g.label}</div>
              <div className="tpl-cards">
                {g.templates.map((t) => {
                  const status = templateStatusBadge(t);
                  return (
                    <button key={t.id} type="button" className="tpl-card" aria-pressed={t.id === state.templateId} onClick={() => dispatch({ type: 'chooseTemplate', template: t })} data-template={t.id}>
                      <span className="tpl-card-title">{t.title}</span>
                      {t.description && <span className="xs muted">{t.description}</span>}
                      <span className="row" style={{ gap: 4 }}>
                        <Badge tone="blue">Word</Badge>
                        {status.label !== 'Ready' && <Badge tone={status.tone} title={status.title}>{status.label}</Badge>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {template && (
        <fieldset className="fieldset">
          <legend>{template.title}</legend>
          <div className="form-grid">
            {template.variants.length > 0 && (
              <Select label="Version" value={variant ?? ''} onChange={(v) => dispatch({ type: 'setVariant', variant: v || undefined })} options={template.variants.map((v) => ({ value: v.id, label: v.label }))} />
            )}
            {subjects.includes('witness') && (
              <Select label="Witness" required value={state.subject.witnessPartyId ?? ''} onChange={(v) => dispatch({ type: 'setSubject', subject: { witnessPartyId: v || undefined } })} options={options.witnesses} placeholder="Choose the witness…" hint={options.witnesses.length ? undefined : 'Add the witness as a party on the claim first'} />
            )}
            {subjects.includes('offer') && (
              <Select label="Intervention offer" value={state.subject.offerId ?? ''} onChange={(v) => dispatch({ type: 'setSubject', subject: { offerId: v || undefined } })} options={options.offers} placeholder={options.offers.length ? 'The latest offer on the claim' : 'No offer on the claim — records "no offer made"'} hint={options.offers.length ? 'The record is filled from this offer; choose another if needed.' : undefined} />
            )}
            {subjects.includes('hire') && (
              <Select label="Hire agreement" value={state.subject.hireAgreementId ?? ''} onChange={(v) => dispatch({ type: 'setSubject', subject: { hireAgreementId: v || undefined } })} options={options.hires} placeholder="The latest hire agreement" />
            )}
            {subjects.includes('recipient') && (
              <Select label="Recipient" value={state.subject.recipientPartyId ?? ''} onChange={(v) => dispatch({ type: 'setSubject', subject: { recipientPartyId: v || undefined } })} options={options.recipients} placeholder={`Template default (${recipientRoleLabel(template.recipientRole).toLowerCase()})`} />
            )}
          </div>
          {subjects.includes('witness') && options.exhibits.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="field-label">Exhibits referred to in the statement</div>
              <div className="choice-list">
                {options.exhibits.map((e) => {
                  const selected = state.subject.exhibitEvidenceIds ?? [];
                  const on = selected.includes(e.value);
                  return (
                    <Checkbox
                      key={e.value}
                      label={e.label}
                      checked={on}
                      onChange={(c) => dispatch({ type: 'setSubject', subject: { exhibitEvidenceIds: c ? [...selected, e.value] : selected.filter((id) => id !== e.value) } })}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {!template.warningsAcknowledged && template.warnings.length > 0 && (
            <div className="notice notice-warn small" style={{ marginTop: 10 }}>
              This template's wording has not been reviewed yet, so a document cannot be made from it. <Link to={`/settings/templates/${encodeURIComponent(template.id)}`}>Review it in Settings → Document templates</Link>.
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — values
// ---------------------------------------------------------------------------

function IssuesPanel({ issues, rows, state, templateId }: { issues: FillPlanIssue[]; rows: PlanRow[]; state: FillState; templateId: string }) {
  const blocking = openBlockingIssues(issues, rows, state);
  const warnings = warningIssues(issues);
  const missing = missingRequired(rows, state).filter((r) => !blocking.some((i) => i.slotId === r.slotId));
  if (!blocking.length && !warnings.length && !missing.length) return null;
  return (
    <div className="stack-sm">
      {blocking.length > 0 && (
        <div className="notice notice-danger small" role="alert">
          <strong>Cannot generate yet.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {blocking.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {i.message}
                {i.code === 'TEMPLATE_WARNINGS_UNACKNOWLEDGED' && (
                  <>
                    {' '}
                    <Link to={`/settings/templates/${encodeURIComponent(templateId)}`}>Review the template</Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="notice notice-danger small">
          <strong>Required:</strong> {missing.map((r) => r.label).join(', ')}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice notice-warn small">
          <strong>Check before approval.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {warnings.map((i, n) => (
              <li key={`${i.code}-${n}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ValueRow({ row, state, dispatch }: { row: PlanRow; state: FillState; dispatch: Dispatch<FillAction> }) {
  const badge = rowBadge(row, state);
  const value = effectiveInput(row, state);
  const edited = hasEdit(state, row.slotId);
  const confirmed = row.confirmed || state.confirmed.includes(row.slotId);
  const hint = narrowCellHint(row);
  const missing = row.required && missingRequired([row], state).length > 0;
  const set = (raw: SlotInput) => dispatch({ type: 'edit', slotId: row.slotId, value: raw });
  return (
    <div className={`fill-row ${badge.locked ? 'locked' : ''}`} data-slot={row.slotId}>
      <div>
        <div className="fill-row-label">
          {row.label}
          {row.required && (
            <span className="req" title="Required">
              *
            </span>
          )}
        </div>
        <div className="fill-row-meta">
          <Badge tone={badge.tone} title={row.sourcePath ? `Source: ${row.sourcePath}` : undefined}>
            {badge.label}
          </Badge>
          {row.verification && <VerificationBadge verification={row.verification} />}
          {edited && !badge.locked && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'revert', slotId: row.slotId })}>
              Undo
            </Button>
          )}
        </div>
        {badge.confirm && (
          <div style={{ marginTop: 6 }}>
            <Checkbox label="Confirm this value" checked={confirmed} onChange={(c) => dispatch({ type: 'confirm', slotId: row.slotId, confirmed: c })} />
          </div>
        )}
      </div>
      <div className="fill-row-input">
        {badge.locked ? (
          <div className="xs muted">{row.policy === 'signature' ? 'Left blank: signed by hand on paper or by e-signature.' : row.preview ? `As printed: ${row.preview}` : 'Left exactly as printed.'}</div>
        ) : (
          <RowInput row={row} value={value} onChange={set} />
        )}
        {!badge.locked && !edited && row.display && <div className="fill-row-print">{`Prints: ${row.display}`}</div>}
        {hint && <div className="field-hint">{hint}</div>}
        {row.note && <div className="field-hint">{row.note}</div>}
        {isGtaRow(row) && <div className="field-hint">{GTA_BENCHMARK_CAVEAT}</div>}
        {missing && <div className="field-error">Required before the document can be made</div>}
      </div>
    </div>
  );
}

function text(v: SlotInput): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function RowInput({ row, value, onChange }: { row: PlanRow; value: SlotInput; onChange: (v: SlotInput) => void }) {
  const label = `${row.label}`;
  switch (row.inputType) {
    case 'multiline':
      return <TextArea aria-label={label} value={text(value)} onChange={onChange} rows={3} />;
    case 'date':
      return <DateInput aria-label={label} value={text(value).slice(0, 10)} onChange={onChange} />;
    case 'datetime':
      return <DateTimeInput aria-label={label} value={text(value)} onChange={onChange} />;
    case 'time':
      return <TextInput aria-label={label} value={text(value)} onChange={onChange} placeholder="HH:MM" inputMode="numeric" />;
    case 'money':
      return <MoneyInput aria-label={label} value={typeof value === 'number' ? value : null} onChange={onChange} />;
    case 'int':
      return <TextInput aria-label={label} value={text(value)} onChange={onChange} inputMode="numeric" />;
    case 'checkbox':
      return <Checkbox label="Tick this box" checked={value === true} onChange={onChange} />;
    case 'choice': {
      const selected = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === 'string') : typeof value === 'string' ? [value] : [];
      const options = row.options ?? [];
      if (row.multiple) {
        return (
          <div className="choice-list" role="group" aria-label={label}>
            {options.map((o) => (
              <Checkbox key={o.value} label={o.label} checked={selected.includes(o.value)} onChange={(c) => onChange(c ? [...selected, o.value] : selected.filter((s) => s !== o.value))} />
            ))}
          </div>
        );
      }
      return <Select aria-label={label} value={selected[0] ?? ''} onChange={(v) => onChange(v ? [v] : null)} options={options} placeholder="— leave as printed —" />;
    }
    case 'rows':
      return <RowsEditor row={row} value={value} onChange={onChange} />;
    case 'paragraphs':
      return <ListEditor label={label} value={value} onChange={onChange} />;
    case 'text':
    default:
      return <TextInput aria-label={label} value={text(value)} onChange={onChange} />;
  }
}

/** Small editor for repeating table rows (witnesses, damage log, chronology). */
function RowsEditor({ row, value, onChange }: { row: PlanRow; value: SlotInput; onChange: (v: SlotInput) => void }) {
  const rows = Array.isArray(value) ? (value as unknown[]).filter((r): r is Record<string, string> => Boolean(r) && typeof r === 'object') : [];
  const cols = row.columns ?? [];
  const update = (i: number, col: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
  return (
    <div className="stack-sm">
      {rows.length > 0 && (
        <table className="mini-rows">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.id}>{c.label}</th>
              ))}
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.id}>
                    <input className="input" aria-label={`${c.label}, row ${i + 1}`} value={r[c.id] ?? ''} onChange={(e) => update(i, c.id, e.target.value)} />
                  </td>
                ))}
                <td>
                  <Button size="sm" variant="ghost" aria-label={`Take out row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <Button size="sm" onClick={() => onChange([...rows, {}])}>
          Add a row
        </Button>
      </div>
    </div>
  );
}

/** List editor for numbered paragraphs (witness statement body, letter body). */
function ListEditor({ label, value, onChange }: { label: string; value: SlotInput; onChange: (v: SlotInput) => void }) {
  const items = Array.isArray(value) ? (value as unknown[]).map((x) => (typeof x === 'string' ? x : '')) : typeof value === 'string' && value ? [value] : [];
  return (
    <div className="stack-sm">
      {items.map((item, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
          <span className="xs muted" style={{ paddingTop: 8, minWidth: 18 }}>
            {i + 1}.
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextArea aria-label={`${label}, paragraph ${i + 1}`} value={item} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} rows={2} />
          </div>
          <Button size="sm" variant="ghost" aria-label={`Take out paragraph ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...items, ''])}>
          Add a paragraph
        </Button>
      </div>
    </div>
  );
}

/** The API's refusal, with its issue list when it sends one (400 VALUES_REQUIRED, 409 GUARD_BLOCKED, …). */
function GenerateError({ error }: { error: unknown }) {
  if (!error) return null;
  const details = isApiError(error) ? (error.details as { issues?: Array<{ message?: string }> } | Array<{ message?: string }> | undefined) : undefined;
  const list = Array.isArray(details) ? details : Array.isArray(details?.issues) ? details.issues : [];
  return (
    <div className="stack-sm">
      <ApiErrorNotice error={error} what="make the Word document" />
      {list.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {list.map((i, n) => (
            <li key={n}>{i?.message ?? JSON.stringify(i)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
