// owned by claimai-web
/**
 * Catch-up file rows (docs/CLAIM-AI-INPUT.md §8, §14.2): per file — thumbnail or type, filename, document type, who sent
 * it (a select that records the owner's choice), the real date (from the letter / email date / set by you; change it),
 * the kind of letter, and plain badges (Already on file, Already recorded, Belongs to CCG-…, page range). "Source" opens
 * the provenance drawer of the smart-intake screens (read-only reuse).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateInput, Select } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useBundle, type FieldSource } from '../../../api/bundlesApi';
import { useClaimAiMutations, type CatchUpFile, type FileOverrideBody } from '../../../api/claimAiApi';
import { ProvenanceDrawer, type ProvenanceTarget } from '../../intake/bundles/ProvenanceDrawer';
import { dateSourceLabel, DIRECTION_LABEL, DIRECTION_OPTIONS, DIRECTION_TONE, isImageFile, londonDate, orderCatchUpFiles, PLAN_TONE, segmentText, whenText } from './aiInputModel';

function fileType(f: CatchUpFile): string {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(f.filename)?.[1];
  return (ext ?? f.mime.split('/')[1] ?? 'file').toUpperCase().slice(0, 4);
}

/** The drawer's source for a whole file (no single field: the file itself, at its first page). */
export function fileSource(f: CatchUpFile): FieldSource {
  return {
    fileId: f.fileId,
    itemId: f.itemId,
    evidenceId: f.evidenceId,
    filename: f.filename,
    docType: f.docType,
    docTypeLabel: f.docTypeLabel,
    page: f.segment?.fromPage ?? null,
    quote: null,
    confidence: f.directionConfidence,
    engine: f.directionSetBy === 'owner' ? 'owner' : 'rules',
    rank: 0,
    label: f.docTypeLabel ?? f.filename,
    quoteVerified: null,
  };
}

