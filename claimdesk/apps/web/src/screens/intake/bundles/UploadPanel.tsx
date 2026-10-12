// owned by intake-web
/**
 * Drop zone + per-file progress for a bundle (docs/SMART-INTAKE.md §11.3): files and whole folders; client upload %
 * first, then the server's reading stage; retry per failed file; very large files are pointed at the import folder.
 */
import { useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { sizeText } from '../../../api/uploads';
import type { BundleProgress } from '../../../api/bundlesApi';
import { filesFromDataTransfer, filesFromInput, rowPercent, type UploadQueue, type UploadRow } from './uploadQueue';
import { STAGE_TONE, stageLabel } from './bundleModel';

const EMPTY: readonly UploadRow[] = [];
const noop = () => () => undefined;

/** Rows of a queue (empty when there is none). */
export function useQueueRows(queue: UploadQueue | undefined): readonly UploadRow[] {
  return useSyncExternalStore(queue ? queue.subscribe : noop, queue ? queue.getSnapshot : () => EMPTY, () => EMPTY);
}

export function DropArea({ onFiles, disabled, children, compact = false }: { onFiles: (files: File[]) => void; disabled?: boolean; children?: ReactNode; compact?: boolean }) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    // Only file drags (not a file card dragged between columns)
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
    void filesFromDataTransfer(e.dataTransfer).then((files) => files.length && onFiles(files));
  };
  return (
    <div
      className={`bdl-drop ${over ? 'over' : ''} ${compact ? 'bdl-drop-compact' : ''}`.trim()}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-disabled={disabled || undefined}
    >
      <div className="bdl-drop-title">Drop files or a whole folder here</div>
      <div className="small muted">PDFs, photos, Word documents, emails (.eml) and .zip files. Everything is read together.</div>
      {children}
      <div className="row">
        <input ref={filesInput} type="file" multiple hidden aria-label="Choose files" onChange={(e) => (onFiles(filesFromInput(e.target.files)), (e.target.value = ''))} />
        <input
          ref={(el) => {
            folderInput.current = el;
            if (el) el.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          hidden
          aria-label="Choose a folder"
          onChange={(e) => (onFiles(filesFromInput(e.target.files)), (e.target.value = ''))}
        />
        <Button variant="primary" onClick={() => filesInput.current?.click()} disabled={disabled}>
          Choose files
        </Button>
        <Button onClick={() => folderInput.current?.click()} disabled={disabled}>
          Choose a folder
        </Button>
      </div>
    </div>
  );
}

export function UploadRows({ queue, rows, progress }: { queue: UploadQueue; rows: readonly UploadRow[]; progress: BundleProgress | undefined }) {
  if (!rows.length) return null;
  const finished = rows.filter((r) => r.status === 'sent' || r.status === 'refused').length;
  return (
    <div className="bdl-uploads">
      <div className="row-between">
        <span className="small">
          {finished} of {rows.length} sent{queue.busy ? ' — uploading…' : ''}
        </span>
        {!queue.busy && finished > 0 && (
          <Button size="sm" variant="ghost" onClick={() => queue.clearFinished()}>
            Clear the list
          </Button>
        )}
      </div>
      <ul className="bdl-upload-list">
        {rows.map((r) => {
          const server = r.fileId ? progress?.files.find((f) => f.id === r.fileId) : undefined;
          return (
            <li key={r.key} className={`bdl-upload bdl-upload-${r.status}`}>
              <span className="bdl-upload-name" title={r.name}>
                {r.name}
              </span>
              <span className="small muted">{sizeText(r.size)}</span>
              {r.status === 'uploading' || r.status === 'queued' ? (
                <span className="bdl-progress" role="progressbar" aria-label={`Uploading ${r.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={rowPercent(r)}>
                  <span className="bdl-progress-bar" style={{ width: `${rowPercent(r)}%` }} />
                </span>
              ) : null}
              {r.status === 'queued' && <Badge tone="grey">Waiting</Badge>}
              {r.status === 'uploading' && <Badge tone="blue">{rowPercent(r)}%</Badge>}
              {r.status === 'sent' && (server ? <Badge tone={STAGE_TONE[server.stage]}>{stageLabel(server)}</Badge> : <Badge tone="green">{r.outcome === 'already_in_bundle' ? 'Already here' : 'Sent'}</Badge>)}
              {r.status === 'failed' && (
                <>
                  <Badge tone="red" title={r.error ?? undefined}>
                    Not sent
                  </Badge>
                  <Button size="sm" onClick={() => queue.retry(r.key)}>
                    Retry
                  </Button>
                </>
              )}
              {r.status === 'refused' && <span className="small bdl-error">{r.error}</span>}
              {r.status === 'failed' && r.error && <span className="small bdl-error">{r.error}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
