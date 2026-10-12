// owned by claimai-web
/**
 * Tell ClaimDesk (docs/CLAIM-AI-INPUT.md §14.2 part B): what happened, or what ClaimDesk should do, in the owner's own
 * words; example chips; an optional pasted call note / voice-note transcript (facts only); Read it (Ctrl/Cmd+Enter).
 *
 * Focus rule: the text is local state only (never derived from polled data), the component is never re-keyed, and the
 * draft is mirrored to localStorage (try/catch) so a reload keeps it. It is cleared after a successful Do it.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useState, type KeyboardEvent } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { TextArea } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import type { CreateUpdateBody } from '../../../api/claimAiApi';
import { clearDraft, EMPTY_DRAFT, EXAMPLE_CHIPS, insertExample, loadDraft, MAX_EXTRA_CHARS, MAX_TEXT_CHARS, saveDraft, updateProblem, type UpdateDraft } from './aiInputModel';

export interface UpdateBoxHandle {
  focus: () => void;
  clear: () => void;
}

export interface UpdateBoxProps {
  claimId: string;
  aiAvailable: boolean;
  disabled?: string | null;
  busy?: boolean;
  error?: unknown;
  onSubmit: (body: CreateUpdateBody) => void;
}

export const UpdateBox = forwardRef<UpdateBoxHandle, UpdateBoxProps>(function UpdateBox({ claimId, aiAvailable, disabled, busy = false, error, onSubmit }, ref) {
  const id = useId();
  const textId = `${id}-text`;
  const [draft, setDraft] = useState<UpdateDraft>(() => loadDraft(claimId));
  const [showExtra, setShowExtra] = useState(() => draft.extra.length > 0);
  const [touched, setTouched] = useState(false);

  useImperativeHandle(ref, () => ({
    focus: () => document.getElementById(textId)?.focus(),
    clear: () => {
      setDraft({ ...EMPTY_DRAFT });
      setShowExtra(false);
      setTouched(false);
      clearDraft(claimId);
    },
  }));

  useEffect(() => {
    saveDraft(claimId, draft);
  }, [claimId, draft]);

  const problem = updateProblem(draft);
  const submit = () => {
    setTouched(true);
    if (problem || disabled || busy) return;
    const body: CreateUpdateBody = { text: draft.text, channel: draft.extra.trim() ? draft.channel : 'typed' };
    if (draft.extra.trim()) body.extraText = draft.extra;
    onSubmit(body);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Card title="Tell ClaimDesk" className="aiin-update">
      <div className="stack-sm">
        {!aiAvailable && <div className="notice notice-warn small">Agents are paused — simple updates still work; the rest waits for the AI.</div>}
        {disabled && <div className="notice notice-info small">{disabled}</div>}
        <TextArea
          id={textId}
          label="What happened, or what should ClaimDesk do?"
          value={draft.text}
          onChange={(v) => setDraft((d) => ({ ...d, text: v }))}
          onKeyDown={onKey}
          rows={4}
          maxLength={MAX_TEXT_CHARS}
          disabled={Boolean(disabled)}
          placeholder="e.g. Client called, car repaired, hire ended yesterday. Don't chase the client until Monday."
          hint="Your words are kept exactly as typed. Routine things are done after a preview; money, offers, legal steps and closing go to Needs-you."
          error={touched && problem ? problem : undefined}
        />
        <div className="aiin-examples" role="group" aria-label="Examples">
          {EXAMPLE_CHIPS.map((c) => (
            <button
              key={c.label}
              type="button"
              className="aiin-chip-toggle"
              disabled={Boolean(disabled)}
              onClick={() => {
                setDraft((d) => ({ ...d, text: insertExample(d.text, c.text) }));
                document.getElementById(textId)?.focus();
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div>
          <Button size="sm" variant="ghost" aria-expanded={showExtra} onClick={() => setShowExtra((v) => !v)} disabled={Boolean(disabled)}>
            {showExtra ? 'Hide the call note' : 'Paste a call note or voice-note transcript'}
          </Button>
        </div>
        {showExtra && (
          <div className="aiin-extra stack-sm">
            <div className="aiin-segmented" role="group" aria-label="What you are pasting">
              <button type="button" aria-pressed={draft.channel === 'call_note'} onClick={() => setDraft((d) => ({ ...d, channel: 'call_note' }))}>
                Call note
              </button>
              <button type="button" aria-pressed={draft.channel === 'voice_note'} onClick={() => setDraft((d) => ({ ...d, channel: 'voice_note' }))}>
                Voice-note transcript
              </button>
            </div>
            <TextArea
              label={draft.channel === 'voice_note' ? 'Voice-note transcript' : 'Call note'}
              value={draft.extra}
              onChange={(v) => setDraft((d) => ({ ...d, extra: v }))}
              onKeyDown={onKey}
              rows={5}
              maxLength={MAX_EXTRA_CHARS}
              hint="Used for facts only — instructions come from what you type above."
            />
          </div>
        )}
        <ApiErrorNotice error={error} what="read your update" />
        <div className="row-between aiin-update-foot">
          <span className="xs muted">Ctrl+Enter reads it</span>
          <Button variant="primary" onClick={submit} loading={busy} disabled={Boolean(disabled)}>
            Read it
          </Button>
        </div>
      </div>
    </Card>
  );
});
