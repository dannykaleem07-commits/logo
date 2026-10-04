import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ClaimEvent, EventType } from '@ccguk/domain';
import { api } from '../../../api/client';
import { useEvents, usePostEvent } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { Checkbox, DateTimeInput, Select, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { pickList, type ClaimView } from '../claimFile';
import { GroupedSelect } from '../components/GroupedSelect';
import { EvidencePicker } from '../components/EvidencePicker';
import {
  ATTRIBUTABLE_LABEL,
  ATTRIBUTABLE_OPTIONS,
  ATTRIBUTION_EXPLANATION,
  attributableDays,
  defaultAttribution,
  emptyEventForm,
  EVENT_GROUPS,
  EVENT_LABEL,
  eventBodyFrom,
  eventGroup,
  eventLabel,
  filterEvents,
  sortEvents,
  type Attributable,
  type ChronologyFilter
} from '../lib/chronology';

const ATTRIBUTION_TONE: Record<Attributable, 'blue' | 'amber' | 'grey' | 'navy' | 'green'> = {
  insurer: 'blue',
  repairer: 'amber',
  engineer: 'amber',
  client: 'grey',
  third_party: 'grey',
  ccguk: 'navy',
  none: 'grey'
};

/** The dated events table — the hire-period defence — with a fast add-event form and the attributable-days counter. */
export function ChronologyTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const eventsQ = useEvents(claimId);
  const events = pickList(eventsQ.data, view.events);
  const nowIso = new Date().toISOString();
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<ChronologyFilter>({});
  const [form, setForm] = useState(() => emptyEventForm(nowIso));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState(false);
  const typeRef = useRef<HTMLSelectElement>(null);
  const post = usePostEvent(claimId);
  const toast = useToast();

  const hiresEnded = view.hire.length > 0 && view.hire.every((h) => h.endAt);
  const until = hiresEnded ? view.hire.map((h) => h.endAt as string).sort().slice(-1)[0] ?? nowIso : nowIso;
  const days = useMemo(() => attributableDays(events, until), [events, until]);
  const rows = useMemo(() => sortEvents(filterEvents(events, filter), dir), [events, filter, dir]);
  const evidenceById = useMemo(() => new Map(view.evidence.map((e) => [e.id, e])), [view.evidence]);

  const groups = EVENT_GROUPS.map((g) => ({ label: g.label, options: g.types.map((t) => ({ value: t, label: EVENT_LABEL[t] })) }));

  const submit = () => {
    const r = eventBodyFrom(form, new Date().toISOString());
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success(`${eventLabel(r.body.type)} logged — clocks recomputed`);
        setForm({ ...emptyEventForm(new Date().toISOString()) });
        setAttach(false);
        typeRef.current?.focus();
      }
    });
  };

  const columns: Column<ClaimEvent>[] = [
    { key: 'at', header: 'When', width: '150px', render: (e) => <DateText value={e.at} time /> },
    {
      key: 'type',
      header: 'Event',
      render: (e) => (
        <div>
          <div className="strong">{eventLabel(e.type)}</div>
          <div className="xs muted">{eventGroup(e.type)?.label ?? ''}</div>
        </div>
      )
    },
    { key: 'summary', header: 'Summary', className: 'wrap', render: (e) => e.summary },
    {
      key: 'attr',
      header: 'Attributable to',
      render: (e) => (e.attributableTo ? <Badge tone={ATTRIBUTION_TONE[e.attributableTo]}>{ATTRIBUTABLE_LABEL[e.attributableTo]}</Badge> : <span className="muted">—</span>)
    },
    {
      key: 'evidence',
      header: 'Evidence',
      render: (e) => (
        <div className="stack-sm" style={{ gap: 2 }}>
          {e.evidenceIds.length === 0 && !e.documentId && <span className="muted">—</span>}
          {e.evidenceIds.map((eid) => {
            const ev = evidenceById.get(eid);
            return (
              <a key={eid} className="xs" href={api.evidenceFileUrl(eid)} target="_blank" rel="noreferrer" title={ev?.sha256}>
                {ev ? ev.filename : eid}
              </a>
            );
          })}
          {e.documentId && (
            <Link className="xs" to={`../documents/${e.documentId}`}>
              document
            </Link>
          )}
        </div>
      )
    },
    { key: 'recorded', header: 'Logged', render: (e) => <span className="xs muted"><DateText value={e.recordedAt} time /> · {e.createdBy}</span> }
  ];

  return (
    <div className="stack">
      <Card title="Days attributable">
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div className="counters">
            {days.length === 0 && <span className="small muted">No attributed events yet.</span>}
            {days.map((d) => (
              <div key={d.party} className={`counter ${d.party}`}>
                <div className="counter-label">{ATTRIBUTABLE_LABEL[d.party]}</div>
                <div className="counter-value">{d.days}</div>
                <div className="xs muted">
                  day{d.days === 1 ? '' : 's'} · {d.segments} gap{d.segments === 1 ? '' : 's'}
                </div>
              </div>
            ))}
          </div>
          <p className="xs muted" style={{ flex: 1, minWidth: 220, margin: 0 }}>
            {ATTRIBUTION_EXPLANATION} Counted up to {hiresEnded ? 'the end of hire' : 'now'}.
          </p>
        </div>
      </Card>

      <Card title="Chronology" flush actions={<span className="small muted">{events.length} event{events.length === 1 ? '' : 's'}</span>}>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          aria-label="Add event"
        >
          <div className="form-grid">
            <GroupedSelect<EventType>
              label="Event type"
              required
              value={form.type}
              onChange={(v) => setForm((f) => ({ ...f, type: v, attributableTo: f.attributableTo === '' || f.attributableTo === defaultAttribution(f.type) ? defaultAttribution(v) : f.attributableTo }))}
              groups={groups}
              placeholder="Choose…"
              error={errors.type}
              id="event-type"
            />
            <DateTimeInput label="When it happened" required value={form.at} onChange={(v) => setForm((f) => ({ ...f, at: v }))} error={errors.at} />
            <Select label="Attributable to" value={form.attributableTo} onChange={(v) => setForm((f) => ({ ...f, attributableTo: v }))} options={ATTRIBUTABLE_OPTIONS} placeholder="—" hint="Who the file waited on from this point" />
            <TextInput label="Summary" required value={form.summary} onChange={(v) => setForm((f) => ({ ...f, summary: v }))} error={errors.summary} placeholder="What happened, in one line (who said what, parts ETA, reference numbers)" className="span-2" />
            <div className="field span-2" style={{ justifyContent: 'flex-end' }}>
              <Checkbox label={`Attach evidence${form.evidenceIds.length ? ` (${form.evidenceIds.length})` : ''}`} checked={attach} onChange={setAttach} />
            </div>
            {attach && (
              <div className="span-4">
                <EvidencePicker evidence={view.evidence} value={form.evidenceIds} onChange={(ids) => setForm((f) => ({ ...f, evidenceIds: ids }))} />
              </div>
            )}
          </div>
          <div className="form-actions">
            <span className="hint">Enter submits. Events are append-only; a mistake is corrected with a note.</span>
            <Button type="submit" variant="primary" loading={post.isPending}>
              Add event
            </Button>
          </div>
          <ApiErrorNotice error={post.error} what="log the event" />
        </form>

        <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)' }}>
          <Select label="Group" value={filter.group ?? ''} onChange={(v) => setFilter((f) => ({ ...f, group: v }))} options={EVENT_GROUPS.map((g) => ({ value: g.id, label: g.label }))} placeholder="All groups" />
          <Select label="Attributable to" value={filter.attributableTo ?? ''} onChange={(v) => setFilter((f) => ({ ...f, attributableTo: v }))} options={ATTRIBUTABLE_OPTIONS} placeholder="Anyone" />
          <TextInput label="Search" type="search" value={filter.q ?? ''} onChange={(v) => setFilter((f) => ({ ...f, q: v }))} placeholder="Summary text" />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
              {dir === 'desc' ? 'Newest first' : 'Oldest first'}
            </Button>
          </div>
        </div>
        <ApiErrorNotice error={eventsQ.error} what="load the chronology" />
        <Table columns={columns} rows={rows} rowKey={(e) => e.id} caption="Chronology" empty={<EmptyState title={events.length ? 'No events match the filters' : 'No events yet'}>{events.length ? '' : 'Log services agreed, the NCAF, every insurer contact and every repair delay — this table is the period argument.'}</EmptyState>} />
      </Card>
    </div>
  );
}
