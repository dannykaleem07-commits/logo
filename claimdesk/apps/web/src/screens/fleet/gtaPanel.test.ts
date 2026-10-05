import { describe, expect, it } from 'vitest';
import type { GtaRate, GtaSuggestion } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { emptyPickerValue } from '../vehicles/vehiclePickerModel';
import {
  applySuggestion,
  benchmarkLine,
  editGroup,
  editRate,
  effectiveGroupMode,
  emptyGtaPanel,
  GTA_PANEL_CAVEAT,
  gtaPanelFromUnit,
  gtaSuggestionInput,
  groupOptions,
  groupsWithRates,
  noRateMessage,
  OTHER_GROUP,
  panelView,
  resetToSuggestion,
  suggestionDiffersLine,
  suggestionLine,
  suggestQuery,
  validateGtaPanel
} from './gtaPanel';

const DATE = '2026-10-04';
const unverified = { status: 'unverified' as const, sourceUrl: 'https://www.gtacredithire.com/rates/' };
const RATES: GtaRate[] = [
  { group: 'S1', description: 'Small car', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: unverified },
  { group: 'M1', description: 'Small SUV', dailyRatePence: 6549, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: unverified },
  { group: 'M', description: 'Medium car', dailyRatePence: 5666, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: unverified }
];
const GROUPS = groupsWithRates(RATES);

function suggestion(group: string | null, rate: GtaRate | null, basis: GtaSuggestion['basis'] = 'catalogue_model'): GtaSuggestion {
  return { group, confidence: group ? 'medium' : 'none', basis, reason: group ? `Group ${group} is suggested.` : 'Not enough is known.', rate: rate ? { ...rate, origin: 'kb' } : null, note: 'benchmark' };
}

describe('suggestQuery', () => {
  it('waits for make and model, then sends the catalogue slugs and the facts', () => {
    expect(suggestQuery({ ...emptyPickerValue(), make: 'Ford' }, DATE)).toBeNull();
    const q = suggestQuery({ ...emptyPickerValue(), make: 'Ford', model: 'Puma', variant: 'ST-Line', catalogue: { makeSlug: 'ford', modelSlug: 'puma', generationId: 'g1', trimId: 't1' }, segment: 'suv-small', engineCapacityCc: 999, fuelType: 'petrol', bodyType: 'SUV' }, DATE);
    expect(q).toEqual({ make: 'ford', model: 'puma', generationId: 'g1', trimId: 't1', segment: 'suv-small', bodyType: 'SUV', engineCapacityCc: 999, fuelType: 'petrol', variant: 'ST-Line', date: DATE });
    expect(suggestQuery({ ...emptyPickerValue(), make: 'Lada', model: 'Niva' }, DATE)).toEqual({ make: 'Lada', model: 'Niva', date: DATE });
    // the vehicle's own year picks the catalogue generation (the date only picks the rate)
    expect(suggestQuery({ ...emptyPickerValue(), make: 'Lada', model: 'Niva', yearOfManufacture: 2003 }, DATE)).toEqual({ make: 'Lada', model: 'Niva', yearOfManufacture: 2003, date: DATE });
  });
});

describe('pre-fill until edited', () => {
  it('a suggestion fills the group and the benchmark rate', () => {
    const s = applySuggestion(emptyGtaPanel(), suggestion('M1', RATES[1]!), GROUPS);
    expect(s).toMatchObject({ group: 'M1', ratePence: 6549, groupDirty: false, rateDirty: false, groupMode: 'select' });
    const view = panelView(s, RATES, DATE);
    expect(view).toMatchObject({ groupPrefilled: true, ratePrefilled: true });
    expect(view.rate?.dailyRatePence).toBe(6549);
    expect(gtaSuggestionInput(s)).toEqual({ group: 'M1', basis: 'catalogue_model', rateGroup: 'M1', ratePeriod: '2026-27' });
    // a later suggestion (the user picked a trim) replaces both while untouched
    const s2 = applySuggestion(s, suggestion('S1', RATES[0]!, 'catalogue_trim'), GROUPS);
    expect(s2).toMatchObject({ group: 'S1', ratePence: 4232 });
  });

  it('an edited rate is kept; the group still follows until it is edited', () => {
    let s = applySuggestion(emptyGtaPanel(), suggestion('M1', RATES[1]!), GROUPS);
    s = editRate(s, 5900);
    s = applySuggestion(s, suggestion('S1', RATES[0]!), GROUPS);
    expect(s).toMatchObject({ group: 'S1', ratePence: 5900, rateDirty: true });
    expect(panelView(s, RATES, DATE).ratePrefilled).toBe(false);
  });

  it('an edited group is kept and the rate follows the chosen group until typed', () => {
    let s = applySuggestion(emptyGtaPanel(), suggestion('M1', RATES[1]!), GROUPS);
    s = editGroup(s, 'M', RATES, DATE);
    expect(s).toMatchObject({ group: 'M', groupDirty: true, ratePence: 5666, rateDirty: false });
    s = applySuggestion(s, suggestion('S1', RATES[0]!), GROUPS);
    expect(s).toMatchObject({ group: 'M', ratePence: 5666 });
    expect(panelView(s, RATES, DATE).groupPrefilled).toBe(false);
    // back to the suggestion on request
    expect(resetToSuggestion(s, GROUPS)).toMatchObject({ group: 'S1', ratePence: 4232, groupDirty: false, rateDirty: false });
  });

  it('an existing unit keeps its own group and rate', () => {
    const s = applySuggestion(gtaPanelFromUnit({ gtaGroup: 'm', dailyRatePence: 5300 }, GROUPS), suggestion('S1', RATES[0]!), GROUPS);
    expect(s).toMatchObject({ group: 'M', ratePence: 5300, groupDirty: true, rateDirty: true });
  });
});

