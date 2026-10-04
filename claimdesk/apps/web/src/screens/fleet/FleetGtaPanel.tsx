import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ISODate } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { useGtaRates } from '../../api/hooks';
import { useGtaSuggest } from '../../api/vehiclesApi';
import { Badge, VerificationBadge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { MoneyInput, Select, TextInput } from '../../components/Form';
import type { VehiclePickerValue } from '../vehicles/vehiclePicker';
import {
  applySuggestion,
  benchmarkLine,
  editGroup,
  editGroupMode,
  editRate,
  effectiveGroupMode,
  GTA_PANEL_CAVEAT,
  groupOptions,
  groupsWithRates,
  OTHER_GROUP,
  panelView,
  resetToSuggestion,
  suggestQuery,
  type GtaPanelState
} from './gtaPanel';

/** Wait for typing to settle before asking for a suggestion. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * GTA group and daily rate for a fleet unit (§F.1). When make and model are set, GET /gta/suggest pre-fills both from
 * the benchmark; each stops following the suggestion once the user edits it. GTA rates are an industry benchmark only.
 */
export function FleetGtaPanel({
  vehicle,
  state,
  onChange,
  date,
  errors = {},
  disabled
}: {
  vehicle: VehiclePickerValue;
  state: GtaPanelState;
  onChange: (next: GtaPanelState) => void;
  date: ISODate;
  errors?: { gtaGroup?: string; dailyRatePence?: string };
  disabled?: boolean;
}) {
  const ratesQ = useGtaRates(date);
  const rates = ratesQ.data;
  const groups = useMemo(() => groupsWithRates(rates), [rates]);
  const query = suggestQuery(vehicle, date);
  const debounced = useDebounced(query ? JSON.stringify(query) : '', 400);
  const suggest = useGtaSuggest(debounced ? (JSON.parse(debounced) as typeof query) : null);
  const suggestion = query ? suggest.data : undefined;

  // A new suggestion fills the fields the user has not edited.
  useEffect(() => {
    if (!suggestion) return;
    if (state.suggestion === suggestion) return;
    onChange(applySuggestion(state, suggestion, groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  const view = panelView(state, rates, date);
  // "No rate" only once the rate table is loaded (or the suggestion itself found none for that group).
  const showNoRate = Boolean(view.noRate) && (rates !== undefined || (state.suggestion?.group === state.group && !state.suggestion?.rate));
  const mode = effectiveGroupMode(state, groups);
  const benchmark = benchmarkLine(view.rate, (p) => formatGBP(p));

  return (
    <fieldset className="fieldset">
      <legend>
        GTA group and daily rate <Badge tone="grey">industry benchmark</Badge>
      </legend>
      <div className="stack-sm">
        <div className="small">
          {!query ? (
            <span className="muted">Choose the make and model above to get a suggested GTA group and the benchmark daily rate.</span>
          ) : suggest.isFetching && !suggestion ? (
            <span className="muted">Finding a suggested GTA group…</span>
          ) : suggest.error ? (
            <span className="muted">No suggestion available ({(suggest.error as Error).message}). Choose the group and rate.</span>
          ) : view.suggestionText ? (
            <span>{view.suggestionText}</span>
          ) : null}
        </div>
        {suggestion?.reason && <p className="xs muted" style={{ margin: 0 }}>{suggestion.reason}</p>}
        {benchmark && view.rate && (
          <div className="small row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span>{benchmark}</span>
            <VerificationBadge verification={view.rate.verification} />
          </div>
        )}
        <div className="form-grid">
          {mode === 'select' ? (
            <Select
              label="GTA group"
              required
              value={state.group && groups.includes(state.group) ? state.group : ''}
              placeholder={ratesQ.isLoading ? 'Loading groups…' : 'Choose…'}
              options={groupOptions(rates)}
              onChange={(v) => onChange(v === OTHER_GROUP ? editGroupMode(editGroup(state, OTHER_GROUP, rates, date), 'other') : editGroup(state, v, rates, date))}
              error={errors.gtaGroup}
              hint={view.groupPrefilled ? 'Pre-filled from the suggestion — change it if needed.' : 'Groups with a benchmark rate loaded; Other… for any other group.'}
              disabled={disabled}
            />
          ) : (
            <TextInput
              label="GTA group"
              required
              value={state.group}
              placeholder="S1, M, M1, CP1…"
              autoCapitalize="characters"
              onChange={(t) => onChange(editGroup(state, t, rates, date))}
              error={errors.gtaGroup}
              hint={
                <span className="row" style={{ gap: 6 }}>
                  {view.groupPrefilled ? 'Pre-filled from the suggestion.' : 'Any GTA group code.'}
                  {groups.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(editGroupMode(state, 'select'))} disabled={disabled}>
                      Choose from the list
                    </button>
                  )}
                </span>
              }
              disabled={disabled}
            />
          )}
          <MoneyInput
            label="Daily rate (ex VAT)"
            required
            value={state.ratePence}
            onChange={(p) => onChange(editRate(state, p))}
            error={errors.dailyRatePence}
            hint={view.ratePrefilled ? 'Pre-filled from the benchmark — set your own rate if it differs.' : 'Your daily rate; the ledger holds pence.'}
            disabled={disabled}
          />
        </div>
        {showNoRate && (
          <div className="notice notice-warn small">
            {view.noRate}. <Link to="/settings/gta-rates">Open GTA benchmark rates</Link>
          </div>
        )}
        {state.suggestion && (state.groupDirty || state.rateDirty) && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => onChange(resetToSuggestion(state, groups))} disabled={disabled}>
              Use the suggestion again
            </Button>
          </div>
        )}
        <p className="basis">{GTA_PANEL_CAVEAT}</p>
      </div>
    </fieldset>
  );
}
