import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HeadOfLoss, LedgerKind } from '@ccguk/domain';
import { api } from '../../../api/client';
import { useLedger, usePostLedger } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Money } from '../../../components/Money';
import { DateText } from '../../../components/DateText';
import { Checkbox, DateInput, MoneyInput, Select, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { todayISO } from '../../../lib/dates';
import { partyName, pickList, type ClaimView } from '../claimFile';
import { EvidencePicker } from '../components/EvidencePicker';
import { activeEntries, APPEND_ONLY_NOTE, correctsText, emptyLedgerForm, filterRows, HEAD_OPTIONS, headLabel, KIND_OPTIONS, kindLabel, kindSign, ledgerBodyFrom, positionByHead, runningTotals, type LedgerFilter, type LedgerRow } from '../lib/ledger';
import { formatGBP } from '@ccguk/domain';

const KIND_TONE: Record<LedgerKind, 'navy' | 'blue' | 'amber' | 'red' | 'green' | 'grey'> = {
  claimed: 'navy',
  invoiced: 'blue',
  offered: 'amber',
  reduced: 'red',
  paid: 'green',
  interim_paid: 'green',
  written_off: 'grey',
  adjustment: 'grey'
};

/** Append-only ledger: running totals, filters and an add-entry form. No edit or delete control exists here by design. */
export function LedgerTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const ledgerQ = useLedger(claimId);
  const entries = pickList(ledgerQ.data, view.ledger);
  const today = todayISO();
  const [filter, setFilter] = useState<LedgerFilter>({});
  const [form, setForm] = useState(() => emptyLedgerForm(today));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const post = usePostLedger(claimId);
  const toast = useToast();

  const position = useMemo(() => positionByHead(entries), [entries]);
  const rows = useMemo(() => filterRows(runningTotals(entries), filter), [entries, filter]);
  const active = useMemo(() => activeEntries(entries), [entries]);
  const parties = [view.claimant, view.driver, view.atFaultInsurer, ...view.thirdParties].filter((p): p is NonNullable<typeof p> => Boolean(p));

  const submit = () => {
    const r = ledgerBodyFrom(form, today);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success(`${kindLabel(r.body.kind)} · ${headLabel(r.body.head)} · ${formatGBP(r.body.amountPence)} added`);
        setForm(emptyLedgerForm(today));
        setMore(false);
      }
    });
  };

  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateText value={r.entry.date} /> },
    { key: 'head', header: 'Head', render: (r) => headLabel(r.entry.head) },
    { key: 'kind', header: 'Kind', render: (r) => <Badge tone={KIND_TONE[r.entry.kind]}>{r.entry.kind.replace(/_/g, ' ')}</Badge> },
    {
      key: 'desc',
      header: 'Description',
      className: 'wrap',
      render: (r) => (
        <div>
          {r.entry.description}
          <div className="xs muted">
            {r.entry.reference ? `ref ${r.entry.reference}` : ''}
            {r.entry.counterpartyId ? ` · ${partyName(view, r.entry.counterpartyId) ?? r.entry.counterpartyId}` : ''}
            {r.correction ? ` · ${correctsText(r.entry, entries)}` : ''}
            {r.superseded ? ' · superseded' : ''}
          </div>
        </div>
      )
    },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => <Money pence={kindSign(r.entry.kind) === -1 ? -r.entry.amountPence : r.entry.amountPence} /> },
    { key: 'vat', header: 'VAT', numeric: true, render: (r) => <Money pence={r.entry.vatPence} blankZero /> },
    { key: 'running', header: 'Outstanding after', numeric: true, render: (r) => (r.superseded ? <span className="muted">—</span> : <Money pence={r.runningPence} />) },
    {
      key: 'source',
      header: 'Source',
      render: (r) => (
        <span className="xs">
          {r.entry.sourceDocumentId && (
            <Link to={`../documents/${r.entry.sourceDocumentId}`}>document</Link>
          )}
          {r.entry.sourceDocumentId && r.entry.sourceEvidenceId ? ' · ' : ''}
          {r.entry.sourceEvidenceId && (
            <a href={api.evidenceFileUrl(r.entry.sourceEvidenceId)} target="_blank" rel="noreferrer">
              evidence
            </a>
          )}
          {!r.entry.sourceDocumentId && !r.entry.sourceEvidenceId && <span className="muted">—</span>}
        </span>
      )
    },
    { key: 'by', header: 'By', render: (r) => <span className="xs muted">{r.entry.createdBy}</span> }
  ];

  return (
    <div className="stack">
      <div className="grid-4">
        <div className="stat">
          <span className="stat-label">Claimed</span>
          <span className="stat-value">{formatGBP(position.totals.claimedPence, { showPence: false })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Offered</span>
          <span className="stat-value">{formatGBP(position.totals.offeredPence, { showPence: false })}</span>
          <span className="stat-sub">reduced {formatGBP(position.totals.reducedPence, { showPence: false })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Paid</span>
          <span className="stat-value green">{formatGBP(position.totals.paidPence, { showPence: false })}</span>
          <span className="stat-sub">written off {formatGBP(position.totals.writtenOffPence, { showPence: false })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Outstanding</span>
          <span className={`stat-value ${position.totals.outstandingPence > 0 ? 'amber' : ''}`}>{formatGBP(position.totals.outstandingPence, { showPence: false })}</span>
        </div>
      </div>

      <Card title="Ledger" flush actions={<span className="small muted">{active.length} live entr{active.length === 1 ? 'y' : 'ies'}</span>}>
        <form
          className="inline-form"
          aria-label="Add ledger entry"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="form-grid">
            <Select<HeadOfLoss> label="Head of loss" required value={form.head} onChange={(v) => setForm((f) => ({ ...f, head: v }))} options={HEAD_OPTIONS} placeholder="Choose…" error={errors.head} />
            <Select<LedgerKind> label="Kind" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={KIND_OPTIONS} placeholder="Choose…" error={errors.kind} />
            <MoneyInput label="Amount (£, ex VAT)" required value={form.amountPence} onChange={(v) => setForm((f) => ({ ...f, amountPence: v }))} error={errors.amountPence} allowNegative={form.kind === 'adjustment'} hint={form.kind === 'adjustment' ? 'Signed: negative reduces the balance' : 'Positive; the kind sets the direction'} />
            <DateInput label="Date" required value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} error={errors.date} max={today} />
            <TextInput label="Description" required value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} error={errors.description} className="span-2" placeholder="e.g. BACS remittance from esure, ref 12345 — hire invoice INV-0042" />
            <TextInput label="Reference" value={form.reference} onChange={(v) => setForm((f) => ({ ...f, reference: v }))} placeholder="Invoice, remittance or insurer ref" />
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Checkbox label="More fields (VAT, counterparty, correction, source)" checked={more} onChange={setMore} />
            </div>
            {more && (
              <>
                <MoneyInput label="VAT (£)" value={form.vatPence} onChange={(v) => setForm((f) => ({ ...f, vatPence: v }))} error={errors.vatPence} />
                <Select label="Counterparty" value={form.counterpartyId} onChange={(v) => setForm((f) => ({ ...f, counterpartyId: v }))} options={parties.map((p) => ({ value: p.id, label: p.name }))} placeholder="—" />
                <Select
                  label="Corrects entry (supersedes)"
                  value={form.supersedesId}
                  onChange={(v) => setForm((f) => ({ ...f, supersedesId: v }))}
                  options={active.map((e) => ({ value: e.id, label: `${e.date} · ${headLabel(e.head)} · ${e.kind} · ${formatGBP(e.amountPence)}` }))}
                  placeholder="— (not a correction)"
                  hint="The old entry stays on file, marked superseded"
                />
                <Select label="Source document" value={form.sourceDocumentId} onChange={(v) => setForm((f) => ({ ...f, sourceDocumentId: v }))} options={view.documents.map((d) => ({ value: d.id, label: `${d.title} (${d.status})` }))} placeholder="—" />
                <div className="span-4">
                  <EvidencePicker label="Source evidence (remittance, invoice…)" single evidence={view.evidence} value={form.sourceEvidenceId ? [form.sourceEvidenceId] : []} onChange={(ids) => setForm((f) => ({ ...f, sourceEvidenceId: ids[0] ?? '' }))} />
                </div>
              </>
            )}
          </div>
          <div className="form-actions">
            <span className="hint">Pounds in the box, pence over the wire. {APPEND_ONLY_NOTE}</span>
            <Button type="submit" variant="primary" loading={post.isPending}>
              Add entry
            </Button>
          </div>
          <ApiErrorNotice error={post.error} what="add the ledger entry" />
        </form>

        <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)' }}>
          <Select<HeadOfLoss> label="Head" value={filter.head ?? ''} onChange={(v) => setFilter((f) => ({ ...f, head: v }))} options={HEAD_OPTIONS} placeholder="All heads" />
          <Select<LedgerKind> label="Kind" value={filter.kind ?? ''} onChange={(v) => setFilter((f) => ({ ...f, kind: v }))} options={KIND_OPTIONS} placeholder="All kinds" />
          <TextInput label="Search" type="search" value={filter.q ?? ''} onChange={(v) => setFilter((f) => ({ ...f, q: v }))} placeholder="Description or reference" />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label="Show superseded" checked={Boolean(filter.showSuperseded)} onChange={(v) => setFilter((f) => ({ ...f, showSuperseded: v }))} />
          </div>
        </div>
        <ApiErrorNotice error={ledgerQ.error} what="load the ledger" />
        <Table columns={columns} rows={rows} rowKey={(r) => r.entry.id} caption="Ledger entries" empty={<EmptyState title={entries.length ? 'No entries match the filters' : 'Nothing on the ledger yet'}>{entries.length ? '' : 'Add the first claimed amount per head; invoices and letters render from these figures and never retype them.'}</EmptyState>} />
        <div className="card-footer small muted">Corrections are new entries. Superseded rows are kept, shown struck through, and excluded from every total.</div>
      </Card>
    </div>
  );
}
