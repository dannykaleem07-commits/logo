import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ParsedVehicleCheck } from '@ccguk/domain';
import { parseVehicleCheckText } from '@ccguk/domain';
import { vehiclesApi, vk } from '../../api/vehiclesApi';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { TextArea } from '../../components/Form';
import { todayISO } from '../../lib/dates';
import { defaultParsedSelection, findMake, parsedRows, type ParsedCatalogueMatch, type ParsedField } from './vehiclePickerModel';

export interface PastedDetailsResult {
  parsed: ParsedVehicleCheck;
  selected: ParsedField[];
  match?: ParsedCatalogueMatch;
  pastedText: string;
}

/**
 * Paste what was copied from the free Total Car Check page (or a GOV.UK page): it is read here, in the browser, by the
 * domain parser — nothing is sent until "Use these details", and then only as unverified values on the vehicle. The
 * make/model are split into model + trim with GET /catalogue/match.
 */
export function PastedDetailsPanel({ registration, currentMake, onUse, disabled }: { registration: string; currentMake?: string; onUse: (r: PastedDetailsResult) => void; disabled?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedVehicleCheck | null>(null);
  const [selected, setSelected] = useState<Set<ParsedField>>(new Set());
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(false);

  const read = async () => {
    const p = parseVehicleCheckText(text, { expectedRegistration: registration || undefined, today: todayISO() });
    const sel = new Set(defaultParsedSelection(p));
    // a "make" the catalogue does not know (often page text) is shown but not ticked
    if (p.fields.make) {
      try {
        const makes = await qc.fetchQuery({ queryKey: vk.makes, queryFn: ({ signal }) => vehiclesApi.catalogueMakes(signal), staleTime: 60 * 60_000 });
        if (makes.length && !findMake(makes, p.fields.make)) {
          sel.delete('make');
          p.warnings = [...p.warnings, `"${p.fields.make}" is not a make in the catalogue — check it before using it (it is not ticked).`];
        }
      } catch {
        /* the catalogue is a convenience: the paste is shown as read */
      }
    }
    setParsed(p);
    setSelected(sel);
    setUsed(false);
  };

  /** Catalogue make/model for the pasted names (display names too); undefined when the catalogue does not know them. */
  const matchFor = async (p: ParsedVehicleCheck, sel: Set<ParsedField>): Promise<ParsedCatalogueMatch | undefined> => {
    const make = sel.has('make') ? p.fields.make : currentMake;
    if (!make) return undefined;
    const model = sel.has('model') ? p.fields.model : undefined;
    try {
      const m = await vehiclesApi.catalogueMatch(make, model);
      const out: ParsedCatalogueMatch = {};
      if (m.makeSlug) out.makeSlug = m.makeSlug;
      if (m.modelSlug) out.modelSlug = m.modelSlug;
      if (m.variantRemainder) out.variantRemainder = m.variantRemainder;
      if (m.makeSlug) {
        const makes = await qc.fetchQuery({ queryKey: vk.makes, queryFn: ({ signal }) => vehiclesApi.catalogueMakes(signal), staleTime: 60 * 60_000 });
        const name = makes.find((x) => x.slug === m.makeSlug)?.make;
        if (name) out.makeName = name;
      }
      if (m.makeSlug && m.modelSlug) {
        const detail = await qc.fetchQuery({ queryKey: vk.model(m.makeSlug, m.modelSlug), queryFn: ({ signal }) => vehiclesApi.catalogueModel(m.makeSlug!, m.modelSlug!, signal), staleTime: 60 * 60_000 });
        if (detail?.name) out.modelName = detail.name;
      }
      return out;
    } catch {
      return undefined; // the catalogue is a convenience: the pasted names are kept as printed
    }
  };

  const use = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const match = await matchFor(parsed, selected);
      onUse({ parsed, selected: [...selected], ...(match ? { match } : {}), pastedText: text });
      setUsed(true);
    } finally {
      setBusy(false);
    }
  };

  const rows = parsed ? parsedRows(parsed) : [];
  const toggle = (f: ParsedField, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(f);
      else n.delete(f);
      return n;
    });

  return (
    <div className="stack-sm">
      <TextArea
        label="Paste the details you copied"
        value={text}
        onChange={(t) => {
          setText(t);
          setUsed(false);
        }}
        rows={6}
        disabled={disabled}
        placeholder={'Make\tFORD\nModel\tFIESTA ZETEC\nColour\tBLUE\n…'}
        hint="On the results page select the vehicle details, copy them (Ctrl+C) and paste here (Ctrl+V). Extra page text is ignored. Nothing is saved until you use the details and save the form."
      />
      <div className="row">
        <Button onClick={() => void read()} disabled={disabled || !text.trim()}>
          Read pasted details
        </Button>
        {parsed && <span className="xs muted">{rows.length ? `${rows.length} field${rows.length === 1 ? '' : 's'} found` : 'No vehicle details found in the text'}</span>}
      </div>
      {parsed && parsed.warnings.length > 0 && (
        <div className="notice notice-warn small" role="alert">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {parsed.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {parsed && rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Details read from the pasted text</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: 40 }}>
                  Use
                </th>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">Read from</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.field}>
                  <td>
                    {r.applicable ? (
                      <input type="checkbox" aria-label={`Use ${r.label}`} checked={selected.has(r.field)} disabled={disabled} onChange={(e) => toggle(r.field, e.target.checked)} />
                    ) : (
                      <span className="xs muted" title="Shown for checking only">
                        —
                      </span>
                    )}
                  </td>
                  <td>{r.label}</td>
                  <td className="strong">{r.value}</td>
                  <td className="xs muted wrap">{r.raw ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parsed && parsed.unmatchedLines.length > 0 && (
        <details>
          <summary className="xs" style={{ cursor: 'pointer' }}>
            Lines not used ({parsed.unmatchedLines.length})
          </summary>
          <pre className="xs" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', margin: '6px 0 0' }}>
            {parsed.unmatchedLines.join('\n')}
          </pre>
        </details>
      )}
      {parsed && rows.some((r) => r.applicable) && (
        <div className="row">
          <Button variant="primary" onClick={use} loading={busy} disabled={disabled || selected.size === 0}>
            Use these details
          </Button>
          {used && <Badge tone="amber">copied in · unverified</Badge>}
        </div>
      )}
    </div>
  );
}
