// owned by knowledge-ui
/**
 * Knowledge ▸ Versions (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 7, §4.6): learned-pack versions (+added, −removed,
 * ~changed), the diff view, Activate (rollback or roll-forward, with a reason; it creates a new version), Export
 * (`.ccbrain` under DATA_DIR) and the replay run linked to each version.
 */
import { useState } from 'react';
import type { KnowledgePackVersion } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { knowledgeApi, useKnowledgeMutation, useKnowledgeVersionDiff, useKnowledgeVersions } from '../../api/knowledgeApi';
import { QueryGate, ReasonForm } from './parts';
import { KIND_LABEL, actorText, diffCounts, whenText } from './knowledgeView';

export function VersionsTab({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const q = useKnowledgeVersions();
  const [selected, setSelected] = useState<number | undefined>();
  const versions = q.data?.versions ?? [];
  const sel = versions.find((v) => v.version === selected) ?? versions.find((v) => v.active) ?? versions[0];
  return (
    <QueryGate q={q} what="Learned versions">
      {versions.length ? (
        <div className="kn-split">
          <Card title="Learned versions" flush>
            <div className="table-wrap">
              <table className="table" aria-label="Learned versions">
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Items</th>
                    <th scope="col">Change</th>
                    <th scope="col">Why</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version} className={sel?.version === v.version ? 'kn-row-selected' : undefined}>
                      <td>
                        <button type="button" className="kn-link" onClick={() => setSelected(v.version)}>
                          v{v.version}
                        </button>{' '}
                        {v.active && <Badge tone="green">active</Badge>} {v.rollbackOf !== null && <Badge tone="amber">rollback of v{v.rollbackOf}</Badge>}
                      </td>
                      <td>{v.itemCount}</td>
                      <td className="mono small">{diffCounts(v.diff)}</td>
                      <td className="small">{v.reason}</td>
                      <td className="small">
                        {whenText(v.createdAt)} · {actorText(v.createdBy)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {sel && <VersionDetail v={sel} activeVersion={q.data?.activeVersion ?? null} onOpenItem={onOpenItem} />}
        </div>
      ) : (
        <EmptyState title="No learned versions yet">A version is published a few minutes after something is learned or approved, and every night.</EmptyState>
      )}
    </QueryGate>
  );
}

function VersionDetail({ v, activeVersion, onOpenItem }: { v: KnowledgePackVersion; activeVersion: number | null; onOpenItem: (id: string) => void }) {
  const toast = useToast();
  const against = activeVersion !== null && activeVersion !== v.version ? activeVersion : undefined;
  const diff = useKnowledgeVersionDiff(v.version, against);
  const [activating, setActivating] = useState(false);
  const activate = useKnowledgeMutation((reason: string) => knowledgeApi.activateVersion(v.version, { reason }));
  const exp = useKnowledgeMutation(() => knowledgeApi.exportVersion(v.version));
  const d = diff.data;
  return (
    <Card title={`v${v.version}${v.label ? ` · ${v.label}` : ''}`}>
      <div className="stack">
        <div className="small muted">
          {v.itemCount} items · sha {v.itemsSha256.slice(0, 12)} · based on {v.basedOnVersion !== null ? `v${v.basedOnVersion}` : 'nothing'}
          {v.replayRunId ? ` · replay run ${v.replayRunId.slice(0, 8)}` : ' · no replay run'}
        </div>
        <div className="row">
          {!v.active && !activating && (
            <Button variant="primary" onClick={() => setActivating(true)}>
              {activeVersion !== null && v.version < activeVersion ? 'Roll back to this version' : 'Activate this version'}
            </Button>
          )}
          <Button loading={exp.isPending} onClick={() => exp.mutate(undefined, { onSuccess: (r) => toast.success(`Exported to ${r.file}`), onError: (e) => toast.error((e as Error).message) })}>
            Export
          </Button>
        </div>
        {activating && (
          <ReasonForm
            label="Why? (a new version is created; nothing is deleted)"
            action="Activate"
            danger={false}
            busy={activate.isPending}
            onCancel={() => setActivating(false)}
            onSubmit={(reason) => activate.mutate(reason, { onSuccess: () => (toast.success(`v${v.version} is active again as a new version`), setActivating(false)), onError: (e) => toast.error((e as Error).message) })}
          />
        )}
        {exp.data && <div className="small">Saved: {exp.data.file} ({Math.round(exp.data.bytes / 1024)} KB, sha {exp.data.sha256.slice(0, 12)})</div>}
        <ApiErrorNotice error={activate.error ?? exp.error} what="change the learned version" />
        <h4 className="kn-h">{against ? `Compared with the active v${against}` : 'Compared with the version before'}</h4>
        <QueryGate q={diff} what="The comparison">
          {d && (
            <div className="stack-sm">
              <div className="mono small">{diffCounts(d)}</div>
              {d.added.map((a) => (
                <div key={`a-${a.id}`} className="kn-ins kn-block-line">
                  + <button type="button" className="kn-link" onClick={() => onOpenItem(a.id)}>{a.title}</button> <span className="small muted">{KIND_LABEL[a.kind]} v{a.version}</span>
                </div>
              ))}
              {d.removed.map((a) => (
                <div key={`r-${a.id}`} className="kn-del kn-block-line">
                  − <button type="button" className="kn-link" onClick={() => onOpenItem(a.id)}>{a.title}</button> <span className="small muted">{KIND_LABEL[a.kind]} v{a.version}</span>
                </div>
              ))}
              {d.changed.map((c) => (
                <div key={`c-${c.toId}`} className="kn-block-line">
                  ~ <button type="button" className="kn-link" onClick={() => onOpenItem(c.toId)}>{c.itemKey}</button> <span className="small muted">changed: {c.fields.join(', ')}</span>
                </div>
              ))}
              {!d.added.length && !d.removed.length && !d.changed.length && <p className="small muted">No differences.</p>}
            </div>
          )}
        </QueryGate>
      </div>
    </Card>
  );
}
