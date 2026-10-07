import { describe, expect, it } from 'vitest';
import { SEVERITY_COLOURS, TONE_COLOURS, damageReducer, damageSummary, damagedZones, describeDamage, resolveBody, zoneFill, type DamageMap } from './damageModel';

describe('severity colours', () => {
  it('uses the part finish when undamaged and a distinct colour per severity', () => {
    expect(zoneFill('glass', undefined)).toBe(TONE_COLOURS.glass);
    expect(zoneFill('glass', { severity: 0, source: 'user' })).toBe(TONE_COLOURS.glass);
    expect(zoneFill('body', { severity: 1, source: 'user' })).toBe(SEVERITY_COLOURS[1]);
    expect(zoneFill('tyre', { severity: 3, source: 'ai' })).toBe(SEVERITY_COLOURS[3]);
    expect(new Set([SEVERITY_COLOURS[1], SEVERITY_COLOURS[2], SEVERITY_COLOURS[3], TONE_COLOURS.body]).size).toBe(4);
  });
});

describe('damageReducer', () => {
  it('sets severity with a suggested operation, as a user entry', () => {
    const s = damageReducer({}, { type: 'setSeverity', zone: 'front_door_l', severity: 2 });
    expect(s).toEqual({ front_door_l: { severity: 2, operation: 'repair', source: 'user' } });
    const heavy = damageReducer(s, { type: 'setSeverity', zone: 'front_door_l', severity: 3 });
    expect(heavy.front_door_l).toEqual({ severity: 3, operation: 'repair', source: 'user' }); // keeps chosen op
  });

  it('cycles none → light → medium → heavy → none', () => {
    let s: DamageMap = {};
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = damageReducer(s, { type: 'cycle', zone: 'bonnet' });
      seen.push(s.bonnet?.severity ?? 0);
    }
    expect(seen).toEqual([1, 2, 3, 0]);
    expect(s).toEqual({});
  });

  it('confirms AI suggestions on edit and remembers rejections', () => {
    const ai: DamageMap = { headlamp_r: { severity: 3, operation: 'replace', confidence: 0.8, source: 'ai' } };
    const op = damageReducer(ai, { type: 'setOperation', zone: 'headlamp_r', operation: 'r_and_i' });
    expect(op.headlamp_r).toEqual({ severity: 3, operation: 'r_and_i', source: 'user' });
    const confirmed = damageReducer(ai, { type: 'confirm', zone: 'headlamp_r' });
    expect(confirmed.headlamp_r).toEqual({ severity: 3, operation: 'replace', source: 'user' });
    const rejected = damageReducer(ai, { type: 'clear', zone: 'headlamp_r' });
    expect(rejected.headlamp_r).toEqual({ severity: 0, source: 'user' });
    expect(damageReducer(rejected, { type: 'clear', zone: 'headlamp_r' })).toBe(rejected);
  });

  it('clears user entries, clears an operation, ignores unknown zones and no-ops', () => {
    const s: DamageMap = { grille: { severity: 2, operation: 'replace', source: 'user' } };
    expect(damageReducer(s, { type: 'clear', zone: 'grille' })).toEqual({});
    expect(damageReducer(s, { type: 'setOperation', zone: 'grille', operation: undefined }).grille).toEqual({ severity: 2, source: 'user' });
    expect(damageReducer(s, { type: 'setSeverity', zone: 'flux_capacitor', severity: 3 })).toBe(s);
    expect(damageReducer(s, { type: 'setSeverity', zone: 'grille', severity: 2 })).toBe(s);
    expect(damageReducer(s, { type: 'setOperation', zone: 'bonnet', operation: 'repair' })).toBe(s);
    expect(damageReducer(s, { type: 'confirm', zone: 'grille' })).toBe(s);
    expect(damageReducer(s, { type: 'clearAll' })).toEqual({});
    const empty = {};
    expect(damageReducer(empty, { type: 'clearAll' })).toBe(empty);
  });
});

describe('lists and labels', () => {
  const damage: DamageMap = {
    rear_bumper: { severity: 1, source: 'user' },
    front_bumper: { severity: 3, operation: 'replace', source: 'user' },
    boot_lid: { severity: 2, source: 'ai', confidence: 0.62 },
    bonnet: { severity: 0, source: 'user' },
    nonsense: { severity: 3, source: 'user' }
  };
  it('lists damaged zones heaviest first and flags zones not on the body', () => {
    const rows = damagedZones(damage, 'hatchback');
    expect(rows.map((r) => r.zone.id)).toEqual(['front_bumper', 'boot_lid', 'rear_bumper']);
    expect(rows.find((r) => r.zone.id === 'boot_lid')!.onBody).toBe(false);
    expect(damagedZones(damage, 'saloon').every((r) => r.onBody)).toBe(true);
  });
  it('summarises and describes', () => {
    expect(damageSummary({})).toBe('No damage marked');
    expect(damageSummary(damage)).toBe('4 parts damaged: 2 heavy, 1 medium, 1 light');
    expect(describeDamage({ severity: 2, operation: 'blend', source: 'ai', confidence: 0.62 })).toBe('Medium · Blend · AI 62%');
    expect(describeDamage({ severity: 1, source: 'user' })).toBe('Light');
  });
  it('resolves free-text bodies', () => {
    expect(resolveBody('PANEL VAN')).toBe('panel-van');
    expect(resolveBody(undefined)).toBe('hatchback');
  });
});