describe('no benchmark rate', () => {
  it('leaves the rate empty and says which group needs a rate in Settings', () => {
    const s = applySuggestion(emptyGtaPanel(), suggestion('PV3', null, 'segment_default'), GROUPS);
    expect(s).toMatchObject({ group: 'PV3', ratePence: null });
    expect(effectiveGroupMode(s, GROUPS)).toBe('other');
    const view = panelView(s, RATES, DATE);
    expect(view.noRate).toBe('No benchmark rate is loaded for group PV3 — add one in Settings → GTA benchmark rates');
    expect(view.rate).toBeUndefined();
    expect(noRateMessage('CP1')).toBe('No benchmark rate is loaded for group CP1 — add one in Settings → GTA benchmark rates');
    expect(validateGtaPanel(s)).toEqual({ ratePence: expect.any(String) });
    // typing the user's own rate is enough to save
    expect(validateGtaPanel(editRate(s, 7000))).toEqual({});
  });
  it('no group suggested → both fields empty and required', () => {
    const s = applySuggestion(emptyGtaPanel(), suggestion(null, null, 'none'), GROUPS);
    expect(s).toMatchObject({ group: '', ratePence: null });
    expect(Object.keys(validateGtaPanel(s)).sort()).toEqual(['group', 'ratePence']);
    expect(suggestionLine(s.suggestion!)).toMatch(/No GTA group could be suggested/);
  });
});

describe('panel copy', () => {
  it('select of groups with rates plus Other…; free entry validated', () => {
    expect(groupOptions(RATES).map((o) => o.value)).toEqual(['M', 'M1', 'S1', OTHER_GROUP]);
    expect(groupOptions(RATES).at(-1)?.label).toBe('Other…');
    // an "e.g." inside brackets never cuts the label mid-parenthesis
    const eg: GtaRate[] = [{ ...RATES[0]!, group: 'S3', description: 'Standard group S3 (e.g. Golf, Focus). Larger family hatchbacks.' }, { ...RATES[0]!, group: 'S1', description: 'Standard group S1 (smallest standard cars, e.g. Fiesta)' }];
    expect(groupOptions(eg).slice(0, 2).map((o) => o.label)).toEqual(['S1 — Standard group S1', 'S3 — Standard group S3']);
    expect(suggestionDiffersLine({ group: 'S1', suggestion: suggestion('S3', { ...RATES[0]!, group: 'S3', dailyRatePence: 5500 }) }, (p) => formatGBP(p))).toBe('Suggested S3 (benchmark £55.00) — this unit is S1');
    expect(suggestionDiffersLine({ group: 'S3', suggestion: suggestion('S3', RATES[0]!) }, (p) => formatGBP(p))).toBeNull();
    const other = editGroup(emptyGtaPanel(), OTHER_GROUP, RATES, DATE);
    expect(other.groupMode).toBe('other');
    expect(validateGtaPanel({ ...other, group: 'NOT A GROUP', ratePence: 100 })).toHaveProperty('group');
  });
  it('suggestion and benchmark lines, and the caveat wording', () => {
    expect(suggestionLine(suggestion('M1', RATES[1]!))).toBe('Suggested GTA group M1 — from the catalogue model (medium confidence)');
    expect(benchmarkLine(RATES[1], (p) => formatGBP(p))).toBe(`Benchmark daily rate for ${RATES[1]!.group.toUpperCase()}: £65.49 (2026-27, unverified)`);
    expect(GTA_PANEL_CAVEAT).toBe('GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber. Set your own daily rate if it differs.');
  });
  it('verification is shown as stored — a verified KB rate stays verified, an unverified one stays unverified', () => {
    const verified: GtaRate = { ...RATES[0]!, verification: { status: 'verified', sourceUrl: 'https://example.org/rates.pdf', verifiedBy: 'u1', verifiedAt: '2026-08-01' } };
    const s = applySuggestion(emptyGtaPanel(), suggestion('S1', verified), GROUPS);
    expect(panelView(s, [verified], DATE).rate?.verification.status).toBe('verified');
    const u = applySuggestion(emptyGtaPanel(), suggestion('M1', RATES[1]!), GROUPS);
    expect(panelView(u, RATES, DATE).rate?.verification.status).toBe('unverified');
  });
});
