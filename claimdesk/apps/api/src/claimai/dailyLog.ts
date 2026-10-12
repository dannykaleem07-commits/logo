// owned by claimai-server
/**
 * The daily log's AI input section (docs/CLAIM-AI-INPUT.md §13): one line per update applied, catch-up applied, update
 * still waiting for the AI after a day, standing instruction added / ended / removed, and Needs-you card raised from an
 * update. Built from the audit trail, the inputs and their logs — never from the owner's words (only the lines ClaimDesk
 * wrote), and swept for accusation words. Absent when empty.
 */
import { ACCUSATION_WORDS, BANNED_INTAKE_WORDS, fmtDayShort, fmtDayWeek } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { LogLine } from '../agent/dailyLog.js';
import { lineResults } from './apply.js';
import { interpretationOf } from './service.js';

interface Row {
  at: string;
  user_id: string;
  action: string;
  entity_id: string;
  after: string | null;
}

const parse = <T>(s: string | null): T => {
  try {
    return (s ? JSON.parse(s) : {}) as T;
  } catch {
    return {} as T;
  }
};
const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
const safe = (s: string): string => (ACCUSATION_WORDS.test(s) || BANNED_INTAKE_WORDS.test(s) ? 'a private note' : s);
const WAITING_TEXT: Record<string, string> = { agents_off: 'agents paused', kill_switch: 'the kill switch is on', usage: 'the AI usage limit is reached', sign_in: 'the AI sign-in needs fixing' };


