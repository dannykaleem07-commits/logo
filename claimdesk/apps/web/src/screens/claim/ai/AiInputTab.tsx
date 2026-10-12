// owned by claimai-web
/**
 * The claim's AI input tab (docs/CLAIM-AI-INPUT.md §14.2): /claims/:id/ai.
 *
 *   ≥ 960 px: left — Tell ClaimDesk + the preview / What changed; right — Catch-up documents + Standing instructions;
 *   History full width below. Narrower: one column in that order. At 390 px nothing scrolls sideways, lines stack as
 *   cards and Do it / Cancel sit in a sticky bar.
 *
 * Focus rule: polling never re-keys or remounts the text areas — the update box reads no polled data except whether the
 * AI is available, and the input being shown is a sibling component.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Spinner } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useAiInput, useAiInputPanel, useClaimAiMutations, type AiInputDetail, type AiInputSummary } from '../../../api/claimAiApi';
import type { ClaimView } from '../claimFile';
import { UpdateBox, type UpdateBoxHandle } from './UpdateBox';
import { PreviewCard } from './PreviewCard';
import { WhatChangedCard } from './WhatChangedCard';
import { CatchUpCard } from './CatchUpCard';
import { InstructionsCard } from './InstructionsCard';
import { HistoryCard } from './HistoryCard';
import { CLOSED_CLAIM_STATUSES, isStillOpen, PREVIEW_STATUSES, RESULT_STATUSES, waitingText } from './aiInputModel';
import './aiInput.css';

function YourWords({ d }: { d: AiInputDetail }) {
  if (!d.text && !d.extraText) return null;
  return (
    <details className="aiin-yourwords">
      <summary className="small muted">Your words{d.extraText ? ' and the pasted note' : ''}</summary>
      {d.text && <blockquote className="aiin-owner-text">{d.text}</blockquote>}
      {d.extraText && (
        <>
          <div className="xs muted">Pasted note (used for facts only)</div>
          <blockquote className="aiin-owner-text">{d.extraText}</blockquote>
        </>
      )}
    </details>
  );
}

/** One update input, shown by status: reading → preview / question → doing it → what changed. */
export function UpdateInputView({ claimId, inputId, onClose, onApplied }: { claimId: string; inputId: string; onClose: () => void; onApplied: (d: AiInputDetail) => void }) {
  const q = useAiInput(claimId, inputId);
  const m = useClaimAiMutations(claimId);
  const d = q.data;
  if (q.isLoading) {
    return (
      <Card title="Your update">
        <p className="small muted">Loading…</p>
      </Card>
    );
  }
  if (q.error || !d) return <ApiErrorNotice error={q.error} what="load your update" />;

  const waiting = d.status === 'waiting_ai' && d.waiting ? <div className="notice notice-warn small">Waiting for the AI: {waitingText(d.waiting)}. It carries on by itself when the AI is back.</div> : null;
  switch (d.status) {
    case 'interpreting':
      return (
        <Card title="Reading your note…" className="aiin-reading">
          <div className="stack-sm" aria-live="polite" aria-busy="true">
            <div className="row">
              <Spinner /> <span className="small muted">Reading your note…</span>
            </div>
            <div className="aiin-skeleton" />
            <div className="aiin-skeleton aiin-skeleton-short" />
            <YourWords d={d} />
          </div>
        </Card>
      );
    case 'applying':
      return (
        <Card title="Doing it…">
          <div className="row" aria-live="polite" aria-busy="true">
            <Spinner /> <span className="small muted">Each line goes through the same checks as a click on its own screen.</span>
          </div>
        </Card>
      );
    case 'nothing_to_do':
      return (
        <Card title="Nothing to do" actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
          <div className="stack-sm">
            <p className="small">ClaimDesk did not find anything to record or do in this note. It is kept in the history.</p>
            {d.notDone.map((x, i) => (
              <div key={i} className="small">
                <mark>“{x.text}”</mark> — {x.why}
              </div>
            ))}
            <YourWords d={d} />
          </div>
        </Card>
      );
    case 'cancelled':
      return (
        <Card title="Cancelled" actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
          <p className="small muted">Nothing was changed. The note is kept in the history.</p>
        </Card>
      );
    default:
      break;
  }

  if (RESULT_STATUSES.has(d.status)) {
    const remaining = d.status === 'partly_applied' && d.canApply && d.actions.some(isStillOpen);
    return (
      <div className="stack">
        <WhatChangedCard claimId={claimId} detail={d} onDone={onClose} />
        {d.pendingText.length > 0 && (
          <div className="notice notice-info small">
            Still waiting for the AI: {d.pendingText.map((t) => `“${t}”`).join(' · ')}
          </div>
        )}
        {remaining && <PreviewCard claimId={claimId} detail={d} variant="remaining" onApplied={onApplied} />}
      </div>
    );
  }

  if (d.status === 'failed') {
    return (
      <div className="stack">
        <div className="notice notice-danger">
          The AI could not read the rest of your note.{d.actions.length === 0 && d.warnings.length > 0 ? ` ${d.warnings.join(' ')}` : ''}{' '}
          {d.canThinkAgain && (
            <Button size="sm" onClick={() => m.thinkAgain.mutate(d.id)} loading={m.thinkAgain.isPending}>
              Think again
            </Button>
          )}
        </div>
        {d.actions.length > 0 && <PreviewCard claimId={claimId} detail={d} onApplied={onApplied} onCancelled={onClose} />}
        <ApiErrorNotice error={m.thinkAgain.error} what="ask the AI again" />
      </div>
    );
  }

  if (PREVIEW_STATUSES.has(d.status)) {
    return (
      <div className="stack">
        {waiting}
        <PreviewCard claimId={claimId} detail={d} onApplied={onApplied} onCancelled={onClose} />
        <YourWords d={d} />
      </div>
    );
  }
  return null;
}

