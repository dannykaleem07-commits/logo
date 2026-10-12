// owned by claimai-web
/**
 * Preview of one AI input (docs/CLAIM-AI-INPUT.md §14.2): "I understood: …", questions first, then the lines grouped by
 * tier (Will do · Needs your tick · Goes to Needs-you · Open the screen · Private note · Won't do), what was not done,
 * what waits for the AI, and Do it / Cancel (a sticky bar on phones). Nothing is done until Do it; confirm lines are
 * never pre-ticked; money, offers, legal steps and closing only ever go to Needs-you.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { isApiError } from '../../../api/client';
import { useClaimAiMutations, type ActionEdits, type AiInputDetail } from '../../../api/claimAiApi';
import { ActionLine } from './ActionLine';
import { QuestionCard } from './QuestionCard';
import { buildApplyChoices, defaultTicks, doItCount, doItLabel, editErrors, groupActions, isStillOpen, isTicked, type Edits, type Ticks } from './aiInputModel';

/** `{key, message}` from a 400 VALIDATION / NOT_TICKABLE answer, so the message lands on its line. */
export function lineErrorOf(e: unknown): { key: string; message: string } | null {
  if (!isApiError(e)) return null;
  const d = e.details as { key?: unknown; message?: unknown } | undefined;
  if (!d || typeof d.key !== 'string') return null;
  return { key: d.key, message: typeof d.message === 'string' && d.message ? d.message : e.code === 'NOT_TICKABLE' ? 'This line cannot be ticked.' : e.message };
}

