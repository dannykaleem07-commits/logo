import { useEffect, useId, useState } from 'react';
import { formatGBP } from '@ccguk/domain';
import '../../styles/screens.css';
import { isApiError } from '../../api/client';
import { useUserName } from '../../api/hooks';
import {
  useCreateGtaRate,
  useDeleteGtaRate,
  useGtaRateSettings,
  useGtaSegments,
  useResetGtaSegment,
  useSetGtaSegment,
  useSuppressGtaRate,
  useUpdateGtaRate,
  type GtaRateListItem,
  type GtaSegmentItem
} from '../../api/vehiclesApi';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Badge, VerificationBadge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateInput, MoneyInput, Select, TextArea, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Loading } from '../../components/Spinner';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { todayISO } from '../../lib/dates';
import {
  emptyRateForm,
  knownGroups,
  ORIGIN_LABEL,
  ORIGIN_TONE,
  RATES_BANNER,
  rateActions,
  rateBodyFrom,
  rateFormFromItem,
  rateOrigin,
  segmentChanged,
  segmentGroupError,
  sortRates,
  validateRateForm,
  VAN_PICKUP_NOTE,
  verifiedByText,
  type RateForm,
  type RateFormErrors
} from './gtaRates';

const errText = (e: unknown) => (isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);

/** "Verified by <name>" under the badge of a verified row. */
function VerifiedBy({ item }: { item: GtaRateListItem }) {
  const name = useUserName(item.verification.verifiedBy);
  const text = verifiedByText(item, name);
  return text ? <div className="xs muted">{text}</div> : null;
}

/**
 * Settings → GTA benchmark rates (§F.4): the knowledge-base rate table with your overrides, hidden rows and your own
 * rows, plus the segment → group starting suggestions used by the fleet GTA panel. An industry benchmark only.
 */
