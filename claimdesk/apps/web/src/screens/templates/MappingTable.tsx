import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '../../api/client';
import { useResetDocxMapping, useSaveDocxMapping, type DocxFieldDef, type DocxSlot, type DocxTemplateDetail, type FillPolicy, type FormatName } from '../../api/templatesApi';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox, Select, TextInput } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { EmptyState } from '../../components/EmptyState';
import { useToast } from '../../components/Toast';
import { GroupedSelect, type OptionGroup } from '../claim/components/GroupedSelect';
import {
  allowedPolicyOptions,
  applyFieldSelection,
  applyPolicy,
  buildMappingPutBody,
  fieldSelectGroups,
  fieldSelectValue,
  FORMAT_OPTIONS,
  groupSlotsBySection,
  mappingDraftCounts,
  mappingDraftFromDetail,
  mappingIssueLabel,
  mappingStatusBadge,
  policyFloor,
  POLICY_LABEL,
  slotKindLabel,
  type MappingDraft,
  type MappingDraftRow
} from './templates';

/**
 * Mapping editor (§C.9): every blank the scanner found, grouped by section in outline order. Each blank is mapped to
 * a claim field, left to the handler, or left as printed; the policy can only be made stricter than the field's
 * default. Signature boxes are locked. Save writes exact slot ids (PUT /docx-templates/:id/mapping).
 */
