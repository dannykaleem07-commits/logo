// owned by mail
import { useState } from 'react';
import type { Evidence } from '@ccguk/domain';
import { Modal } from '../../../../components/Modal';
import { Button } from '../../../../components/Button';
import { Checkbox, TextArea, TextInput } from '../../../../components/Form';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import { isEmailAddress, mailApi, parseAddresses, useMailMutation, type OutboxDetail } from '../../../../api/mailApi';

export interface ComposeDefaults {
  to?: string;
  subject?: string;
  inReplyToMessageId?: string | null;
}

export const SIGN_OFF = 'Claims Team, Courtesy Cars Group UK Ltd';

/** Problems with a compose form (empty means it can be sent). */
export function composeProblems(to: string, subject: string, body: string): string[] {
  const out: string[] = [];
  const list = parseAddresses(to);
  if (!list.length) out.push('Add at least one recipient.');
  const bad = list.filter((a) => !isEmailAddress(a));
  if (bad.length) out.push(`Not an email address: ${bad.join(', ')}`);
  if (!subject.trim()) out.push('Add a subject.');
  if (!body.trim()) out.push('Write the message.');
  return out;
}

/**
 * The owner's own email from the claim (docs/SUPREME-DESIGN.md §L.5): sent after a 30-second Undo, with no review —
 * unless "check before sending" is ticked. The claim reference is added to the subject by ClaimDesk.
 */
export function ComposeDialog({ open, onClose, onSent, claimId, reference, evidence, defaults }: { open: boolean; onClose: () => void; onSent?: (r: OutboxDetail) => void; claimId: string; reference: string; evidence: Evidence[]; defaults?: ComposeDefaults }) {
  const toast = useToast();
  const [to, setTo] = useState(defaults?.to ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(defaults?.subject ?? '');
  const [body, setBody] = useState(`\n\n${SIGN_OFF}`);
  const [check, setCheck] = useState(false);
  const [attach, setAttach] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const send = useMailMutation(() =>
    mailApi.compose({
      claimId,
      to: parseAddresses(to),
      ...(cc.trim() ? { cc: parseAddresses(cc) } : {}),
      subject,
      bodyText: body,
      attach: attach.map((evidenceId) => ({ evidenceId })),
      ...(defaults?.inReplyToMessageId ? { inReplyToMessageId: defaults.inReplyToMessageId } : {}),
      checkBeforeSending: check,
    }),
  );
  const problems = composeProblems(to, subject, body);

  const submit = async () => {
    setTried(true);
    if (problems.length) return;
    try {
      const r = await send.mutateAsync(undefined);
      toast.success(r.item.status === 'held' ? 'Held for 30 seconds — Undo is above the threads' : 'Sent to the reviewer — you will be asked before it goes');
      onSent?.(r);
      onClose();
    } catch {
      /* shown below */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`New email — ${reference}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={send.isPending} onClick={() => void submit()}>
            {check ? 'Check, then ask me' : 'Send (30-second undo)'}
          </Button>
        </>
      }
    >
      <div className="ob-edit">
        <TextInput label="To" value={to} onChange={setTo} placeholder="name@insurer.co.uk" required />
        <TextInput label="Cc" value={cc} onChange={setCc} />
        <TextInput label="Subject" value={subject} onChange={setSubject} hint={`${reference} is added automatically`} required />
        <TextArea label="Message" value={body} onChange={setBody} rows={12} hint={`From “${SIGN_OFF}”. Plain text; no remote images or tracking.`} />
        {evidence.length > 0 && (
          <fieldset className="mb-attachments" aria-label="Attach evidence">
            {evidence.slice(0, 40).map((e) => (
              <Checkbox key={e.id} label={`${e.filename} (${e.kind})`} checked={attach.includes(e.id)} onChange={(v) => setAttach((a) => (v ? [...a, e.id] : a.filter((x) => x !== e.id)))} />
            ))}
          </fieldset>
        )}
        <Checkbox label="Check before sending" hint="The reviewer checks it first and you approve it in Needs-you." checked={check} onChange={setCheck} />
        {tried && problems.length > 0 && (
          <ul className="ob-reasons" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <ApiErrorNotice error={send.error} what="send this email" />
      </div>
    </Modal>
  );
}
