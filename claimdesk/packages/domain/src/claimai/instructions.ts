// owned by claimai-server
/**
 * Standing case instructions (docs/CLAIM-AI-INPUT.md §3.5, §7): which are in force, which hold or "ask first" covers a
 * recipient, and the sentences the panel, the prompts and the Autopilot show. Pure.
 */
import type { RecipientRole } from '../agents/types.js';
import type { ISODateTime } from '../types.js';
import { fmtDayLong, fmtDayWeek } from './dates.js';
import type { AgentScope, ContactRole, InstructionEffect, InstructionView } from './types.js';

const ms = (iso: string): number => Date.parse(iso);

/** In force at `now`: active_from ≤ now < until (no until = until removed). */
export function activeInstructions(all: InstructionView[], now: ISODateTime): InstructionView[] {
  const t = ms(now);
  return all.filter((i) => ms(i.activeFrom) <= t && (!i.until || ms(i.until) > t));
}

const covers = (contacts: ContactRole[], contact: ContactRole): boolean => contacts.includes(contact) || contacts.includes('anyone') || contact === 'anyone';

/** The newest hold_contact instruction covering `contact` (or 'anyone'). */
export function holdFor(active: InstructionView[], contact: ContactRole): InstructionView | undefined {
  return active.find((i) => i.effect?.kind === 'hold_contact' && covers(i.effect.contacts, contact));
}

/** The newest ask_before_sending instruction covering `contact` (or 'anyone'). */
export function askFirstFor(active: InstructionView[], contact: ContactRole): InstructionView | undefined {
  return active.find((i) => i.effect?.kind === 'ask_before_sending' && covers(i.effect.contacts, contact));
}

/** Is a run of `agent` covered by an instruction's scope? Reviewer / judge runs see every instruction (read-only context). */
export function appliesToAgent(i: Pick<InstructionView, 'appliesTo'>, agent: string): boolean {
  if (i.appliesTo.includes('all')) return true;
  if (agent === 'reviewer' || agent === 'judge' || agent === 'critic') return true;
  return (i.appliesTo as string[]).includes(agent);
}

/** The Autopilot step recipient → the contact an instruction names. */
export function contactOfStepRecipient(r: 'client' | 'at_fault_insurer' | 'supplier' | 'engineer'): ContactRole {
  return r;
}

/** An outbox recipient role → the contact an instruction names (own insurer, court, other → null). */
export function contactOfRecipientRole(r: RecipientRole): ContactRole | null {
  if (r === 'client' || r === 'at_fault_insurer') return r;
  return null;
}

export const AGENT_SCOPE_LABEL: Readonly<Record<AgentScope, string>> = {
  all: 'all agents',
  autopilot: 'the Autopilot',
  case_manager: 'the case manager',
  mail: 'the mail agent',
  drafter: 'the drafter',
  intake: 'intake',
};

export const CONTACT_LABEL: Readonly<Record<ContactRole, string>> = {
  client: 'the client',
  at_fault_insurer: 'the insurer',
  engineer: 'the engineer',
  repairer: 'the repairer',
  supplier: 'the supplier',
  solicitor: 'the solicitor',
  anyone: 'anyone',
};

export function scopeLabel(appliesTo: AgentScope[]): string {
  if (!appliesTo.length || appliesTo.includes('all')) return AGENT_SCOPE_LABEL.all;
  return appliesTo.map((a) => AGENT_SCOPE_LABEL[a]).join(', ');
}

function contactsText(cs: ContactRole[]): string {
  const ls = cs.map((c) => CONTACT_LABEL[c]);
  return ls.length <= 1 ? (ls[0] ?? 'anyone') : `${ls.slice(0, -1).join(', ')} and ${ls[ls.length - 1]}`;
}

/** "Nothing goes to the client until Mon 19 Oct" / "Asks you before anything is sent to the insurer" / null. */
export function effectLabel(e: InstructionEffect | null, until: string | null): string | null {
  if (!e || e.kind === 'none') return null;
  const u = until ? ` until ${fmtDayWeek(until)}` : '';
  if (e.kind === 'hold_contact') return `Nothing goes to ${contactsText(e.contacts)}${u}`;
  if (e.kind === 'ask_before_sending') return `Asks you before anything is sent to ${contactsText(e.contacts)}${u}`;
  return `Agents paused on this claim${u}`;
}

/** "Don't chase the client until Monday 19 October 2026 (all agents)" — the text plus scope (and the end date when the text does not say it). */
export function instructionLine(i: InstructionView, now: ISODateTime): string {
  const ended = i.until && ms(i.until) <= ms(now);
  const text = i.text.replace(/[.\s]+$/, '');
  const untilWords = i.until && !/\buntil\b/i.test(text) ? ` until ${fmtDayLong(i.until)}` : '';
  const replaced = i.until ? text.replace(/\buntil\s+(?:next\s+|this\s+|on\s+)?[A-Za-z]+day\b/i, `until ${fmtDayLong(i.until)}`) : text;
  return `${replaced}${untilWords} (${scopeLabel(i.appliesTo)})${ended ? ' — ended' : ''}`;
}

/** The line in the agents' prompt block (§7.3). */
export function promptLine(i: InstructionView): string {
  const bits: string[] = [scopeLabel(i.appliesTo)];
  if (i.until) bits.push(`until ${fmtDayWeek(i.until)} 00:00`);
  const e = i.effect;
  if (e?.kind === 'hold_contact') bits.push(`code holds every email to ${contactsText(e.contacts)}`);
  if (e?.kind === 'ask_before_sending') bits.push(`code asks the owner before every email to ${contactsText(e.contacts)}`);
  if (e?.kind === 'pause_agents') bits.push('agents are paused on this claim');
  const text = i.text.replace(/[.\s]+$/, '');
  return `- ${text}. (${bits.join('; ')})`;
}

/** Same effect (kind + contacts): the newer instruction supersedes the older one (§7.1). */
export function sameEffect(a: InstructionEffect | null, b: InstructionEffect | null): boolean {
  if (!a || !b || a.kind !== b.kind || a.kind === 'none') return false;
  if (a.kind === 'pause_agents') return true;
  const ca = [...(a as { contacts: ContactRole[] }).contacts].sort().join(',');
  const cb = [...(b as { contacts: ContactRole[] }).contacts].sort().join(',');
  return ca === cb;
}