function isTyping(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return Boolean(el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox') || el.tagName === 'SELECT'));
}

export interface PreviewCardProps {
  claimId: string;
  detail: AiInputDetail;
  /** 'full' = the whole preview; 'remaining' = only the lines still waiting after a partial apply. */
  variant?: 'full' | 'remaining';
  /** Called after a successful Do it (the update box clears its draft). */
  onApplied?: (d: AiInputDetail) => void;
  onCancelled?: () => void;
  /** Label of the main button ("Do it", "File and record now"). */
  applyVerb?: string;
}

export function PreviewCard({ claimId, detail: d, variant = 'full', onApplied, onCancelled, applyVerb }: PreviewCardProps) {
  const m = useClaimAiMutations(claimId);
  const toast = useToast();
  const headingRef = useRef<HTMLSpanElement>(null);
  const lines = useMemo(() => (variant === 'remaining' ? d.actions.filter(isStillOpen) : d.actions), [d.actions, variant]);
  const [ticks, setTicks] = useState<Ticks>(() => defaultTicks(d.actions));
  const [edits, setEdits] = useState<Edits>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(d.revision);

  // A new revision (an answer, a file override, the AI came back) brings new lines: start again from the defaults.
  if (revision !== d.revision) {
    setRevision(d.revision);
    setTicks(defaultTicks(d.actions));
    setEdits({});
    setLineErrors({});
  }

  // Focus moves to "I understood" when the preview appears — unless the owner is typing somewhere (never steal focus).
  useEffect(() => {
    if (variant === 'full' && !isTyping()) headingRef.current?.focus();
  }, [d.id, d.revision, variant]);

  const groups = groupActions(lines);
  const n = doItCount(lines, ticks);
  const verb = applyVerb ?? (d.status === 'waiting_ai' ? 'Do the part I understood' : variant === 'remaining' ? 'Do these' : 'Do it');
  const busy = m.apply.isPending || m.cancel.isPending;

  const apply = () => {
    const errs = editErrors(lines, ticks, edits);
    setLineErrors(errs);
    if (Object.keys(errs).length) return;
    m.apply.mutate(
      { inputId: d.id, body: { actions: buildApplyChoices(lines, ticks, edits) } },
      {
        onSuccess: (r) => {
          toast.success(r.status === 'applied' ? 'Done — see what changed' : 'Partly done — see what changed');
          onApplied?.(r);
        },
        onError: (e) => {
          const le = lineErrorOf(e);
          if (le) setLineErrors({ [le.key]: le.message });
        },
      },
    );
  };

  const patchEdit = (key: string, p: ActionEdits) => setEdits((all) => ({ ...all, [key]: { ...all[key], ...p } }));

  const title =
    variant === 'remaining' ? (
      'Still waiting for you'
    ) : (
      <span ref={headingRef} tabIndex={-1} className="aiin-understood">
        {d.understood ? `I understood: ${d.understood}` : d.kind === 'catch_up' ? 'What I will do with the files' : 'What I will do'}
      </span>
    );

  return (
    <Card title={title} className="aiin-preview">
      <div className="stack" aria-live="polite">
        {variant === 'full' &&
          d.warnings.map((w, i) => (
            <div key={i} className="notice notice-warn">
              {w}
            </div>
          ))}
        {variant === 'full' && d.questions.length > 0 && (
          <div className="stack-sm">
            {d.questions.map((q) => (
              <QuestionCard key={q.id} question={q} busy={m.answer.isPending} onAnswer={(a) => m.answer.mutate({ inputId: d.id, answers: [a] })} />
            ))}
            <ApiErrorNotice error={m.answer.error} what="send your answer" />
          </div>
        )}
        {groups.map((g) => (
          <section key={g.tier} className="aiin-group" aria-label={g.label}>
            <h4 className="aiin-group-title">
              {g.label} <span className="xs muted">· {g.hint}</span>
            </h4>
            <ul className="aiin-lines">
              {g.actions.map((a) => (
                <ActionLine
                  key={a.key}
                  action={a}
                  mode="preview"
                  ticked={isTicked(a, ticks)}
                  onTick={(t) => setTicks((all) => ({ ...all, [a.key]: t }))}
                  edits={edits[a.key]}
                  onEdit={(p) => patchEdit(a.key, p)}
                  error={lineErrors[a.key] ?? null}
                />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && variant === 'full' && d.questions.length === 0 && d.pendingText.length === 0 && <p className="muted small">Nothing to do from this note.</p>}
        {variant === 'full' && d.notDone.length > 0 && (
          <section className="aiin-group" aria-label="Not done">
            <h4 className="aiin-group-title">Not done</h4>
            <ul className="aiin-notdone">
              {d.notDone.map((x, i) => (
                <li key={i} className="small">
                  <mark>“{x.text}”</mark> — {x.why}
                </li>
              ))}
            </ul>
          </section>
        )}
        {variant === 'full' && d.pendingText.length > 0 && (
          <div className="notice notice-info">
            <strong>Waiting for the AI:</strong>{' '}
            {d.pendingText.map((t, i) => (
              <span key={i}>
                {i > 0 && ' · '}“{t}”
              </span>
            ))}
            <div className="small">The rest is done when the AI is back; you can do the part I understood now.</div>
          </div>
        )}
        <ApiErrorNotice error={lineErrorOf(m.apply.error) ? null : m.apply.error} what="do it" />
        <ApiErrorNotice error={m.cancel.error} what="cancel" />
        <div className="aiin-bar">
          <Button variant="primary" onClick={apply} disabled={n === 0 || !d.canApply} loading={m.apply.isPending}>
            {doItLabel(n, verb)}
          </Button>
          {variant === 'full' && d.canCancel && (
            <Button
              onClick={() =>
                m.cancel.mutate(d.id, {
                  onSuccess: () => {
                    toast.push('Cancelled — nothing was changed');
                    onCancelled?.();
                  },
                })
              }
              disabled={busy}
            >
              Cancel
            </Button>
          )}
          {variant === 'full' && d.canThinkAgain && (
            <Button variant="ghost" onClick={() => m.thinkAgain.mutate(d.id)} loading={m.thinkAgain.isPending}>
              Think again
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
