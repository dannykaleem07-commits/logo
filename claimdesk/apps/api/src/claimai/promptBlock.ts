// owned by claimai-server
/**
 * The standing-instructions block every claim-scoped agent run carries (docs/CLAIM-AI-INPUT.md §7.3): the owner's
 * instructions in force for the run's agent, and the letters already sent outside ClaimDesk (newest 20). In the user
 * message only (never the cached prefix, so `promptVersion` is unchanged). Masked like the Case Brief. Registered on the
 * gateway at boot (`registerClaimInstructionsProvider`) so the gateway never imports this module.
 */
import { ACCUSATION_WORDS, BANNED_INTAKE_WORDS, CORRESPONDENCE_KIND_LABEL, fmtDateLong, isCorrespondenceKind, promptLine } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { AgentSpec } from '../agent/contracts.js';
import { maskText } from '../casework/mask.js';
import { activeInstructionViews } from './instructions.js';

export const INSTRUCTIONS_HEADER = "# The owner's standing instructions for this claim";
export const ALREADY_DONE_HEADER = '# Already done outside ClaimDesk (do not repeat)';

const CHANNEL_WORD: Record<string, string> = { email: 'emailed', post: 'sent by post', hand: 'handed over', phone: 'given by phone', portal: 'sent through the portal', unknown: 'sent' };

export function claimInstructionsBlock(ctx: AppContext, spec: AgentSpec, claimId: string): string | undefined {
  if (!ctx.repos.getClaim(ctx.db, claimId)) return undefined;
  const clean = (s: string) => (ACCUSATION_WORDS.test(s) || BANNED_INTAKE_WORDS.test(s) ? null : maskText(s));
  const instructions = activeInstructionViews(ctx, claimId, { agent: spec.name })
    .map((i) => ({ ...i, text: clean(i.text) }))
    .filter((i): i is typeof i & { text: string } => Boolean(i.text));
  const sent = ctx.repos
    .listCorrespondence(ctx.db, claimId, { direction: 'out' })
    .slice(-20)
    .map((r) => {
      const label = isCorrespondenceKind(r.kind) ? CORRESPONDENCE_KIND_LABEL[r.kind] : 'Letter';
      const to = r.counterpartyName ? ` to ${maskText(r.counterpartyName)}` : '';
      return `- ${label}${to} — ${CHANNEL_WORD[r.channel] ?? 'sent'} on ${fmtDateLong(r.at)}.`;
    });
  if (!instructions.length && !sent.length) return undefined;
  const parts: string[] = [];
  if (instructions.length) {
    parts.push(
      [
        INSTRUCTIONS_HEADER,
        'These come from the owner. Follow them; they override the playbook and your own plan for this claim. They never widen what you may do — the perimeter, the always-ask lists and the autonomy policy still apply, and code enforces the holds below.',
        ...instructions.map((i) => promptLine(i)),
      ].join('\n'),
    );
  }
  if (sent.length) parts.push([ALREADY_DONE_HEADER, ...sent].join('\n'));
  return parts.join('\n\n');
}
