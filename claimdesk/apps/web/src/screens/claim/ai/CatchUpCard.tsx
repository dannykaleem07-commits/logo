// owned by claimai-web
/**
 * Catch-up documents (docs/CLAIM-AI-INPUT.md §8, §14.2 part A): letters the owner sent or received outside ClaimDesk,
 * or documents from before the claim was opened. Dropping files starts a catch-up (a smart-intake bundle with this claim
 * fixed) and uploads them with the case-bundle upload queue (batches, chunked large files, the import-folder hint).
 * When the queue drains, files-done is posted. Each file is read, dated from its content, de-duplicated and planned;
 * with "Apply automatically" on, routine filing and records happen by themselves; the rest waits for a tick here
 * ("File and record now"). Then What changed.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Checkbox, TextArea } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useBundleProgress } from '../../../api/bundlesApi';
import { claimAiKeys, useAiInput, useClaimAiMutations, type AiInputDetail } from '../../../api/claimAiApi';
import { DropArea, UploadRows, useQueueRows } from '../../intake/bundles/UploadPanel';
import { uploadQueueFor, type UploadQueue } from '../../intake/bundles/uploadQueue';
import { CatchUpFiles } from './CatchUpFiles';
import { PreviewCard } from './PreviewCard';
import { WhatChangedCard } from './WhatChangedCard';
import { isStillOpen, PREVIEW_STATUSES, RESULT_STATUSES, STATUS_TONE, statusLabel, waitingText } from './aiInputModel';
import '../../intake/bundles/bundles.css';

export function catchUpName(reference: string, now: Date = new Date()): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `Catch-up ${reference || 'claim'} ${day}`;
}

/**
 * Queue the files, wait for the queue to drain, then say files-done (only when something reached the server). Waiting on
 * the queue itself (not on a component's render) means a page switch mid-upload cannot lose the files-done call.
 */
export async function sendThenDone(queue: UploadQueue, files: File[], done: () => void): Promise<void> {
  await queue.add(files);
  await queue.idle();
  if (queue.getSnapshot().some((r) => r.status === 'sent')) done();
}

/** Uploads into an existing catch-up: the queue rows, server progress, and files-done once the queue drains. */
function Uploads({ claimId, detail, reference }: { claimId: string; detail: AiInputDetail; reference: string }) {
  const qc = useQueryClient();
  const m = useClaimAiMutations(claimId);
  const bundleId = detail.catchUp!.bundleId;
  const queue = uploadQueueFor(bundleId, catchUpName(reference));
  const rows = useQueueRows(queue);
  const reading = detail.catchUp?.readiness === 'reading';
  const progress = useBundleProgress(bundleId, reading && rows.length > 0);

  useEffect(() => {
    queue.setOnServerChange(() => {
      void qc.invalidateQueries({ queryKey: claimAiKeys.input(claimId, detail.id) });
    });
    return () => queue.setOnServerChange(null);
  }, [queue, qc, claimId, detail.id]);

  const applied = detail.catchUp?.readiness === 'applied' || detail.status === 'applied';
  return (
    <div className="stack-sm">
      {!applied && (
        <DropArea onFiles={(files) => void sendThenDone(queue, files, () => m.filesDone.mutate(detail.id))} compact>
          <div className="xs muted">
            Very large files: put them in the import folder <span className="mono">inbox\intake\{catchUpName(reference)}\</span>.
          </div>
        </DropArea>
      )}
      <UploadRows queue={queue} rows={rows} progress={progress.data} />
      <ApiErrorNotice error={m.filesDone.error} what="finish the upload" />
    </div>
  );
}

