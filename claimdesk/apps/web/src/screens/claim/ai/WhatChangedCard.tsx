// owned by claimai-web
/**
 * What changed (docs/CLAIM-AI-INPUT.md §14.2): after Do it — the summary lines with links, clock changes, the
 * Autopilot's first steps after the re-plan, then every line with what happened to it, per-line Undo / Try again and
 * Undo all (with a confirm). Undo is never time travel: events are corrected by new entries, filed evidence stays.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Modal } from '../../../components/Modal';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { useClaimAiMutations, type AiInputDetail } from '../../../api/claimAiApi';
import { ActionLine } from './ActionLine';
import { canUndoLine, compareKeys, groupWhatChanged, withoutLabel } from './aiInputModel';

function LineText({ text, link }: { text: string; link: string | null }) {
  if (!link) return <>{text}</>;
  if (/^https?:/i.test(link)) return <>{text}</>;
  return <Link to={link}>{text}</Link>;
}

export function WhatChangedCard({ claimId, detail: d, onDone }: { claimId: string; detail: AiInputDetail; onDone?: () => void }) {
  const m = useClaimAiMutations(claimId);
  const toast = useToast();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const groups = groupWhatChanged(d.whatChanged);
  const done = d.actions.filter((a) => a.state !== 'proposed').sort((a, b) => compareKeys(a.key, b.key));
  const undoable = done.filter(canUndoLine);
  const w = d.whatChanged;

  const undo = (keys?: string[]) => {
    setBusyKey(keys?.[0] ?? '*');
    m.undo.mutate(
      { inputId: d.id, body: keys ? { actionKeys: keys } : {} },
      {
        onSuccess: (r) => {
          setConfirmAll(false);
          const failed = r.actions.filter((a) => keys?.includes(a.key) && a.state !== 'undone');
          if (failed.length) toast.warn(failed[0]!.result?.message ?? 'Not undone');
          else toast.success(keys ? 'Undone' : 'Everything that could be undone was undone');
        },
        onSettled: () => setBusyKey(null),
      },
    );
  };
  const retry = (key: string) => {
    setBusyKey(key);
    m.apply.mutate({ inputId: d.id, body: { actions: [{ key, ticked: true }] } }, { onSettled: () => setBusyKey(null) });
  };

  return (
    <Card
      title="What changed"
      className="aiin-changed"
      actions={
        <>
          {d.canUndo && undoable.length > 0 && (
            <Button size="sm" onClick={() => setConfirmAll(true)}>
              Undo all
            </Button>
          )}
          {onDone && (
            <Button size="sm" variant="ghost" onClick={onDone}>
              Close
            </Button>
          )}
        </>
      }
    >
      <div className="stack" aria-live="polite">
        {groups.length === 0 && !w?.clocks.length && <p className="small muted">{d.status === 'undone' ? 'Everything from this note was undone.' : 'Nothing changed on the claim.'}</p>}
        {groups.map((g) => (
          <section key={`${g.kind}-${g.label}`} className="aiin-group" aria-label={g.label}>
            <h4 className="aiin-group-title">{g.label}</h4>
            <ul className={`aiin-changed-lines aiin-changed-${g.kind}`}>
              {g.lines.map((l, i) => (
                <li key={i}>
                  <LineText text={l.text} link={l.link} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {w && w.clocks.length > 0 && (
          <section className="aiin-group" aria-label="Clocks">
            <h4 className="aiin-group-title">Clocks</h4>
            <ul className="aiin-clocks">
              {w.clocks.map((c, i) => (
                <li key={i}>
                  <span className="strong">{c.label}</span>{' '}
                  <span className="small">
                    {c.before && withoutLabel(c.before, c.label) !== withoutLabel(c.after, c.label) ? (
                      <>
                        <span className="muted">{withoutLabel(c.before, c.label)}</span> → {withoutLabel(c.after, c.label)}
                      </>
                    ) : (
                      withoutLabel(c.after, c.label)
                    )}
                  </span>{' '}
                  <Badge tone={/breach|overdue|missed/i.test(c.status) ? 'red' : /met|done/i.test(c.status) ? 'green' : 'blue'}>{c.status.replace(/_/g, ' ')}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
        {w?.autopilot && (w.autopilot.stopped || w.autopilot.firstSteps.length > 0) && (
          <section className="aiin-group" aria-label="Autopilot">
            <h4 className="aiin-group-title">
              Autopilot <Link className="xs" to={`/claims/${encodeURIComponent(claimId)}/autopilot`}>open</Link>
            </h4>
            {w.autopilot.stopped && <div className="notice notice-warn small">{w.autopilot.stopped}</div>}
            <ol className="aiin-steps">
              {w.autopilot.firstSteps.map((s) => (
                <li key={s.id}>
                  <span className="strong">{s.title}</span> <span className="small muted">{withoutLabel(s.sentence, s.title)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {done.length > 0 && (
          <details className="aiin-did" open={done.some((a) => a.state === 'failed')}>
            <summary className="small strong">What each line did ({done.length})</summary>
            <ul className="aiin-lines">
              {done.map((a) => (
                <ActionLine key={a.key} action={a} mode="result" busy={busyKey === a.key} onUndo={() => undo([a.key])} onRetry={() => retry(a.key)} />
              ))}
            </ul>
          </details>
        )}
        <ApiErrorNotice error={m.undo.error} what="undo" />
        <ApiErrorNotice error={m.apply.error} what="try again" />
      </div>
      <Modal
        open={confirmAll}
        title="Undo everything from this note?"
        onClose={() => setConfirmAll(false)}
        footer={
          <>
            <Button onClick={() => setConfirmAll(false)}>Keep it</Button>
            <Button variant="danger" loading={busyKey === '*'} onClick={() => undo()}>
              Undo all ({undoable.length})
            </Button>
          </>
        }
      >
        <p>
          Each line is undone the safe way: chronology entries get a correcting entry (the original stays visible, struck through), a hire end is re-opened, reminders are
          cancelled and standing instructions are removed. Filed documents stay on file.
        </p>
        <p className="small muted">A line is left as it is when something changed it since (you will see why on the line).</p>
      </Modal>
    </Card>
  );
}