export function MappingTable({ detail }: { detail: DocxTemplateDetail }) {
  const [draft, setDraft] = useState<MappingDraft>(() => mappingDraftFromDetail(detail));
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const save = useSaveDocxMapping(detail.id);
  const reset = useResetDocxMapping(detail.id);
  const toast = useToast();

  useEffect(() => {
    setDraft(mappingDraftFromDetail(detail));
    // a new file version or a saved revision replaces the draft
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.fileVersion, detail.mappingRevision]);

  const sections = useMemo(() => groupSlotsBySection(detail.slots, detail.outline), [detail.slots, detail.outline]);
  const fieldGroups = useMemo(() => fieldSelectGroups(detail.fields) as OptionGroup<string>[], [detail.fields]);
  const counts = mappingDraftCounts(detail.slots, draft);
  const saveIssues = isApiError(save.error) && save.error.code === 'MAPPING_INVALID' ? ((save.error.details as { issues?: Array<{ code: string; detail?: string }> } | undefined)?.issues ?? []) : [];

  const onSave = () =>
    save.mutate(buildMappingPutBody(detail.slots, draft), {
      onSuccess: () => toast.success('Mapping saved')
    });

  return (
    <Card
      title="Mapping"
      flush
      actions={
        <>
          {detail.source === 'builtin' && (
            <Button size="sm" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => toast.success('Mapping reset to the built-in default') })} title="Drop your changes and use the mapping that ships with ClaimDesk">
              Reset to default
            </Button>
          )}
          {counts.changed > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(mappingDraftFromDetail(detail))}>
              Discard changes
            </Button>
          )}
          <Button size="sm" variant="primary" loading={save.isPending} disabled={counts.changed === 0} onClick={onSave}>
            Save mapping
          </Button>
        </>
      }
    >
      <div className="xs muted" style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
        {`${counts.mapped} filled from the claim · ${counts.handler} entered by the handler · ${counts.ignored} left as printed · ${counts.signature} signed by hand · ${counts.unmapped} not mapped${counts.changed > 0 ? ` · ${counts.changed} changed, not saved` : ''}`}
      </div>
      {detail.mappingIssues.length > 0 && (
        <div className="notice notice-warn small" style={{ margin: 12 }}>
          <strong>The mapping needs attention.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {detail.mappingIssues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {mappingIssueLabel(i.code)}: <span className="mono xs">{i.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ padding: '0 12px' }}>
        <ApiErrorNotice error={save.error ?? reset.error} what="save the mapping" />
        {saveIssues.length > 0 && (
          <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
            {saveIssues.map((i, n) => (
              <li key={n}>
                {mappingIssueLabel(i.code)}
                {i.detail ? `: ${i.detail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      {detail.slots.length === 0 ? (
        <EmptyState title="No blanks found">The scanner found nothing to fill in this file.</EmptyState>
      ) : (
        <>
          <div className="map-row xs muted strong" aria-hidden="true" style={{ background: 'var(--surface-2)' }}>
            <span>Blank in the template</span>
            <span>Filled with</span>
            <span>Policy</span>
            <span>Status</span>
          </div>
          {sections.map((sec) => (
            <section key={sec.key || 'document'} aria-label={sec.title}>
              <div className="map-section-title">{sec.title}</div>
              {sec.slots.map((slot) => {
                const row = draft[slot.id];
                if (!row) return null;
                return (
                  <MappingRow
                    key={slot.id}
                    slot={slot}
                    row={row}
                    fields={detail.fields}
                    fieldGroups={fieldGroups}
                    optionsOpen={optionsFor === slot.id}
                    onToggleOptions={() => setOptionsFor((s) => (s === slot.id ? null : slot.id))}
                    onChange={(next) => setDraft((d) => ({ ...d, [slot.id]: next }))}
                  />
                );
              })}
            </section>
          ))}
        </>
      )}
    </Card>
  );
}

const REMOVE_OPTIONS: Array<{ value: 'paragraph' | 'row'; label: string }> = [
  { value: 'paragraph', label: 'Remove the paragraph' },
  { value: 'row', label: 'Remove the table row' }
];

function MappingRow({
  slot,
  row,
  fields,
  fieldGroups,
  optionsOpen,
  onToggleOptions,
  onChange
}: {
  slot: DocxSlot;
  row: MappingDraftRow;
  fields: DocxFieldDef[];
  fieldGroups: OptionGroup<string>[];
  optionsOpen: boolean;
  onToggleOptions: () => void;
  onChange: (row: MappingDraftRow) => void;
}) {
  const locked = slot.signature || row.mode === 'signature';
  const status = mappingStatusBadge(row, slot);
  const floor = policyFloor(row, fields);
  const policyOptions = allowedPolicyOptions(floor).map((p) => ({ value: p, label: POLICY_LABEL[p] }));
  const editable = !locked && (row.mode === 'field' || row.mode === 'handler');
  const field = row.mode === 'field' ? fields.find((f) => f.key === row.key) : undefined;
  return (
    <div className="map-row" data-slot={slot.id}>
      <div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <strong className="small">{slot.label || slot.labelSlug}</strong>
          <Badge tone="grey">{slotKindLabel(slot.kind)}</Badge>
          {slot.qualifierTitle && <span className="chip">{slot.qualifierTitle}</span>}
        </div>
        {slot.preview && <div className="map-slot-preview">{slot.preview}</div>}
        {slot.options && slot.options.length > 0 && <div className="xs muted">Options: {slot.options.map((o) => o.label).join(' · ')}</div>}
        <div className="xs muted mono" style={{ overflowWrap: 'anywhere' }}>
          {slot.id}
        </div>
      </div>
      <div>
        {locked ? (
          <div className="xs muted">Signed by hand — never filled</div>
        ) : (
          <>
            <GroupedSelect value={fieldSelectValue(row)} onChange={(v) => onChange(applyFieldSelection(row, v, fields, slot))} groups={fieldGroups} placeholder="Not mapped" />
            {field && <div className="xs muted mono">{field.key}</div>}
          </>
        )}
      </div>
      <div>
        {editable ? (
          <Select aria-label={`Policy for ${slot.label}`} value={row.policy} options={policyOptions} onChange={(p) => p && onChange(applyPolicy(row, p as FillPolicy, fields))} />
        ) : (
          <span className="xs muted">{locked ? POLICY_LABEL.signature : row.mode === 'ignore' ? POLICY_LABEL.never : '—'}</span>
        )}
      </div>
      <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
        <Badge tone={status.tone} title={status.title}>
          {status.label}
        </Badge>
        {editable && (
          <Button size="sm" variant="ghost" onClick={onToggleOptions} aria-expanded={optionsOpen}>
            Options
          </Button>
        )}
      </div>
      {editable && optionsOpen && (
        <div className="map-options">
          {(slot.kind === 'checkbox' || slot.kind === 'control') && (
            <TextInput label="Tick when the value is" value={row.when ?? ''} onChange={(v) => onChange({ ...row, when: v.trim() || undefined, changed: true })} hint="An option code of the field, e.g. standard" />
          )}
          <Select label="Format" value={row.format ?? 'auto'} options={FORMAT_OPTIONS} onChange={(v) => onChange({ ...row, format: (v || 'auto') as FormatName, changed: true })} />
          <Select label="If there is no value" value={row.removeIfEmpty ?? ''} options={REMOVE_OPTIONS} placeholder="Leave the blank as printed" onChange={(v) => onChange({ ...row, removeIfEmpty: v || undefined, changed: true })} />
          <TextInput label="Label in the values form" value={row.label ?? ''} onChange={(v) => onChange({ ...row, label: v || undefined, changed: true })} placeholder={slot.label} />
          <Checkbox label="Required before a document can be made" checked={Boolean(row.required)} onChange={(c) => onChange({ ...row, required: c || undefined, changed: true })} />
        </div>
      )}
    </div>
  );
}
