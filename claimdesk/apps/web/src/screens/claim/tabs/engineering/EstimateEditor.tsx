import { useEffect, useMemo, useState } from 'react';
import type { Estimate, EstimateLine, EstimateLineKind } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { useEstimate, useImportEstimate, usePostEstimate } from '../../../../api/hooks';
import { Card } from '../../../../components/Card';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { Modal } from '../../../../components/Modal';
import { MoneyInput, Select, TextArea, TextInput } from '../../../../components/Form';
import { EmptyState } from '../../../../components/EmptyState';
import { Loading } from '../../../../components/Spinner';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import { penceToPoundsText, poundsTextToPence } from '../../../../lib/money';
import type { ClaimView } from '../../claimFile';
import { useLabourSuggestion } from '../../claimApi';
import { EvidencePicker } from '../../components/EvidencePicker';
import { basisFormFrom, estimateBodyFrom, LINE_KIND_OPTIONS, LINE_SOURCE_LABEL, newLine, numOrUndefined, OPERATION_OPTIONS, PAINT_METHOD_OPTIONS, PART_SOURCE_OPTIONS, unconfirmedLines, type EstimateBasisForm } from '../../lib/engineering';

/** Estimate lines table + basis + totals from the API. The engineer confirms every line (BLUEPRINT §4.5, §4.8). */
export function EstimateEditor({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const estimateQ = useEstimate(claimId);
  const estimate: Estimate | null = estimateQ.data ?? view.estimate ?? null;
  const [basis, setBasis] = useState<EstimateBasisForm>(() => basisFormFrom(estimate));
  const [lines, setLines] = useState<EstimateLine[]>(() => estimate?.lines ?? []);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const save = usePostEstimate(claimId);
  const toast = useToast();

  // Re-sync from the API whenever a fresh estimate arrives and there are no unsaved edits.
  const stamp = estimate ? `${estimate.id}:${estimate.lines.length}:${estimate.totals?.grossPence}` : 'none';
  useEffect(() => {
    if (dirty) return;
    setBasis(basisFormFrom(estimate));
    setLines(estimate?.lines ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const update = (id: string, patch: Partial<EstimateLine>) => {
    setDirty(true);
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const addLine = (kind: EstimateLineKind) => {
    setDirty(true);
    setLines((ls) => [...ls, newLine(kind)]);
  };
  const removeLine = (id: string) => {
    setDirty(true);
    setLines((ls) => ls.filter((l) => l.id !== id));
  };
  const setB = <K extends keyof EstimateBasisForm>(k: K, v: EstimateBasisForm[K]) => {
    setDirty(true);
    setBasis((b) => ({ ...b, [k]: v }));
  };

  const submit = () => {
    const r = estimateBodyFrom(estimate, view.vehicle.id, basis, lines);
    if (!r.ok) {
      setErrors(r.errors);
      toast.error('Fix the highlighted lines before saving');
      return;
    }
    setErrors({});
    save.mutate(r.body, {
      onSuccess: () => {
        setDirty(false);
        toast.success('Estimate saved — totals recomputed by the API');
      }
    });
  };

  const totals = estimate?.totals;
  const unconfirmed = unconfirmedLines(lines);
  const suggestLine = lines.find((l) => l.id === suggestFor);
  const suggestion = useLabourSuggestion(suggestLine ? { make: view.vehicle.make, model: view.vehicle.model, panel: suggestLine.panel, operation: suggestLine.operation } : null);
  const reconciled = estimate?.importedTotalPence !== undefined && totals ? Math.abs(estimate.importedTotalPence - totals.netPence) <= 100 : undefined;

  return (
    <div className="stack">
      <ApiErrorNotice error={estimateQ.error} what="load the estimate" />
      <div className="grid-2">
        <Card title="Basis">
          <div className="form-grid">
            <MoneyInput label="Labour rate (£/hour)" required value={basis.labourRatePence} onChange={(v) => setB('labourRatePence', v)} error={errors.labourRatePence} />
            <MoneyInput label="Paint rate (£/hour)" required value={basis.paintRatePence} onChange={(v) => setB('paintRatePence', v)} error={errors.paintRatePence} />
            <Select label="Paint materials method" required value={basis.paintMaterialsMethod} onChange={(v) => setB('paintMaterialsMethod', v)} options={PAINT_METHOD_OPTIONS} error={errors.paintMaterialsMethod} hint="The basis is stated on the report (§4.5)" />
            {basis.paintMaterialsMethod === 'per_hour' && <MoneyInput label="Materials (£ per paint hour)" value={basis.paintMaterialsPerHourPence} onChange={(v) => setB('paintMaterialsPerHourPence', v)} error={errors.paintMaterialsPerHourPence} />}
            <TextInput label="VAT %" value={basis.vatRatePct} onChange={(v) => setB('vatRatePct', v)} inputMode="decimal" error={errors.vatRatePct} />
          </div>
          {estimate?.importedFromEvidenceId && (
            <p className="xs muted" style={{ margin: '10px 0 0' }}>
              Imported from evidence {estimate.importedFromEvidenceId}
              {estimate.importedTotalPence !== undefined && (
                <>
                  {' '}
                  · imported total {formatGBP(estimate.importedTotalPence)} · {reconciled ? <Badge tone="green">reconciles</Badge> : <Badge tone="amber">does not reconcile with the lines</Badge>}
                </>
              )}
            </p>
          )}
        </Card>
        <Card title={<span className="row">Totals {dirty && <Badge tone="amber">unsaved edits — save to recompute</Badge>}</span>}>
          {estimateQ.isLoading && !estimate ? (
            <Loading />
          ) : !totals ? (
            <EmptyState title="No totals yet">Totals are computed by the API when the estimate is saved.</EmptyState>
          ) : (
            <div className="totals">
              <span>Labour ({totals.labourHours} h)</span>
              <span className="right">{formatGBP(totals.labourPence)}</span>
              <span>Parts</span>
              <span className="right">{formatGBP(totals.partsPence)}</span>
              <span>Paint labour ({totals.paintHours} h)</span>
              <span className="right">{formatGBP(totals.paintLabourPence)}</span>
              <span>Paint materials</span>
              <span className="right">{formatGBP(totals.paintMaterialsPence)}</span>
              <span>Other (ADAS, diagnostic, sundry, specialist)</span>
              <span className="right">{formatGBP(totals.otherPence)}</span>
              <span className="muted">Pre-existing damage excluded</span>
              <span className="right muted">{formatGBP(totals.preExistingExcludedPence)}</span>
              <span>Net</span>
              <span className="right">{formatGBP(totals.netPence)}</span>
              <span>VAT</span>
              <span className="right">{formatGBP(totals.vatPence)}</span>
              <span className="total-line">Gross</span>
              <span className="right total-line">{formatGBP(totals.grossPence)}</span>
            </div>
          )}
          <p className="xs muted" style={{ margin: '10px 0 0' }}>
            Pre-existing damage is separated and never claimed. {unconfirmed > 0 ? `${unconfirmed} line${unconfirmed === 1 ? '' : 's'} await the engineer’s confirmation.` : lines.length ? 'Every line is confirmed by the engineer.' : ''}
          </p>
        </Card>
      </div>

      <Card
        title={<span className="row">Lines <Badge tone="grey">{lines.length}</Badge>{unconfirmed > 0 && <Badge tone="amber">{unconfirmed} unconfirmed</Badge>}</span>}
        flush
        actions={
          <>
            <Select<EstimateLineKind> label="" value="" onChange={(v) => v && addLine(v)} options={LINE_KIND_OPTIONS} placeholder="+ Add line…" aria-label="Add line of kind" />
            <Button size="sm" onClick={() => setImporting(true)}>
              Import from text
            </Button>
            <Button size="sm" variant="primary" loading={save.isPending} onClick={submit} disabled={!dirty && Boolean(estimate)}>
              Save estimate
            </Button>
          </>
        }
      >
        {suggestLine && (
          <div className="notice notice-info small" style={{ margin: 12 }}>
            <strong>Labour library</strong> for {suggestLine.operation} {suggestLine.panel ? `· ${suggestLine.panel}` : ''}:{' '}
            {suggestion.isLoading ? (
              'looking up medians…'
            ) : suggestion.data && suggestion.data.suggestedHours !== null ? (
              <>
                median {suggestion.data.suggestedHours} h from {suggestion.data.n} approved CCGUK estimate{suggestion.data.n === 1 ? '' : 's'}. {suggestion.data.note}{' '}
                <Button
                  size="sm"
                  onClick={() => {
                    update(suggestLine.id, { hours: suggestion.data!.suggestedHours ?? undefined, source: 'library' });
                    setSuggestFor(null);
                  }}
                >
                  Apply
                </Button>
              </>
            ) : (
              <>No library data yet — the library is built from CCGUK’s own approved estimates (medians by model, panel and operation; never copied third-party times). TODO wire when @ccguk/api lands.</>
            )}{' '}
            <Button size="sm" variant="ghost" onClick={() => setSuggestFor(null)}>
              Dismiss
            </Button>
          </div>
        )}
        {Object.entries(errors)
          .filter(([k]) => k.startsWith('line.'))
          .map(([k, v]) => (
            <div key={k} className="notice notice-danger xs" style={{ margin: '0 12px 8px' }}>
              {v}
            </div>
          ))}
        {lines.length === 0 ? (
          <EmptyState title="No lines">Add lines by kind, or import a bodyshop / Audatex estimate as text and let the parser extract operation, part, hours and prices (then confirm each line).</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table estimate-table">
              <caption className="sr-only">Estimate lines</caption>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Operation</th>
                  <th>Panel</th>
                  <th>Description</th>
                  <th>Part no.</th>
                  <th>Source</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit £</th>
                  <th className="num">Hours</th>
                  <th className="num">Rate £</th>
                  <th className="num">Materials £</th>
                  <th>Pre-existing</th>
                  <th>Confirmed</th>
                  <th>Origin</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className={[l.preExisting ? 'pre-existing' : '', l.confirmedByEngineer ? '' : 'unconfirmed'].join(' ').trim()}>
                    <td>
                      <select className="select" value={l.kind} onChange={(e) => update(l.id, { kind: e.target.value as EstimateLineKind })} aria-label="Kind">
                        {LINE_KIND_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="select" value={OPERATION_OPTIONS.some((o) => o.value === l.operation) ? l.operation : 'Other'} onChange={(e) => update(l.id, { operation: e.target.value })} aria-label="Operation">
                        {OPERATION_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="input" value={l.panel ?? ''} onChange={(e) => update(l.id, { panel: e.target.value || undefined })} placeholder="e.g. NSF wing" aria-label="Panel" />
                    </td>
                    <td>
                      <input className="input desc" value={l.description} onChange={(e) => update(l.id, { description: e.target.value })} placeholder="Description" aria-label="Description" />
                    </td>
                    <td>
                      <input className="input" value={l.partNumber ?? ''} onChange={(e) => update(l.id, { partNumber: e.target.value || undefined })} disabled={l.kind !== 'part'} aria-label="Part number" style={{ width: 110 }} />
                    </td>
                    <td>
                      <select className="select" value={l.partSource ?? ''} onChange={(e) => update(l.id, { partSource: (e.target.value || undefined) as EstimateLine['partSource'] })} disabled={l.kind !== 'part'} aria-label="Part source">
                        <option value="">—</option>
                        {PART_SOURCE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input className="input num" type="number" min={0} step="1" value={l.quantity} onChange={(e) => update(l.id, { quantity: numOrUndefined(e.target.value) ?? 0 })} aria-label="Quantity" />
                    </td>
                    <td className="num">
                      <CellMoney value={l.unitPence} onChange={(v) => update(l.id, { unitPence: v })} disabled={l.kind === 'labour' || l.kind === 'paint'} label="Unit price" />
                    </td>
                    <td className="num">
                      <input className="input num" type="number" min={0} step="0.1" value={l.hours ?? ''} onChange={(e) => update(l.id, { hours: numOrUndefined(e.target.value) })} aria-label="Hours" />
                    </td>
                    <td className="num">
                      <CellMoney value={l.ratePence} onChange={(v) => update(l.id, { ratePence: v })} label="Rate per hour" placeholder={l.kind === 'paint' ? penceToPoundsText(basis.paintRatePence) : penceToPoundsText(basis.labourRatePence)} />
                    </td>
                    <td className="num">
                      <CellMoney value={l.materialsPence} onChange={(v) => update(l.id, { materialsPence: v })} label="Materials" />
                    </td>
                    <td>
                      <input type="checkbox" checked={Boolean(l.preExisting)} onChange={(e) => update(l.id, { preExisting: e.target.checked })} aria-label="Pre-existing damage (excluded)" />
                    </td>
                    <td>
                      <input type="checkbox" checked={l.confirmedByEngineer} onChange={(e) => update(l.id, { confirmedByEngineer: e.target.checked })} aria-label="Confirmed by engineer" />
                    </td>
                    <td>
                      <span className="xs muted">{LINE_SOURCE_LABEL[l.source]}</span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        {(l.kind === 'labour' || l.kind === 'paint') && (
                          <Button size="sm" variant="ghost" onClick={() => setSuggestFor(l.id)} title="Suggest hours from the labour library">
                            Suggest
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => removeLine(l.id)} aria-label="Remove line">
                          ✕
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ApiErrorNotice error={save.error} what="save the estimate" />
        <div className="card-footer xs muted">Vision or import suggestions are suggestions only: the engineer confirms every line. Lines marked pre-existing are totalled separately and never claimed.</div>
      </Card>
      {importing && <ImportDialog view={view} onClose={() => setImporting(false)} onImported={() => setDirty(false)} />}
    </div>
  );
}

/** Pounds in the cell, pence in the line. */
function CellMoney({ value, onChange, disabled, label, placeholder }: { value: number | undefined; onChange: (pence: number | undefined) => void; disabled?: boolean; label: string; placeholder?: string }) {
  const [text, setText] = useState(penceToPoundsText(value));
  useEffect(() => {
    if ((poundsTextToPence(text) ?? undefined) !== value) setText(penceToPoundsText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="input money"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        const p = poundsTextToPence(e.target.value);
        if (e.target.value.trim() === '') onChange(undefined);
        else if (p !== null && p >= 0) onChange(p);
      }}
      onBlur={() => {
        const p = poundsTextToPence(text);
        if (p !== null) setText(penceToPoundsText(p));
      }}
    />
  );
}

function ImportDialog({ view, onClose, onImported }: { view: ClaimView; onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const imp = useImportEstimate(view.claim.id);
  const toast = useToast();
  const submit = () => {
    if (!text.trim() && !evidenceId) return;
    imp.mutate(
      { text: text.trim() || undefined, evidenceId: evidenceId || undefined },
      {
        onSuccess: (e) => {
          onImported();
          toast.success(`${e.lines.length} line${e.lines.length === 1 ? '' : 's'} imported — confirm each one`);
          onClose();
        }
      }
    );
  };
  const useful = useMemo(() => view.evidence.filter((e) => e.kind === 'estimate' || e.kind === 'pdf' || e.kind === 'document'), [view.evidence]);
  return (
    <Modal
      open
      size="lg"
      title="Import estimate from text"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={imp.isPending} onClick={submit} disabled={!text.trim() && !evidenceId}>
            Import
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">Paste the lines of a bodyshop or Audatex estimate (one line each). The parser extracts operation, panel, part number, price, hours and materials; every imported line is unconfirmed until the engineer ticks it, and the imported total is reconciled against the lines.</p>
        <TextArea label="Estimate text" value={text} onChange={setText} rows={10} placeholder={'REPLACE FRONT BUMPER 5G0807221 1 245.00\nREFINISH FRONT BUMPER 2.5\nSTRIP/REFIT HEADLAMP 0.6'} autoFocus />
        <EvidencePicker label="Or pick the estimate on file (PDF import)" single evidence={useful} value={evidenceId ? [evidenceId] : []} onChange={(ids) => setEvidenceId(ids[0] ?? '')} />
        <ApiErrorNotice error={imp.error} what="import the estimate" />
      </div>
    </Modal>
  );
}
