// owned by intake-server (added by the integration verifier)
/** How a reading is normalised and shown in the draft (docs/SMART-INTAKE.md §6.4). */
import { describe, expect, it } from 'vitest';
import { normaliseForKey } from '../intake/bundles/candidates.js';

const NOW = '2026-10-12T12:00:00.000Z';

describe('normaliseForKey — accident date and time', () => {
  it('a date with no time shows as a date, not as midnight', () => {
    const r = normaliseForKey('accident.occurredAt', '15/08/2026', NOW);
    expect(r.ok).toBe(true);
    expect(r.display).toBe('15 Aug 2026');
  });
  it('a date with a time shows both (London time)', () => {
    const r = normaliseForKey('accident.occurredAt', '01/10/2026 08:35', NOW);
    expect(r.ok).toBe(true);
    expect(r.display).toBe('1 Oct 2026, 08:35');
  });
});

describe('plainFileError', () => {
  it('keeps technical AI reasons off the owner’s screen', async () => {
    const { plainFileError } = await import('../intake/bundles/views.js');
    expect(plainFileError(null)).toBeNull();
    expect(plainFileError('invalid result: no fake AI fixture matches job type intake.extract; fixtures for it: a, b')).toBe('The AI could not read this file. What could be read from its text is used; the details are in Agents > Jobs.');
    expect(plainFileError('The file is password-protected.')).toBe('The file is password-protected.');
  });
});