/** Shorten at a word boundary with an ellipsis (never "… confirm the ;"). */
export function clip(t: string, max = 80): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}
export function claimAiDailyLogSection(ctx: AppContext, _day: string, bounds: { start: string; end: string }): { claimAi?: LogLine[] } {
  const sqlite = ctx.handle.sqlite;
  const rows = sqlite
    .prepare(`SELECT at, user_id, action, entity_id, after FROM audit_log WHERE at >= ? AND at < ? AND action IN ('claim_ai.input.apply', 'claim_ai.catch_up.apply', 'claim_ai.instruction.create', 'claim_ai.instruction.retire', 'claim_ai.instruction.due') ORDER BY at, rowid`)
    .all(bounds.start, bounds.end) as Row[];
  const lines: LogLine[] = [];
  const ref = (claimId: string) => ctx.repos.getClaim(ctx.db, claimId)?.reference;
  const push = (l: LogLine) => lines.push({ ...l, text: safe(l.text) });

  for (const r of rows) {
    const after = parse<{ claimId?: string; inputId?: string; applied?: number; needsYou?: number; mode?: string; status?: string }>(r.after);
    if (r.action === 'claim_ai.input.apply' || r.action === 'claim_ai.catch_up.apply') {
      const input = after.inputId ? ctx.repos.getAiInput(ctx.db, after.inputId) : undefined;
      if (!input) continue;
      const reference = ref(input.claimId);
      const results = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id).filter((l) => l.at <= r.at));
      const interp = interpretationOf(input);
      const applied = interp.actions.filter((a) => results.get(a.key)?.state === 'applied' && a.type !== 'private_note');
      const ny = interp.actions.filter((a) => results.get(a.key)?.state === 'needs_you');
      const link = `/claims/${input.claimId}/ai`;
      if (input.kind === 'catch_up') {
        const filed = applied.filter((a) => a.type === 'file_evidence').length;
        const already = (interp.catchUp?.files ?? []).filter((f) => f.plan === 'already_on_file').length;
        const recOut = applied.filter((a) => a.type === 'record_correspondence' && a.params.direction === 'out');
        const recIn = applied.filter((a) => a.type === 'record_correspondence' && a.params.direction === 'in');
        const waiting = interp.actions.filter((a) => !results.has(a.key) && (a.tier === 'confirm' || a.tier === 'apply')).length;
        const outText = recOut.length ? `recorded ${plural(recOut.length, 'letter')} we sent outside ClaimDesk (${recOut.map((a) => `${a.params.label ?? 'letter'} ${a.params.at ? fmtDayShort(a.params.at) : ''}`.trim()).join(', ')})` : null;
        const bits = [
          filed || already ? `filed ${plural(filed, 'document')}${already ? ` (${already} already on file)` : ''}` : null,
          outText ? `${outText}${recIn.length ? ` and ${recIn.length} received` : ''}` : recIn.length ? `recorded ${recIn.length} received` : null,
          waiting ? `${waiting} wait${waiting === 1 ? 's' : ''} for you` : null,
        ].filter(Boolean);
        push({ at: r.at, claimId: input.claimId, ...(reference ? { reference } : {}), agent: 'intake', text: `Caught up ${reference ?? 'a claim'}: ${bits.join('; ') || 'nothing new to file'}.`, why: r.user_id.startsWith('agent:') ? 'filed automatically (Apply automatically was on)' : 'you pressed File and record', link });
      } else {
        const what = applied.map((a) => a.title.replace(/^Add to chronology: /, '').replace(/ — (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /, ' ')).map(clip).slice(0, 6);
        if (what.length) push({ at: r.at, claimId: input.claimId, ...(reference ? { reference } : {}), agent: 'case_manager', text: `Your update on ${reference ?? 'a claim'}: ${what.join('; ')}.`, why: 'you pressed Do it', link });
        for (const a of ny) {
          push({ at: r.at, claimId: input.claimId, ...(reference ? { reference } : {}), agent: 'case_manager', text: `Sent to Needs-you from your update on ${reference ?? 'a claim'}: ${a.title.replace(/ — goes to Needs-you.*$/, '').slice(0, 120)}.`, why: 'money, offers, legal steps and closing always go to you', link: `/needs-you?item=${String(results.get(a.key)?.refs.needsYouId ?? '')}` });
        }
      }
      continue;
    }
    // standing instructions
    const ins = ctx.repos.getInstruction(ctx.db, r.entity_id);
    if (!ins) continue;
    const reference = ref(ins.claimId);
    const text = ins.text.replace(/[.\s]+$/, '');
    const until = ins.until ? ` (until ${fmtDayWeek(ins.until)})` : '';
    const link = `/claims/${ins.claimId}/ai`;
    if (r.action === 'claim_ai.instruction.create') push({ at: r.at, claimId: ins.claimId, ...(reference ? { reference } : {}), agent: 'supervisor', text: `Standing instruction on ${reference ?? 'a claim'}: ${text}${until} (agents and the Autopilot follow it).`, why: 'you gave it in the AI input', link });
    else if (r.action === 'claim_ai.instruction.retire') push({ at: r.at, claimId: ins.claimId, ...(reference ? { reference } : {}), agent: 'supervisor', text: `Standing instruction on ${reference ?? 'a claim'} removed by you: ${text}.`, link });
    else push({ at: r.at, claimId: ins.claimId, ...(reference ? { reference } : {}), agent: 'supervisor', text: `Your instruction ended on ${reference ?? 'a claim'}: ${text}.`, why: 'its end date came', link });
  }

  // updates waiting for the AI for more than a day
  const dayAgo = new Date(Date.parse(bounds.end) - 86_400_000).toISOString();
  for (const input of ctx.repos.listAiInputs(ctx.db, { status: ['waiting_ai'], limit: 200 })) {
    if (input.createdAt > dayAgo) continue;
    const reference = ref(input.claimId);
    const w = (() => {
      const s = ctx.repos.getAgentSettings(ctx.db);
      return s.autonomy.killSwitch ? 'kill_switch' : !s.agents.enabled || s.ai.driver === 'off' ? 'agents_off' : 'usage';
    })();
    push({ at: bounds.end, claimId: input.claimId, ...(reference ? { reference } : {}), agent: 'case_manager', text: `Your update on ${reference ?? 'a claim'} is waiting for the AI (${WAITING_TEXT[w]}).`, why: 'simple phrases were done; the rest needs the AI', link: `/claims/${input.claimId}/ai` });
  }
  return lines.length ? { claimAi: lines } : {};
}
