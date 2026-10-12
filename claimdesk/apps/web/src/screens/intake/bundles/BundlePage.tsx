// owned by intake-web
/**
 * Case bundle page (docs/SMART-INTAKE.md §11.4). The files dropped together, sorted into cases with the reasons, one
 * reconciled draft claim with conflicts and provenance, missing documents with the prepared request, the proposed
 * chronology, photos and what is worth a look (owner only). Register claim creates the claim in one click; Attach
 * files everything on an existing claim instead. After registering the page shows the case brief.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { TextArea } from '../../../components/Form';
import { Modal } from '../../../components/Modal';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import {
  bundleKeys,
  detailIsStale,
  useBundle,
  useBundleBrief,
  useBundleMutations,
  useBundleProgress,
  type BundleDetail,
  type BundleGroup,
  type DraftField,
  type FieldSource,
  type RegisterResult,
} from '../../../api/bundlesApi';
import { FilesBoard, type FilesBoardActions } from './FilesBoard';
import { ConflictsPanel } from './ConflictsPanel';
import { DraftPanel, type DraftActions } from './DraftPanel';
import { ChecklistCard } from './ChecklistCard';
import { TimelineCard } from './TimelineCard';
import { RiskPanel } from './RiskPanel';
import { PhotoStrip } from './PhotoStrip';
import { RegisterDialog } from './RegisterDialog';
import { AttachDialog } from './AttachDialog';
import { CaseBriefView } from './CaseBriefView';
import { ProvenanceDrawer, type ProvenanceTarget } from './ProvenanceDrawer';
import { DropArea, UploadRows, useQueueRows } from './UploadPanel';
import { existingUploadQueue, importFolderHint, uploadQueueFor, type UploadQueue } from './uploadQueue';
import { ReadinessBadge } from './bundleParts';
import { firstBlockerText, groupsText, mainClaimMatch, readingsOf, reasoningChip, signalsText } from './bundleModel';
import './bundles.css';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The bundle name as a heading you can type into; saved on Enter or when you leave the field. */
function NameEditor({ name, onSave, disabled }: { name: string; onSave: (name: string) => void; disabled: boolean }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setValue(name);
  }, [name]);
  const cancelled = useRef(false);
  const commit = () => {
    // Escape: the blur that follows must not save what was typed
    if (cancelled.current) {
      cancelled.current = false;
      setValue(name);
      return;
    }
    const v = value.trim();
    if (!v) setValue(name);
    else if (v !== name) onSave(v);
  };
  return (
    <input
      ref={ref}
      className="bdl-name-input"
      aria-label="Bundle name"
      value={value}
      maxLength={120}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setValue(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function CancelDialog({ open, onClose, onCancel }: { open: boolean; onClose: () => void; onCancel: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;
  return (
    <Modal
      open={open}
      title="Cancel this bundle"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCancel(reason.trim());
                onClose();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel bundle
          </Button>
        </>
      }
    >
      <p className="small">The files stay stored and the bundle can be reopened.</p>
      <TextArea label="Why?" value={reason} onChange={setReason} rows={3} autoFocus />
      <ApiErrorNotice error={error} what="cancel the bundle" />
    </Modal>
  );
}

function LiabilityCard({ detail }: { detail: BundleDetail }) {
  const l = detail.liability;
  return (
    <Card title="Liability guide">
      <p className="small muted">Liability is your decision. This is a guide from the documents.</p>
      {l.score !== null ? (
        <div>
          Score <strong>{l.score}</strong>
          {l.band ? ` (${l.band})` : ''}
        </div>
      ) : (
        <p className="small">Not enough about the accident yet.</p>
      )}
      {l.reasons.length > 0 && (
        <ul className="small">
          {l.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {l.statements.map((s, i) => (
        <blockquote key={i} className="bdl-quote small">
          “{s.text}” <span className="muted">— {s.source.docTypeLabel ?? s.source.filename}</span>
        </blockquote>
      ))}
      {l.note && <div className="xs muted">{l.note}</div>}
    </Card>
  );
}

function RegisteredView({ result, detail }: { result: RegisterResult; detail: BundleDetail | undefined }) {
  return (
    <div className="stack">
      <div className="notice notice-success" role="status">
        Registered <Link to={`/claims/${encodeURIComponent(result.claim.id)}`}>{result.claim.reference}</Link> — {result.filed.evidence} documents filed
        {result.filed.duplicatesSkipped ? ` (${result.filed.duplicatesSkipped} copies not filed twice)` : ''}, {result.events} chronology entries.
        {result.splitOff.map((b) => (
          <span key={b.id}>
            {' '}
            <Link to={`/intake/bundles/${encodeURIComponent(b.id)}`}>{b.name}</Link> is now its own bundle.
          </span>
        ))}
        {result.attached.map((a) => (
          <span key={a.claimId}>
            {' '}
            {a.files} {a.files === 1 ? 'file' : 'files'} filed on <Link to={`/claims/${encodeURIComponent(a.claimId)}`}>{a.reference}</Link>.
          </span>
        ))}
      </div>
      {result.error && <div className="notice notice-warn">Some steps did not finish: {result.error}. Use “Finish registering” on the bundle to try them again.</div>}
      <CaseBriefView brief={result.brief} />
      {detail && <p className="small muted">Bundle “{detail.name}”.</p>}
    </div>
  );
}

export function BundlePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const detailQ = useBundle(id);
  const d = detailQ.data;
  const closed = d ? d.status === 'registered' || d.status === 'attached' || d.status === 'cancelled' : false;
  const progressQ = useBundleProgress(id, Boolean(d) && !closed);
  const briefQ = useBundleBrief(id, d?.status === 'registered' || d?.status === 'attached');
  const m = useBundleMutations(id);
  const [queue, setQueue] = useState<UploadQueue | undefined>(() => existingUploadQueue(id));
  const rows = useQueueRows(queue);
  const [registered, setRegistered] = useState<RegisterResult | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [attach, setAttach] = useState<{ claimId?: string; groupKey?: string } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [prov, setProv] = useState<ProvenanceTarget | null>(null);

  useEffect(() => setQueue(existingUploadQueue(id)), [id]);
  useEffect(() => {
    if (!queue) return;
    queue.setOnServerChange(() => {
      void qc.invalidateQueries({ queryKey: bundleKeys.progress(id) });
      void qc.invalidateQueries({ queryKey: bundleKeys.detail(id) });
    });
    return () => queue.setOnServerChange(null);
  }, [queue, qc, id]);

  // Refetch the detail when the cheap progress shows a newer revision.
  const pb = progressQ.data?.bundle;
  useEffect(() => {
    if (detailIsStale(d, pb)) void detailQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pb?.revision, pb?.computedRevision]);

  const busy = m.move.isPending || m.exclude.isPending || m.choose.isPending || m.acceptPreselected.isPending || m.tick.isPending || m.ack.isPending || m.setField.isPending;
  const onErr = (what: string) => (e: unknown) => toast.error(`Could not ${what}: ${errorMessage(e)}`);

  const addFiles = (files: File[]) => {
    if (!d || !files.length) return;
    const q = queue ?? uploadQueueFor(id, d.name);
    if (!queue) setQueue(q);
    void q.add(files).catch(onErr('add the files'));
  };

  const openSource = (title: string, source: FieldSource, readings: ProvenanceTarget['readings'] = []) => setProv({ title, source, readings });

  const boardActions: FilesBoardActions = {
    move: (fileId, groupKey) => m.move.mutate({ fileId, groupKey }, { onError: onErr('move the file') }),
    exclude: (fileId, excluded) => m.exclude.mutate({ fileId, excluded }, { onError: onErr(excluded ? 'leave the file out' : 'include the file') }),
    unsplit: (fileId) => m.unsplit.mutate(fileId, { onError: onErr('keep the scan as one document') }),
    fileCopy: (fileId) => m.fileCopy.mutate(fileId, { onSuccess: () => toast.success('Copy filed on the claim.'), onError: onErr('file the copy') }),
    splitOff: (g: BundleGroup) =>
      m.splitOff.mutate(
        { groupKey: g.key, ...(g.suggestedName ? { name: g.suggestedName } : {}) },
        {
          onSuccess: (r) => toast.success(`“${r.bundle.name}” is now its own bundle.`),
          onError: onErr('make a separate bundle'),
        },
      ),
    attachGroup: (g: BundleGroup) => setAttach({ ...(g.claim ? { claimId: g.claim.id } : {}), groupKey: g.key }),
  };

  const draftActions: DraftActions = {
    setField: (key, value, note) => m.setField.mutateAsync({ key, value, ...(note ? { note } : {}) }),
    setWitnesses: (witnesses, answered) => m.setWitnesses.mutateAsync({ witnesses, answered }),
    linkParty: (partyId) => m.linkParty.mutate(partyId, { onError: onErr('link the client record') }),
    openSource: (field: DraftField, s: FieldSource) => openSource(field.label, s, readingsOf(field)),
  };

  const match = useMemo(() => (d ? mainClaimMatch(d) : null), [d]);

  if (detailQ.isLoading) return <Loading />;
  if (detailQ.error || !d) return <div className="page"><ApiErrorNotice error={detailQ.error ?? new Error('Not found')} what="load this bundle" /></div>;

  if (registered) {
    return (
      <div className="page bdl-page">
        <div className="page-header">
          <div>
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/intake">Intake</Link> / {d.name}
            </nav>
            <h1>{d.name}</h1>
          </div>
        </div>
        <RegisteredView result={registered} detail={d} />
      </div>
    );
  }

  const chip = reasoningChip(d.reasoning);
  const blockerText = firstBlockerText(d.register.blockers);
  const accidentAt = d.draft.fields.find((f) => f.key === 'accident.occurredAt')?.value ?? null;
  const signalCount = signalsText(d.signals.reduce((a, s) => (s.acknowledged ? a : s.severity === 'warn' ? { ...a, warn: a.warn + 1 } : { ...a, info: a.info + 1 }), { warn: 0, info: 0 }));

  return (
    <div className="page bdl-page">
      <div className="page-header">
        <div className="bdl-head">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to="/intake">Intake</Link> / case bundle{d.source === 'folder' && d.folderKey ? ` · from the folder ${importFolderHint(d.folderKey)}` : ''}
          </nav>
          <h1 className="bdl-title">
            <NameEditor name={d.name} disabled={closed} onSave={(name) => m.rename.mutate(name, { onError: onErr('rename the bundle') })} />
          </h1>
          <div className="row bdl-chips">
            <ReadinessBadge bundle={d} />
            <Badge tone={chip.tone} title={chip.title}>
              {chip.label}
            </Badge>
            <span className="small muted">{groupsText(d.groups)}</span>
            {signalCount && <Badge tone="amber">{signalCount}</Badge>}
          </div>
        </div>
        <div className="actions bdl-actions">
          {!closed && (
            <>
              <span title={blockerText ?? undefined}>
                <Button variant="primary" disabled={!d.register.canRegister} onClick={() => setRegisterOpen(true)}>
                  Register claim
                </Button>
              </span>
              <Button onClick={() => setAttach({})}>Attach to existing claim…</Button>
              <Button
                variant="ghost"
                loading={m.wizardDraft.isPending}
                onClick={() => m.wizardDraft.mutate(undefined, { onSuccess: (draft) => navigate(`/claims/new?intakeDraft=${encodeURIComponent(draft.id)}`), onError: onErr('open the New claim wizard') })}
              >
                Open in New claim wizard
              </Button>
              <Button variant="ghost" loading={m.thinkAgain.isPending} onClick={() => m.thinkAgain.mutate(undefined, { onSuccess: () => toast.success('The AI will read the files together again.'), onError: onErr('ask the AI again') })}>
                Think again
              </Button>
              <Button variant="ghost" onClick={() => setCancelOpen(true)}>
                Cancel bundle
              </Button>
            </>
          )}
          {d.status === 'cancelled' && (
            <Button onClick={() => m.reopen.mutate(undefined, { onError: onErr('reopen the bundle') })} loading={m.reopen.isPending}>
              Reopen
            </Button>
          )}
          {d.status === 'registered' && d.error && (
            <Button variant="primary" loading={m.registerRetry.isPending} onClick={() => m.registerRetry.mutate(undefined, { onSuccess: (r) => setRegistered(r), onError: onErr('finish registering') })}>
              Finish registering
            </Button>
          )}
          {d.claim && (
            <Link className="btn btn-secondary" to={`/claims/${encodeURIComponent(d.claim.id)}`}>
              Open {d.claim.reference}
            </Link>
          )}
        </div>
      </div>

      <div className="stack">
        {d.reasoning.status === 'waiting_ai' && !closed && (
          <div className="notice notice-warn" role="status">
            Agents are paused — this draft is from the documents’ text; the AI will check it when they are back.
          </div>
        )}
        {d.error && <div className="notice notice-warn">{d.error}</div>}
        {match && !closed && (
          <div className="notice notice-info bdl-banner" id="bundle-match">
            <span>
              This looks like <strong>{match.reference}</strong>
              {match.reasons.length ? ` — ${match.reasons.slice(0, 2).join('; ')}` : ''}.
            </span>
            <span className="row">
              <Button size="sm" onClick={() => setAttach(match.claimId ? { claimId: match.claimId, groupKey: 'main' } : { groupKey: 'main' })}>
                Attach instead
              </Button>
              <Button size="sm" variant="ghost" onClick={() => m.confirmNew.mutate(undefined, { onError: onErr('confirm a new claim') })}>
                It’s a new claim
              </Button>
            </span>
          </div>
        )}

        {closed && briefQ.data && <CaseBriefView brief={briefQ.data} />}

        {!closed && (
          <Card title="Add files">
            <DropArea onFiles={addFiles} compact={d.fileCounts.total > 0}>
              <div className="small muted">Very large files: put them in {importFolderHint(d.name)} and they join this bundle.</div>
            </DropArea>
            {queue && <UploadRows queue={queue} rows={rows} progress={progressQ.data} />}
          </Card>
        )}

        <Card title={`Files & cases (${d.fileCounts.total})`} flush>
          <FilesBoard detail={d} actions={boardActions} closed={closed} />
        </Card>

        <ConflictsPanel
          conflicts={d.conflicts}
          busy={busy}
          closed={closed}
          onChoose={(conflictId, value) => m.choose.mutate({ conflictId, value }, { onError: onErr('choose the value') })}
          onAcceptAll={() => m.acceptPreselected.mutate(undefined, { onError: onErr('accept the preselected values') })}
          onSource={(title, s) => openSource(title, s)}
        />

        <div className="bdl-layout">
          <div className="stack">
            {d.aiSummary && (
              <Card title="What the documents say">
                <p>{d.aiSummary}</p>
              </Card>
            )}
            <DraftPanel detail={d} actions={draftActions} closed={closed} />
            <LiabilityCard detail={d} />
          </div>
          <div className="stack">
            <ChecklistCard detail={d} />
            <RiskPanel signals={d.signals} files={d.files} busy={busy} closed={closed} onAck={(signalId, note) => m.ack.mutate({ signalId, ...(note ? { note } : {}) }, { onError: onErr('note it') })} />
            <TimelineCard items={d.timeline} busy={busy} closed={closed} claimId={d.claim?.id ?? null} onTick={(proposalId, ticked) => m.tick.mutate({ proposalId, ticked }, { onError: onErr('change the chronology') })} onSource={(title, s) => openSource(title, s)} />
            <PhotoStrip files={d.files} signals={d.signals} accidentAt={accidentAt} />
          </div>
        </div>
      </div>

      {registerOpen && (
        <RegisterDialog
          open={registerOpen}
          detail={d}
          onClose={() => setRegisterOpen(false)}
          onRegister={async (body) => {
            const r = await m.register.mutateAsync(body);
            setRegisterOpen(false);
            setRegistered(r);
            toast.success(`Registered ${r.claim.reference}.`);
            return r;
          }}
        />
      )}
      {attach && (
        <AttachDialog
          open
          detail={d}
          {...(attach.claimId ? { initialClaimId: attach.claimId } : {})}
          {...(attach.groupKey ? { initialGroupKey: attach.groupKey } : {})}
          onClose={() => setAttach(null)}
          onAttach={async (body) => {
            const r = await m.attach.mutateAsync(body);
            setAttach(null);
            toast.success(`Filed ${r.filed.evidence} documents on ${r.claim.reference}${r.proposals.pending ? ` — ${r.proposals.pending} details wait for you` : ''}.`);
            return r;
          }}
        />
      )}
      <CancelDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onCancel={(reason) => m.cancel.mutateAsync(reason)} />
      <ProvenanceDrawer target={prov} files={d.files} onClose={() => setProv(null)} />
    </div>
  );
}