/** The newest input of a kind that still needs the owner. */
export function newestOpen(open: readonly AiInputSummary[] | undefined, kind: AiInputSummary['kind']): string | null {
  const xs = (open ?? []).filter((i) => i.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return xs[0]?.id ?? null;
}

export function AiInputTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const reference = view.claim.reference;
  const [search] = useSearchParams();
  const location = useLocation();
  const panel = useAiInputPanel(claimId);
  const m = useClaimAiMutations(claimId);
  const boxRef = useRef<UpdateBoxHandle>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // undefined = not chosen (show the newest open one); null = none.
  const [updateSel, setUpdateSel] = useState<string | null | undefined>(() => search.get('input') ?? undefined);
  const [catchSel, setCatchSel] = useState<string | null | undefined>(() => search.get('catchup') ?? undefined);
  const closed = CLOSED_CLAIM_STATUSES.has(view.claim.status);
  const disabled = closed ? 'This claim is closed. AI input is for open claims — reopen it from the status menu first.' : null;

  // The header button opens the tab with ?focus=update: focus the box (every time it is pressed).
  const focusParam = search.get('focus');
  useEffect(() => {
    if (focusParam === 'update' && !closed) boxRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const shownUpdate = updateSel !== undefined ? updateSel : newestOpen(panel.data?.open, 'update');
  const shownCatchUp = catchSel !== undefined ? catchSel : newestOpen(panel.data?.open, 'catch_up');
  const aiAvailable = panel.data?.ai.available ?? true;

  // Pin what is on screen: once an input is shown it stays shown after Do it (an applied input leaves the open list).
  useEffect(() => {
    if (updateSel === undefined && shownUpdate) setUpdateSel(shownUpdate);
  }, [updateSel, shownUpdate]);
  useEffect(() => {
    if (catchSel === undefined && shownCatchUp) setCatchSel(shownCatchUp);
  }, [catchSel, shownCatchUp]);

  const openFromHistory = (i: AiInputSummary) => {
    if (i.kind === 'catch_up') setCatchSel(i.id);
    else {
      setUpdateSel(i.id);
      viewRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  };

  return (
    <div className="aiin-tab">
      {panel.error && <ApiErrorNotice error={panel.error} what="load the AI input panel" />}
      <div className="aiin-grid">
        <div className="aiin-col aiin-col-main" ref={viewRef}>
          <UpdateBox
            ref={boxRef}
            claimId={claimId}
            aiAvailable={aiAvailable}
            disabled={disabled}
            busy={m.createUpdate.isPending}
            error={m.createUpdate.error}
            onSubmit={(body) => m.createUpdate.mutate(body, { onSuccess: (d) => setUpdateSel(d.id) })}
          />
          {shownUpdate && <UpdateInputView claimId={claimId} inputId={shownUpdate} onClose={() => setUpdateSel(null)} onApplied={() => boxRef.current?.clear()} />}
        </div>
        <div className="aiin-col aiin-col-side">
          <CatchUpCard claimId={claimId} reference={reference} inputId={shownCatchUp} onSelect={(id) => setCatchSel(id)} disabled={disabled} />
          <InstructionsCard claimId={claimId} instructions={panel.data?.instructions ?? []} disabled={closed} onOpenInput={(id) => setUpdateSel(id)} />
        </div>
      </div>
      <HistoryCard claimId={claimId} onOpen={openFromHistory} />
    </div>
  );
}
