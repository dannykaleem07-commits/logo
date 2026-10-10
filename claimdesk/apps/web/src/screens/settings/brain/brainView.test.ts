// owned by casework
import { describe, expect, it } from 'vitest';
import { formErrors, initialForm, kindSummary, needsCcgukTick, pathError } from './brainView';

describe('brain settings helpers', () => {
  it('builds and validates the activation form', () => {
    const f = initialForm({ business: [], precedence: 40, kind: 'playbook' });
    expect(f).toEqual({ business: [], precedence: '40', useForCcguk: false });
    expect(formErrors(f).business).toMatch(/at least one/);
    expect(formErrors({ ...f, business: ['ccguk'], precedence: 'x' }).precedence).toMatch(/whole number/);
    expect(formErrors({ ...f, business: ['ccguk'] })).toEqual({});
  });
  it('knows when the CCGUK tick matters, summarises kinds and checks paths', () => {
    expect(needsCcgukTick(['fixmyfile'])).toBe(true);
    expect(needsCcgukTick(['ccguk', 'fixmyfile'])).toBe(false);
    expect(kindSummary({ strategy: 2, snippet: 1 })).toBe('2 strategy · 1 snippet');
    expect(pathError('C:\\Users\\me\\pack')).toBeUndefined();
    expect(pathError('/home/me/pack')).toBeUndefined();
    expect(pathError('pack')).toMatch(/full path/);
  });
});
