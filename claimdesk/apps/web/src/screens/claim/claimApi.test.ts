import { describe, expect, it } from 'vitest';
import { pickLabourSuggestion } from './claimApi';

const rows = [
  { make: 'VOLKSWAGEN', model: 'GOLF', panel: 'Front bumper', operation: 'Refinish', count: 7, medianHours: 2.4, suggestedHours: 2.4, note: 'Median of 7 approved CCGUK estimates' },
  { make: 'VOLKSWAGEN', model: 'GOLF', panel: 'Rear bumper', operation: 'Refinish', count: 2, medianHours: 2.1, suggestedHours: null, note: 'Only 2 approved observation(s); 3 needed before a median is offered' },
  { make: 'VOLKSWAGEN', model: 'GOLF', panel: 'Front bumper', operation: 'Replace', count: 4, medianHours: 1.1, suggestedHours: 1.1, note: 'Median of 4 approved CCGUK estimates' }
];

describe('pickLabourSuggestion (GET /engineering/labour-library/suggest)', () => {
  it('picks the operation (and panel) row and keeps the API note', () => {
    expect(pickLabourSuggestion(rows, { operation: 'refinish', panel: 'front bumper' })).toEqual({ panel: 'Front bumper', operation: 'Refinish', suggestedHours: 2.4, n: 7, note: 'Median of 7 approved CCGUK estimates' });
    expect(pickLabourSuggestion(rows, { operation: 'Refinish', panel: 'Rear bumper' }).suggestedHours).toBeNull();
  });
  it('without a panel prefers the group with most observations', () => {
    expect(pickLabourSuggestion(rows, { operation: 'Refinish' }).n).toBe(7);
  });
  it('says so when the library has nothing for the operation', () => {
    const r = pickLabourSuggestion(rows, { operation: 'Strip/refit', panel: 'Headlamp' });
    expect(r).toMatchObject({ operation: 'Strip/refit', panel: 'Headlamp', suggestedHours: null, n: 0 });
    expect(r.note).toMatch(/No approved CCGUK estimate/);
    expect(pickLabourSuggestion([], { operation: 'Refinish' }).n).toBe(0);
  });
});
