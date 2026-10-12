// owned by intake-web
/**
 * Files & cases board (docs/SMART-INTAKE.md §11.4, improvements 1, 5, 6). One column per group — This case · New case
 * B · CCG-… · Not sure · Excluded — with the reasons the files were put there. Cards show the type, stage, "read
 * without AI", duplicates collapsed under their primary and packs with their page-range segments. Drag a card to another
 * column to move it; the card's "Move to…" menu and "Exclude" do the same from the keyboard.
 */
import { useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { sizeText } from '../../../api/uploads';
import type { BundleDetail, BundleFileView, BundleGroup } from '../../../api/bundlesApi';
import { DUPLICATE_TEXT, duplicateBadge, fileIcon, fileNodes, isImage, moveTargets, orderGroups, pagesText, pct, STAGE_TONE, stageLabel, type FileNode } from './bundleModel';

const DRAG_TYPE = 'application/x-claimdesk-bundle-file';

export interface FilesBoardActions {
  move: (fileId: string, groupKey: string) => void;
  exclude: (fileId: string, excluded: boolean) => void;
  unsplit: (fileId: string) => void;
  fileCopy?: (fileId: string) => void;
  splitOff: (group: BundleGroup) => void;
  attachGroup: (group: BundleGroup) => void;
}

function FileCard({ node, files, groups, actions, closed }: { node: FileNode; files: BundleFileView[]; groups: BundleGroup[]; actions: FilesBoardActions; closed: boolean }) {
  const f = node.file;
  const [moving, setMoving] = useState(false);
  const dup = duplicateBadge(f, files);
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(DRAG_TYPE, f.id);
    e.dataTransfer.setData('text/plain', f.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div className={`bdl-card ${f.excluded ? 'bdl-card-excluded' : ''}`.trim()} draggable={!closed} onDragStart={onDragStart} data-file-id={f.id} aria-label={f.filename}>
      <div className="bdl-card-top">
        {isImage(f) ? <img className="bdl-thumb" src={f.fileUrl} alt="" loading="lazy" /> : <span className="bdl-icon" aria-hidden="true">{fileIcon(f)}</span>}
        <div className="bdl-card-main">
          <div className="bdl-card-name" title={f.filename}>
            {f.filename}
          </div>
          <div className="bdl-card-meta">
            {f.docTypeLabel && (
              <Badge tone="navy" title={f.docTypeConfidence !== null ? `Confidence ${pct(f.docTypeConfidence)}` : undefined}>
                {f.docTypeLabel}
                {f.docTypeConfidence !== null ? ` · ${pct(f.docTypeConfidence)}` : ''}
              </Badge>
            )}
            <Badge tone={STAGE_TONE[f.stage]} title={f.error ?? undefined}>
              {stageLabel(f)}
            </Badge>
            {f.engine === 'rules' && f.stage !== 'read_rules_only' && <Badge tone="grey">read without AI</Badge>}
            {dup && <Badge tone="amber">{dup}</Badge>}
            {f.docSide && <Badge tone="grey">{f.docSide}</Badge>}
          </div>
          <div className="small muted">
            {f.pages ? `${f.pages} ${f.pages === 1 ? 'page' : 'pages'} · ` : ''}
            {sizeText(f.bytes)}
            {f.segment ? ` · ${pagesText(f.segment)}` : ''}
            {f.archive ? ` · unpacked ${f.archive.entries} files${f.archive.skipped.length ? `, ${f.archive.skipped.length} skipped` : ''}` : ''}
            {f.filed ? ' · filed' : ''}
          </div>
          {f.error && <div className="small bdl-error">{f.error}</div>}
        </div>
      </div>
      {node.segments.length > 0 && (
        <ul className="bdl-nested" aria-label={`Documents inside ${f.filename}`}>
          {node.segments.map((s) => (
            <li key={s.id}>
              <span className="bdl-nested-pages">{pagesText(s.segment)}</span> {s.docTypeLabel ?? s.filename}{' '}
              <Badge tone={STAGE_TONE[s.stage]}>{stageLabel(s)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {node.copies.length > 0 && (
        <details className="bdl-copies">
          <summary>
            {node.copies.length} {node.copies.length === 1 ? 'copy' : 'copies'} (not filed twice)
          </summary>
          <ul className="bdl-nested">
            {node.copies.map((c) => (
              <li key={c.id}>
                {c.filename} <Badge tone="amber">{duplicateBadge(c, files)}</Badge> <span className="small muted">{c.duplicate ? DUPLICATE_TEXT[c.duplicate.kind] : ''}</span>
                {closed && actions.fileCopy && !c.filed && (
                  <Button size="sm" variant="ghost" onClick={() => actions.fileCopy!(c.id)}>
                    File this copy too
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!closed && (
        <div className="bdl-card-actions">
          {moving ? (
            <label className="bdl-move">
              <span className="sr-only">Move {f.filename} to</span>
              <select
                className="select"
                aria-label={`Move ${f.filename} to`}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) actions.move(f.id, e.target.value);
                  setMoving(false);
                }}
                onBlur={() => setMoving(false)}
                autoFocus
              >
                <option value="">Move to…</option>
                {moveTargets(groups, f.groupKey).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setMoving(true)}>
              Move to…
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.exclude(f.id, !f.excluded)}>
            {f.excluded ? 'Include' : 'Exclude'}
          </Button>
          {f.role === 'pack' && node.segments.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => actions.unsplit(f.id)} title="Treat the scan as one document again">
              Keep as one
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Column({ group, detail, actions, closed }: { group: BundleGroup; detail: BundleDetail; actions: FilesBoardActions; closed: boolean }) {
  const [over, setOver] = useState(false);
  const nodes = fileNodes(detail.files, group.key);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain');
    const file = detail.files.find((f) => f.id === id);
    if (!file || file.groupKey === group.key) return;
    if (group.kind === 'excluded') actions.exclude(id, true);
    else if (file.excluded) actions.exclude(id, false);
    else actions.move(id, group.key);
  };
  return (
    <section
      className={`bdl-col bdl-col-${group.kind} ${over ? 'over' : ''}`.trim()}
      aria-label={group.label}
      onDragOver={(e) => {
        if (closed) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <header className="bdl-col-header">
        <div className="row-between">
          <h4>
            {group.claim ? <Link to={`/claims/${encodeURIComponent(group.claim.id)}`}>{group.label}</Link> : group.label}
          </h4>
          <span className="small muted">{group.fileIds.length}</span>
        </div>
        {group.reasons.length > 0 && (
          <ul className="bdl-reasons">
            {group.reasons.slice(0, 5).map((r, i) => (
              <li key={`${r.code}-${i}`}>{r.text}</li>
            ))}
          </ul>
        )}
        {group.warnings.map((w) => (
          <div key={w} className="notice notice-warn small">
            {w}
          </div>
        ))}
        {!closed && (group.kind === 'new_case' || group.kind === 'unsure') && group.fileIds.length > 0 && (
          <Button size="sm" onClick={() => actions.splitOff(group)} title={group.suggestedName ? `Suggested name: ${group.suggestedName}` : undefined}>
            Make a separate bundle
          </Button>
        )}
        {!closed && group.kind === 'existing_claim' && group.claim && (
          <Button size="sm" onClick={() => actions.attachGroup(group)}>
            Attach to {group.claim.reference}
          </Button>
        )}
      </header>
      <div className="bdl-col-body">
        {nodes.length ? nodes.map((n) => <FileCard key={n.file.id} node={n} files={detail.files} groups={detail.groups} actions={actions} closed={closed} />) : <p className="small muted">Drop a file here to move it.</p>}
      </div>
    </section>
  );
}

export function FilesBoard({ detail, actions, closed = false }: { detail: BundleDetail; actions: FilesBoardActions; closed?: boolean }) {
  const groups = orderGroups(detail.groups);
  return (
    <div className="bdl-board" id="bundle-files">
      {groups.map((g) => (
        <Column key={g.key} group={g} detail={detail} actions={actions} closed={closed} />
      ))}
    </div>
  );
}
