// owned by claimai-server
import { describe, expect, it } from 'vitest';
import { activeInstructions, appliesToAgent, askFirstFor, contactOfRecipientRole, contactOfStepRecipient, effectLabel, holdFor, instructionLine, promptLine, sameEffect, scopeLabel } from './instructions.js';
import { parseEffect, type InstructionView } from './types.js';

const NOW = '2026-10-12T09:00:00.000Z';
const hold: InstructionView = { id: 'i1', text: "Don't chase the client until Monday", appliesTo: ['all'], effect: { kind: 'hold_contact', contacts: ['client'] }, activeFrom: '2026-10-12T08:00:00.000Z', until: '2026-10-18T23:00:00.000Z' };
const ask: InstructionView = { id: 'i2', text: 'Ask me before sending anything to the insurer', appliesTo: ['all'], effect: { kind: 'ask_before_sending', contacts: ['at_fault_insurer'] }, activeFrom: NOW, until: null };
const anyone: InstructionView = { id: 'i3', text: 'Hold everything', appliesTo: ['autopilot'], effect: { kind: 'hold_contact', contacts: ['anyone'] }, activeFrom: NOW, until: null };
const guide: InstructionView = { id: 'i4', text: 'Send the client a weekly update while the car is at the garage', appliesTo: ['case_manager', 'drafter'], effect: { kind: 'none' }, activeFrom: NOW, until: null };

describe('standing instructions', () => {
  it('active window: from ≤ now < until', () => {
    expect(activeInstructions([hold, ask], NOW).map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(activeInstructions([hold, ask], '2026-10-18T23:00:00.000Z').map((i) => i.id)).toEqual(['i2']);
    expect(activeInstructions([ask], '2026-10-12T08:59:59.000Z')).toEqual([]);
  });
  it('hold / ask matching per contact and anyone', () => {
    expect(holdFor([hold], 'client')?.id).toBe('i1');
    expect(holdFor([hold], 'at_fault_insurer')).toBeUndefined();
    expect(holdFor([anyone], 'engineer')?.id).toBe('i3');
    expect(askFirstFor([hold, ask], 'at_fault_insurer')?.id).toBe('i2');
    expect(askFirstFor([hold], 'client')).toBeUndefined();
    expect(contactOfStepRecipient('supplier')).toBe('supplier');
    expect(contactOfRecipientRole('client')).toBe('client');
    expect(contactOfRecipientRole('own_insurer')).toBeNull();
    expect(appliesToAgent(guide, 'drafter')).toBe(true);
    expect(appliesToAgent(guide, 'mail')).toBe(false);
    expect(appliesToAgent(guide, 'reviewer')).toBe(true);
    expect(appliesToAgent(hold, 'mail')).toBe(true);
  });
  it('labels and lines', () => {
    expect(instructionLine(hold, NOW)).toBe("Don't chase the client until Monday 19 October 2026 (all agents)");
    expect(instructionLine(hold, '2026-10-20T00:00:00.000Z')).toMatch(/— ended$/);
    expect(instructionLine(guide, NOW)).toBe('Send the client a weekly update while the car is at the garage (the case manager, the drafter)');
    expect(effectLabel(hold.effect, hold.until)).toBe('Nothing goes to the client until Mon 19 Oct');
    expect(effectLabel(ask.effect, null)).toBe('Asks you before anything is sent to the insurer');
    expect(effectLabel({ kind: 'pause_agents' }, hold.until)).toBe('Agents paused on this claim until Mon 19 Oct');
    expect(effectLabel({ kind: 'none' }, null)).toBeNull();
    expect(scopeLabel(['all'])).toBe('all agents');
    expect(promptLine(hold)).toBe("- Don't chase the client until Monday. (all agents; until Mon 19 Oct 00:00; code holds every email to the client)");
    expect(promptLine(guide)).toBe('- Send the client a weekly update while the car is at the garage. (the case manager, the drafter)');
  });
  it('same effect supersedes; effect parsing', () => {
    expect(sameEffect(hold.effect, { kind: 'hold_contact', contacts: ['client'] })).toBe(true);
    expect(sameEffect(hold.effect, ask.effect)).toBe(false);
    expect(sameEffect({ kind: 'none' }, { kind: 'none' })).toBe(false);
    expect(parseEffect({ kind: 'hold_contact', contacts: ['client', 'bogus', 'client'] })).toEqual({ kind: 'hold_contact', contacts: ['client'] });
    expect(parseEffect({ kind: 'hold_contact', contacts: [] })).toBeNull();
    expect(parseEffect({ kind: 'pause_agents' })).toEqual({ kind: 'pause_agents' });
    expect(parseEffect('x')).toBeNull();
  });
});