function CatchUpDetail({ claimId, inputId, reference, onNew, onApplied }: { claimId: string; inputId: string; reference: string; onNew: () => void; onApplied?: () => void }) {
  const q = useAiInput(claimId, inputId);
  const m = useClaimAiMutations(claimId);
  const d = q.data;
  if (q.isLoading) return <p className="small muted">Loading the catch-up…</p>;
  if (q.error || !d) return <ApiErrorNotice error={q.error} what="load the catch-up" />;
  const c = d.catchUp;
  const counts = c?.fileCounts;
  const showPreview = d.canApply && PREVIEW_STATUSES.has(d.status);
  const showResult = RESULT_STATUSES.has(d.status);
  const remaining = d.status === 'partly_applied' && d.canApply && d.actions.some(isStillOpen);
  return (
    <div className="stack">
      <div className="row-between">
        <span className="row">
          <Badge tone={STATUS_TONE[d.status] ?? 'grey'}>{statusLabel(d)}</Badge>
          {counts && (
            <span className="small muted">
              {counts.read}/{counts.total} read{counts.inProgress ? ` · ${counts.inProgress} reading` : ''}
              {counts.waitingAi ? ` · ${counts.waitingAi} waiting for the AI` : ''}
              {counts.failed ? ` · ${counts.failed} could not be read` : ''}
              {counts.duplicates ? ` · ${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'}` : ''}
            </span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onNew}>
          New catch-up
        </Button>
      </div>
      {d.waiting && <div className="notice notice-warn small">Some files wait for the AI: {waitingText(d.waiting)}. Everything is filed; the rest is recorded when the AI is back or when you decide.</div>}
      {c?.note && <div className="small">Your note: {c.note}</div>}
      {c && !showResult && (
        <Checkbox
          label="Apply automatically when read"
          checked={c.autoApply}
          disabled={m.setAutoApply.isPending}
          onChange={(v) => m.setAutoApply.mutate({ inputId: d.id, autoApply: v })}
          hint="Files everything and records the letters ClaimDesk is sure about; anything unclear waits for you."
        />
      )}
      {c && <Uploads claimId={claimId} detail={d} reference={reference} />}
      {c && c.files.length > 0 && <CatchUpFiles claimId={claimId} inputId={d.id} bundleId={c.bundleId} files={c.files} />}
      {c && c.willDo.length > 0 && !showResult && (
        <div className="aiin-willdo">
          <h4 className="aiin-group-title">What I will do</h4>
          <ul>
            {c.willDo.map((w, i) => (
              <li key={i} className="small">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c &&
        c.blockers.map((b, i) => (
          <div key={`${b.code}-${i}`} className="notice notice-warn small">
            {b.text}
          </div>
        ))}
      {showPreview && <PreviewCard claimId={claimId} detail={d} applyVerb="File and record now" onApplied={onApplied} />}
      {showResult && <WhatChangedCard claimId={claimId} detail={d} />}
      {remaining && <PreviewCard claimId={claimId} detail={d} variant="remaining" applyVerb="File and record now" onApplied={onApplied} />}
      <ApiErrorNotice error={m.setAutoApply.error} what="change Apply automatically" />
    </div>
  );
}

export interface CatchUpCardProps {
  claimId: string;
  reference: string;
  /** The catch-up shown (null = start a new one). */
  inputId: string | null;
  onSelect: (inputId: string | null) => void;
  disabled?: string | null;
  onApplied?: () => void;
}

export function CatchUpCard({ claimId, reference, inputId, onSelect, disabled, onApplied }: CatchUpCardProps) {
  const m = useClaimAiMutations(claimId);
  const [note, setNote] = useState('');
  const [autoApply, setAutoApply] = useState(true);
  const start = (files: File[]) => {
    if (!files.length || m.createCatchUp.isPending) return;
    m.createCatchUp.mutate(
      { note, autoApply },
      {
        onSuccess: (d) => {
          if (!d.catchUp) return;
          const id = d.id;
          void sendThenDone(uploadQueueFor(d.catchUp.bundleId, catchUpName(reference)), files, () => m.filesDone.mutate(id));
          setNote('');
          onSelect(d.id);
        },
      },
    );
  };
  return (
    <Card title="Catch-up documents" className="aiin-catchup">
      <div className="stack-sm">
        <p className="small muted">Letters you sent or received outside ClaimDesk, or documents from before the claim was opened. Each is read, dated from the document itself, checked against what is already on file, and filed in the right place.</p>
        {disabled && <div className="notice notice-info small">{disabled}</div>}
        {inputId ? (
          <CatchUpDetail claimId={claimId} inputId={inputId} reference={reference} onNew={() => onSelect(null)} onApplied={onApplied} />
        ) : (
          !disabled && (
            <>
              <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={2000} placeholder="e.g. Letters posted before the claim was opened" />
              <Checkbox label="Apply automatically when read" checked={autoApply} onChange={setAutoApply} hint="Routine filing and records happen by themselves; anything unclear waits for you." />
              <DropArea onFiles={start} disabled={m.createCatchUp.isPending} />
              <ApiErrorNotice error={m.createCatchUp.error} what="start the catch-up" />
            </>
          )
        )}
      </div>
    </Card>
  );
}