function FileRow({ f, busy, onOverride, onSource }: { f: CatchUpFile; busy: boolean; onOverride: (body: FileOverrideBody) => void; onSource: () => void }) {
  const [editDate, setEditDate] = useState(false);
  const [date, setDate] = useState(() => londonDate(f.realDate));
  const segment = segmentText(f.segment);
  const isLetter = f.direction !== 'none' || f.plan === 'ask';
  return (
    <li className={`aiin-file aiin-file-${f.plan}`}>
      <div className="aiin-file-thumb" aria-hidden="true">
        {isImageFile(f) ? <img src={f.fileUrl} alt="" loading="lazy" /> : <span>{fileType(f)}</span>}
      </div>
      <div className="aiin-file-main">
        <div className="aiin-file-name">
          <a href={f.fileUrl} target="_blank" rel="noreferrer" title={f.filename}>
            {f.filename}
          </a>
          {segment && <span className="xs muted"> · {segment}</span>}
        </div>
        <div className="aiin-line-chips">
          <Badge tone={PLAN_TONE[f.plan]}>{f.planLabel}</Badge>
          {f.docTypeLabel && <span className="aiin-scope-chip">{f.docTypeLabel}</span>}
          {f.kindLabel && <span className="aiin-scope-chip">{f.kindLabel}</span>}
          {f.alreadyOnFile && f.plan !== 'already_on_file' && <Badge tone="grey">Already on file</Badge>}
          {f.alreadyRecorded && <Badge tone="grey" title={f.alreadyRecorded.text}>{`Already recorded (${f.alreadyRecorded.text})`}</Badge>}
          {f.filed && <Badge tone="green">Filed</Badge>}
          {f.recorded && <Badge tone="green">Recorded</Badge>}
          {f.waiting && <Badge tone="amber">Waiting for the AI</Badge>}
          {!f.filed && f.stageLabel && f.stage !== 'read' && f.stage !== 'read_rules_only' && <span className="xs muted">{f.stageLabel}</span>}
        </div>
        {f.otherClaim && (
          <div className="small">
            This looks like <Link to={`/claims/${encodeURIComponent(f.otherClaim.id)}/ai`}>{f.otherClaim.reference}</Link> — open its AI input to file it there.
            {f.otherClaim.reasons.length > 0 && <span className="xs muted"> ({f.otherClaim.reasons.join('; ')})</span>}
          </div>
        )}
        {f.plan !== 'other_claim' && f.plan !== 'excluded' && (
          <div className="aiin-file-facts">
            <div className="aiin-file-fact">
              <Select
                label="Who sent it"
                value={f.direction === 'unknown' ? '' : f.direction}
                placeholder="Who sent it?"
                options={DIRECTION_OPTIONS}
                disabled={busy}
                onChange={(v) => v && v !== f.direction && onOverride({ direction: v })}
                hint={f.directionSetBy === 'owner' ? 'set by you' : f.directionWhy}
              />
              {f.direction !== 'unknown' && <Badge tone={DIRECTION_TONE[f.direction]}>{DIRECTION_LABEL[f.direction]}</Badge>}
            </div>
            {isLetter && (
              <div className="aiin-file-fact">
                <div className="field">
                  <span className="field-label">Real date</span>
                  <span>
                    {f.realDate ? (
                      <>
                        {whenText(f.realDate)} <span className="xs muted">· {dateSourceLabel(f.dateSource)}</span>
                      </>
                    ) : (
                      <span className="muted">no date found</span>
                    )}
                  </span>
                  {f.dateFlag && <div className="field-warning">{f.dateFlag}</div>}
                  {!f.dateFlag && f.dateWhy && <div className="field-hint">{f.dateWhy}</div>}
                </div>
                {!editDate ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditDate(true)} disabled={busy}>
                    Change date
                  </Button>
                ) : (
                  <form
                    className="aiin-date-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!date) return;
                      onOverride({ date });
                      setEditDate(false);
                    }}
                  >
                    <DateInput label="Date it was sent or received" value={date} onChange={setDate} />
                    <div className="field aiin-answer-send">
                      <Button type="submit" size="sm" variant="primary" disabled={!date} loading={busy}>
                        Save date
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
        {f.counterparty && <div className="xs muted">{f.direction === 'out' ? `To ${f.counterparty}` : f.direction === 'in' ? `From ${f.counterparty}` : f.counterparty}</div>}
        <div className="row">
          <Button size="sm" variant="ghost" onClick={onSource}>
            Source
          </Button>
          {f.plan !== 'other_claim' && !f.filed && (
            <Button size="sm" variant="ghost" onClick={() => onOverride({ notThisClaim: true })} disabled={busy}>
              Not this claim
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export function CatchUpFiles({ claimId, inputId, bundleId, files }: { claimId: string; inputId: string; bundleId: string; files: CatchUpFile[] }) {
  const m = useClaimAiMutations(claimId);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [source, setSource] = useState<ProvenanceTarget | null>(null);
  const bundle = useBundle(source ? bundleId : undefined);
  const ordered = orderCatchUpFiles(files);
  if (!files.length) return null;
  return (
    <>
      <ul className="aiin-files">
        {ordered.map((f) => (
          <FileRow
            key={f.fileId}
            f={f}
            busy={busyFile === f.fileId && m.overrideFile.isPending}
            onOverride={(body) => {
              setBusyFile(f.fileId);
              m.overrideFile.mutate({ inputId, fileId: f.fileId, body }, { onSettled: () => setBusyFile(null) });
            }}
            onSource={() => setSource({ title: f.filename, source: fileSource(f), readings: [] })}
          />
        ))}
      </ul>
      <ApiErrorNotice error={m.overrideFile.error} what="save your choice for the file" />
      <ProvenanceDrawer target={source} files={bundle.data?.files ?? []} onClose={() => setSource(null)} />
    </>
  );
}
