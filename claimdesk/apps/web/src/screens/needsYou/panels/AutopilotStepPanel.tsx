// owned by ap-autopilot
/**
 * Needs-you autopilot_step (docs/SUPREME-AUTOPILOT.md §I.7, §H.3): what the step is, why it comes to you, what was
 * prepared and what each button does. The buttons are the item's options; the resolver runs as you and is audited.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import type { NeedsYouPanelProps } from './types';

interface Payload {
  stepId?: string;
  purpose?: 'owner_step' | 'confirm_step' | 'offer_expired' | 'reply_other_sender' | 'reply_unclear' | 'loop_guard';
  hireOfferId?: string;
  messageId?: string;
  link?: string;
  parsed?: { decision?: string; confidence?: number; questions?: string[]; needsChanged?: string[]; injectionSuspected?: boolean };
}

const PURPOSE_LABEL: Record<string, string> = {
  owner_step: 'A person does this step',
  confirm_step: 'Prepared for you to confirm',
  offer_expired: 'The hire offer expired without an answer',
  reply_other_sender: 'Someone else answered the hire offer',
  reply_unclear: 'The answer to the hire offer is not clear',
  loop_guard: 'The autopilot stopped retrying',
};

const OPTION_HELP: Record<string, string> = {
  do_it: 'does the step now as you (audited)',
  done: 'marks the step done with your note — the autopilot moves on',
  skip: 'skips the step on this claim (say why)',
  snooze: 'asks again tomorrow',
  open: 'nothing changes; open the claim to look',
  accepted: 'records the client’s yes; the booking is confirmed next',
  accepted_by_phone: 'records the yes as a phone call; the car is re-held if it is still free, otherwise another is found',
  declined: 'records the no and releases the car',
  search_again: 'withdraws the expired offer so the autopilot searches again',
  ignore: 'keeps waiting for the client',
};

export function AutopilotStepPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  return (
    <div className="stack-sm" data-testid="autopilot-step-panel">
      <div className="row">
        {p.purpose && <Badge tone={p.purpose === 'owner_step' ? 'navy' : p.purpose.startsWith('reply') || p.purpose === 'offer_expired' ? 'amber' : 'blue'}>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</Badge>}
        {p.stepId && <code>{p.stepId}</code>}
      </div>
      {p.parsed && (
        <p className="small">
          Read as <strong>{p.parsed.decision?.replace(/_/g, ' ')}</strong>
          {typeof p.parsed.confidence === 'number' ? ` (confidence ${p.parsed.confidence.toFixed(2)})` : ''}
          {p.parsed.questions?.length ? ` · Questions: ${p.parsed.questions.join('; ')}` : ''}
          {p.parsed.needsChanged?.length ? ` · Changes: ${p.parsed.needsChanged.join('; ')}` : ''}
          {p.parsed.injectionSuspected ? ' · The message may try to instruct the system — nothing was done.' : ''}
        </p>
      )}
      {!closed && item.options.length > 0 && (
        <ul className="muted small">
          {item.options.map((o) => (
            <li key={o.id}>
              <strong>{o.label}</strong>: {OPTION_HELP[o.id] ?? 'as labelled'}
            </li>
          ))}
        </ul>
      )}
      {(p.link || item.claimId) && (
        <p className="small">
          <Link to={p.link ?? `/claims/${item.claimId}?tab=autopilot`}>Open the Autopilot tab</Link>
        </p>
      )}
    </div>
  );
}
