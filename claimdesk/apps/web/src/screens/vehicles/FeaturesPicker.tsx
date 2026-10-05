import { useState } from 'react';
import type { FeatureVocabulary } from '../../api/vehiclesApi';
import { Badge } from '../../components/Badge';
import { Checkbox, TextInput } from '../../components/Form';
import { Tabs } from '../../components/Tabs';
import { filterVocabulary, toggleId, type FeatureTab } from './vehiclePickerModel';

/**
 * Features and extras (§D.3): "Standard on this vehicle" and "Added extras" tabs, category groups of tick boxes and a
 * search box. Accessibility items (wheelchair access, hand controls …) matter for like-for-like hire.
 */
export function FeaturesPicker({
  vocabulary,
  features,
  extras,
  onChange,
  disabled,
  loading,
  trimStandard
}: {
  vocabulary: FeatureVocabulary | undefined;
  features: string[];
  extras: string[];
  onChange: (next: { features: string[]; extras: string[] }) => void;
  disabled?: boolean;
  loading?: boolean;
  /**
   * The chosen catalogue trim's standard equipment: undefined when no trim is chosen, [] when the catalogue lists
   * none for it (then nothing is pre-ticked and the hint says so).
   */
  trimStandard?: readonly string[];
}) {
  const [tab, setTab] = useState<FeatureTab>('standard');
  const [query, setQuery] = useState('');
  const list = tab === 'standard' ? features : extras;
  const categories = filterVocabulary(vocabulary, query);
  const set = (id: string, on: boolean) => {
    if (tab === 'standard') onChange({ features: toggleId(features, id, on), extras });
    else onChange({ features, extras: toggleId(extras, id, on) });
  };

  return (
    <div className="stack-sm">
      <Tabs
        ariaLabel="Features and extras"
        value={tab}
        onChange={(id) => setTab(id as FeatureTab)}
        items={[
          { id: 'standard', label: 'Standard on this vehicle', badge: features.length ? <Badge tone="blue">{features.length}</Badge> : undefined },
          { id: 'extras', label: 'Added extras', badge: extras.length ? <Badge tone="blue">{extras.length}</Badge> : undefined }
        ]}
      />
      <p className="xs muted" style={{ margin: 0 }}>
        {tab === 'standard' ? standardHint(trimStandard) : 'Options and after-market fits: tow bar, roof bars, hand controls, tracker …'}
      </p>
      <TextInput type="search" label="Search features" value={query} onChange={setQuery} placeholder="e.g. heated seats, tow bar, wheelchair" disabled={disabled} />
      {loading && !vocabulary && <p className="xs muted">Loading the features list…</p>}
      {!loading && !vocabulary && <p className="xs muted">The features list is not available (the API may be offline).</p>}
      {vocabulary && categories.length === 0 && <p className="xs muted">No feature matches “{query}”.</p>}
      {categories.map((c) => {
        const ticked = c.items.filter((i) => list.includes(i.id)).length;
        return (
          <details key={c.id} open={query.trim() ? true : undefined}>
            <summary className="small" style={{ cursor: 'pointer', padding: '4px 0' }}>
              {c.label} {ticked > 0 && <Badge tone="blue">{ticked}</Badge>}
            </summary>
            <div className="check-grid" style={{ padding: '6px 0 10px' }}>
              {c.items.map((i) => (
                <Checkbox key={i.id} label={i.label} checked={list.includes(i.id)} onChange={(on) => set(i.id, on)} disabled={disabled} />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** Promise pre-ticking only when the chosen trim actually lists standard equipment in the catalogue. */
export function standardHint(trimStandard: readonly string[] | undefined): string {
  if (trimStandard === undefined) return 'Equipment the vehicle came with. Tick what this vehicle has.';
  if (trimStandard.length === 0) return 'No standard equipment is listed for this trim in the catalogue — tick what the vehicle has.';
  return 'Equipment the vehicle came with: the trim’s usual standard equipment is ticked — untick anything this vehicle lacks.';
}