export function GtaRatesPage() {
  const ratesQ = useGtaRateSettings();
  const segmentsQ = useGtaSegments();
  const suppress = useSuppressGtaRate();
  const remove = useDeleteGtaRate();
  const toast = useToast();
  const [editing, setEditing] = useState<{ form: RateForm; title: string } | null>(null);
  const items = sortRates(ratesQ.data?.items ?? []);
  const groups = knownGroups(items);

  const hide = (item: GtaRateListItem, hidden: boolean) =>
    suppress.mutate(
      { group: item.group, period: item.period, suppressed: hidden },
      { onSuccess: () => toast.success(hidden ? `${item.group} ${item.period} hidden — it is no longer used for suggestions or hire benchmarks` : `${item.group} ${item.period} shown again`), onError: (e) => toast.error(errText(e)) }
    );
  const del = (item: GtaRateListItem) => {
    if (!item.id) return;
    if (!window.confirm(`Delete your rate for ${item.group} ${item.period}?${item.overridesKb ? ' The knowledge-base rate shows again.' : ''}`)) return;
    remove.mutate(item.id, { onSuccess: () => toast.success(`Your rate for ${item.group} ${item.period} deleted`), onError: (e) => toast.error(errText(e)) });
  };

  const columns: Column<GtaRateListItem>[] = [
    { key: 'group', header: 'Group', render: (r) => <span className="strong mono">{r.group}</span> },
    { key: 'desc', header: 'Description', className: 'wrap', render: (r) => <span className="small">{r.description ?? '—'}</span> },
    { key: 'rate', header: 'Daily rate', numeric: true, render: (r) => (r.dailyRatePence ? formatGBP(r.dailyRatePence) : '—') },
    { key: 'period', header: 'Period', render: (r) => r.period },
    { key: 'effective', header: 'Effective', render: (r) => <span className="xs nowrap">{`${r.effectiveFrom} – ${r.effectiveTo}`}</span> },
    {
      key: 'origin',
      header: 'Origin',
      render: (r) => {
        const o = rateOrigin(r);
        return (
          <Badge tone={ORIGIN_TONE[o]} title={r.kbRate && o === 'overrides' ? `Knowledge base: ${formatGBP(r.kbRate.dailyRatePence)}` : undefined}>
            {ORIGIN_LABEL[o]}
          </Badge>
        );
      }
    },
    {
      key: 'verification',
      header: 'Verification',
      render: (r) => (
        <div>
          <VerificationBadge verification={r.verification} />
          <VerifiedBy item={r} />
        </div>
      )
    },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const a = rateActions(r);
        return (
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {a.edit && (
              <Button size="sm" onClick={() => setEditing({ form: rateFormFromItem(r), title: a.edit === 'update' ? `Edit your rate — ${r.group} ${r.period}` : `Your rate for ${r.group} ${r.period}` })}>
                Edit
              </Button>
            )}
            {a.hide && (
              <Button size="sm" variant="ghost" onClick={() => hide(r, true)} disabled={suppress.isPending}>
                Hide
              </Button>
            )}
            {a.show && (
              <Button size="sm" variant="ghost" onClick={() => hide(r, false)} disabled={suppress.isPending}>
                Show
              </Button>
            )}
            {a.delete && (
              <Button size="sm" variant="ghost" onClick={() => del(r)} disabled={remove.isPending}>
                Delete
              </Button>
            )}
          </div>
        );
      }
    }
  ];

  return (
    <div className="page">
      <PageHeader
        title="GTA benchmark rates"
        subtitle="Daily rates by GTA group, with where each figure came from and whether it has been checked"
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'GTA benchmark rates' }]}
        actions={
          <Button variant="primary" onClick={() => setEditing({ form: emptyRateForm(todayISO()), title: 'Add a rate' })}>
            Add a rate
          </Button>
        }
      />
      <div className="stack">
        <div className="notice notice-warn" role="note">
          <strong>Industry benchmark only.</strong> {RATES_BANNER}
          {ratesQ.data?.note ? <div className="xs" style={{ marginTop: 4 }}>{ratesQ.data.note}</div> : null}
        </div>

        <Card title="Rates" flush actions={<span className="small muted">{items.length} row{items.length === 1 ? '' : 's'}</span>}>
          <ApiErrorNotice error={ratesQ.error} what="load the GTA rates" />
          {ratesQ.isLoading ? (
            <Loading label="Loading GTA rates…" />
          ) : (
            <Table columns={columns} rows={items} rowKey={(r) => `${r.group}|${r.period}|${r.id ?? 'kb'}`} caption="GTA benchmark rates" empty="No rates loaded" />
          )}
          <p className="xs muted" style={{ padding: '8px 16px' }}>
            Your rate replaces the knowledge-base rate for the same group and period; Hide stops a row being used for fleet suggestions and hire benchmark lines; Delete removes your row (the knowledge-base rate, if any, shows again). Verification is shown exactly as stored.
          </p>
        </Card>

        <SegmentDefaultsCard items={segmentsQ.data ?? []} loading={segmentsQ.isLoading} error={segmentsQ.error} groups={groups} />
      </div>

      <RateDialog state={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/** Add / edit a rate. Verified needs the https:// source; the badge then shows who verified it (set by the server). */
function RateDialog({ state, onClose }: { state: { form: RateForm; title: string } | null; onClose: () => void }) {
  const create = useCreateGtaRate();
  const update = useUpdateGtaRate();
  const toast = useToast();
  const [form, setForm] = useState<RateForm | null>(state?.form ?? null);
  const [errors, setErrors] = useState<RateFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    setForm(state?.form ?? null);
    setErrors({});
    setServerError(null);
  }, [state]);
  if (!state || !form) return null;
  const set = <K extends keyof RateForm>(k: K) => (v: RateForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const busy = create.isPending || update.isPending;

  const save = async () => {
    const e = validateRateForm(form);
    setErrors(e);
    if (Object.keys(e).length) return;
    setServerError(null);
    const body = rateBodyFrom(form);
    try {
      if (form.id) await update.mutateAsync({ id: form.id, body });
      else await create.mutateAsync(body);
      toast.success(`Rate for ${body.group} ${body.period} saved${body.verification?.status === 'verified' ? ' as verified' : ' (unverified)'}`);
      onClose();
    } catch (err) {
      setServerError(errText(err));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={state.title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Save rate
          </Button>
        </>
      }
    >
      <div className="stack">
        {serverError && (
          <div className="notice notice-danger small" role="alert">
            {serverError}
          </div>
        )}
        <div className="form-grid">
          <TextInput label="GTA group" required value={form.group} onChange={set('group')} error={errors.group} placeholder="S1, M, M1, CP1…" autoCapitalize="characters" disabled={form.lockKey} hint={form.lockKey ? 'Your rate replaces the knowledge-base rate for this group and period.' : undefined} />
          <TextInput label="Description" value={form.description} onChange={set('description')} placeholder="Small car (GTA group S1)" />
          <MoneyInput label="Daily rate (ex VAT)" required value={form.dailyRatePence} onChange={set('dailyRatePence')} error={errors.dailyRatePence} />
          <TextInput label="Period" required value={form.period} onChange={set('period')} error={errors.period} placeholder="2026-27" disabled={form.lockKey} />
          <DateInput label="Effective from" required value={form.effectiveFrom} onChange={set('effectiveFrom')} error={errors.effectiveFrom} />
          <DateInput label="Effective to" required value={form.effectiveTo} onChange={set('effectiveTo')} error={errors.effectiveTo} />
          <Select<'unverified' | 'verified'>
            label="Verification"
            value={form.verificationStatus}
            onChange={(v) => set('verificationStatus')(v || 'unverified')}
            options={[
              { value: 'unverified', label: 'Unverified' },
              { value: 'verified', label: 'Verified — I checked it against a source' }
            ]}
            hint="Verified needs the source address; ClaimDesk records you as the person who verified it."
          />
          <TextInput label="Source URL" type="url" value={form.sourceUrl} onChange={set('sourceUrl')} error={errors.sourceUrl} placeholder="https://…" />
          <div className="span-2">
            <TextInput label="Source note" value={form.sourceNote} onChange={set('sourceNote')} placeholder="e.g. GTA 2026-27 rate table, page 2" />
          </div>
          <div className="span-2">
            <TextArea label="Note" value={form.note} onChange={set('note')} rows={2} />
          </div>
        </div>
        <p className="basis">GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber.</p>
      </div>
    </Modal>
  );
}

/** Segment → GTA group starting suggestions (used when the catalogue has no group for a model). */
function SegmentDefaultsCard({ items, loading, error, groups }: { items: GtaSegmentItem[]; loading: boolean; error: unknown; groups: string[] }) {
  const setSegment = useSetGtaSegment();
  const reset = useResetGtaSegment();
  const toast = useToast();
  const listId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = (item: GtaSegmentItem) => {
    const draft = drafts[item.segment] ?? item.group;
    const err = segmentGroupError(draft);
    if (err) {
      toast.warn(`${item.label}: ${err}`);
      return;
    }
    setSegment.mutate(
      { segment: item.segment, group: draft.trim().toUpperCase() },
      {
        onSuccess: () => {
          setDrafts((d) => {
            const { [item.segment]: _gone, ...rest } = d;
            return rest;
          });
          toast.success(`${item.label}: starting group set to ${draft.trim().toUpperCase()}`);
        },
        onError: (e) => toast.error(errText(e))
      }
    );
  };

  const columns: Column<GtaSegmentItem>[] = [
    { key: 'segment', header: 'Segment', render: (s) => s.label },
    {
      key: 'group',
      header: 'GTA group',
      render: (s) => (
        <input
          className="input"
          style={{ maxWidth: 110 }}
          aria-label={`GTA group for ${s.label}`}
          list={listId}
          value={drafts[s.segment] ?? s.group}
          onChange={(e) => setDrafts((d) => ({ ...d, [s.segment]: e.target.value.toUpperCase() }))}
        />
      )
    },
    { key: 'origin', header: 'Origin', render: (s) => <Badge tone={s.origin === 'manual' ? 'blue' : 'grey'}>{s.origin === 'manual' ? 'Your setting' : 'Knowledge base'}</Badge> },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <div className="row" style={{ gap: 4 }}>
          {segmentChanged(s, drafts[s.segment]) && (
            <Button size="sm" variant="primary" onClick={() => save(s)} loading={setSegment.isPending}>
              Save
            </Button>
          )}
          {s.origin === 'manual' && (
            <Button size="sm" variant="ghost" onClick={() => reset.mutate(s.segment, { onSuccess: () => toast.success(`${s.label}: back to the knowledge-base group${s.kbGroup ? ` ${s.kbGroup}` : ''}`), onError: (e) => toast.error(errText(e)) })}>
              Reset
            </Button>
          )}
        </div>
      )
    }
  ];

  return (
    <Card title="Segment defaults" flush>
      <p className="small muted" style={{ padding: '12px 16px 0' }}>
        The starting GTA group for a vehicle segment, used when the catalogue gives no group for a model. A suggestion only — confirm the group for each vehicle.
      </p>
      <ApiErrorNotice error={error} what="load the segment defaults" />
      {loading ? <Loading label="Loading segment defaults…" /> : <Table columns={columns} rows={items} rowKey={(s) => s.segment} caption="Segment defaults" empty="No segment defaults loaded" />}
      <datalist id={listId}>
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <p className="xs muted" style={{ padding: '8px 16px 12px', margin: 0 }}>
        {VAN_PICKUP_NOTE}
      </p>
    </Card>
  );
}
