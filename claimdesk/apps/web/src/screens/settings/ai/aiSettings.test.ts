import { describe, expect, it } from 'vitest';
import type { AiStatus } from '../../../api/aiApi';
import { agentsLine, aiLaneMax, checklistItems, jobRows, londonTime, minutesToMs, msToMinutes, pausedText, perJobPatch, usageBar, usageBars, wizardSteps } from './aiSettings';

const job = (model: string, effort: 'low' | 'medium' | 'high') => ({ model, effort, maxTurns: 6, timeoutMs: 360_000 });

function status(over: Partial<AiStatus> = {}): AiStatus {
  return {
    driver: { selected: 'subscription_cli', override: null, health: { kind: 'subscription_cli', ready: true, problems: [] } },
    cli: { path: 'C:\\Users\\o\\.local\\bin\\claude.exe', version: '2.1.300', minVersion: '2.1.292', minVersionOk: true, authMethod: 'oauth_token', loggedIn: true, problems: [], checkedAt: '2026-10-07T09:00:00Z' },
    secrets: { claudeToken: true, apiKey: false },
    settings: { driver: 'subscription_cli', quality: 'standard', perJob: {}, lanes: { ai: 1, io: 4, cpu: 2 }, reservePercent: 20, dailyUsdCap: 20, prices: {}, perClaimRunsPerDay: 8, debugTranscripts: false },
    jobModels: [
      { jobType: 'mail.triage', agent: 'mail', defaults: job('claude-sonnet-5-5', 'low'), effective: job('claude-sonnet-5-5', 'low') },
      { jobType: 'case.review', agent: 'case_manager', defaults: job('claude-opus-5-5', 'medium'), effective: job('claude-opus-5-5', 'medium') },
    ],
    agents: { enabled: false },
    checklist: { training_opt_out: { done: false, at: null, by: null }, subscription_terms: { done: false, at: null, by: null }, mailbox_connected: { done: false, at: null, by: null }, background_running: { done: false, at: null, by: null } },
    checklistComplete: false,
    usage: { driver: 'subscription_cli', costTodayUsd: 0, paused: false },
    canEnableAgents: false,
    blockers: ['Tick every item of the setup checklist'],
    realAiForbidden: false,
    fakeAllowed: false,
    platform: 'win32',
    notices: { terms: 'Subscription sign-in is meant for ordinary individual use…', training: 'Turn off Help improve Claude…', privacyUrl: 'https://claude.ai/settings/data-privacy-controls' },
    ...over,
  };
}

describe('Settings > AI helpers', () => {
  it('checklist: four items, the honest terms notice and the Help improve Claude link', () => {
    const items = checklistItems(status());
    expect(items.map((i) => i.id)).toEqual(['training_opt_out', 'subscription_terms', 'mailbox_connected', 'background_running']);
    expect(items[0]!.label).toMatch(/Help improve Claude/);
    expect(items[0]!.link?.href).toBe('https://claude.ai/settings/data-privacy-controls');
    expect(items[1]!.label).toMatch(/ordinary individual use/);
    expect(items[1]!.label).toMatch(/API/);
    expect(checklistItems(undefined)[0]!.link?.href).toMatch(/^https:\/\/claude\.ai\//);
  });

  it('wizard steps follow what is done', () => {
    const steps = wizardSteps(status());
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true, false]);
    const fresh = wizardSteps(status({ cli: { path: null, version: null, minVersion: '2.1.292', minVersionOk: false, authMethod: null, loggedIn: null, problems: ['not installed'], checkedAt: '' }, secrets: { claudeToken: false, apiKey: false } }));
    expect(fresh.map((s) => s.done)).toEqual([false, false, false, false, false]);
    expect(fresh[0]!.detail).toMatch(/winget install Anthropic\.ClaudeCode/);
    expect(wizardSteps(status({ realAiForbidden: true }))[4]!.detail).toMatch(/disabled/);
  });

  it('job rows and the per-job patch (only changed fields)', () => {
    const rows = jobRows(status());
    expect(rows[0]).toMatchObject({ jobType: 'mail.triage', label: 'Sort incoming email', overridden: false });
    expect(perJobPatch({ 'mail.triage': { model: 'claude-sonnet-5-5', effort: 'medium' }, 'case.review': {} }, rows)).toEqual({ 'mail.triage': { effort: 'medium' } });
    expect(perJobPatch({}, rows)).toEqual({});
  });

  it('usage bars: percent, tone against the reserve, reset time in London', () => {
    const now = new Date('2026-10-07T09:00:00Z');
    expect(usageBar('5h', { status: 'allowed', utilization: 0.42, resetsAt: '2026-10-07T13:05:00Z' }, 20, now)).toEqual({ label: '5h', percent: 42, tone: 'green', resets: '14:05', status: 'allowed' });
    expect(usageBar('5h', { status: 'allowed', utilization: 0.85 }, 20, now).tone).toBe('amber');
    expect(usageBar('5h', { status: 'rejected' }, 20, now).tone).toBe('red');
    expect(usageBar('5h', undefined, 20, now)).toMatchObject({ percent: null, tone: 'grey' });
    expect(usageBars(status(), now)).toHaveLength(2);
    expect(londonTime('2026-10-09T13:05:00Z', now)).toMatch(/Fri 9 Oct 14:05/);
  });

  it('paused banner and agents line', () => {
    const now = new Date('2026-10-07T09:00:00Z');
    expect(pausedText(status(), now)).toBeNull();
    const p = status({ usage: { driver: 'x', costTodayUsd: 0, paused: true, pausedUntil: '2026-10-07T13:05:00Z', pauseReason: 'usage_limited:five_hour' } });
    expect(pausedText(p, now)).toBe('AI paused until 14:05 — the Claude usage limit was reached. Queued work resumes by itself; mail, sends and deadlines keep running.');
    expect(agentsLine(status())).toEqual({ text: 'Agents off', tone: 'grey' });
    expect(agentsLine(status({ agents: { enabled: true } }))).toEqual({ text: 'Agents on', tone: 'green' });
    expect(agentsLine({ ...p, agents: { enabled: true } }).tone).toBe('amber');
  });

  it('lane limits and minute conversion', () => {
    expect(aiLaneMax('subscription_cli')).toBe(3);
    expect(aiLaneMax('api_key')).toBe(6);
    expect(msToMinutes(360_000)).toBe(6);
    expect(minutesToMs(0)).toBe(60_000);
  });
});
