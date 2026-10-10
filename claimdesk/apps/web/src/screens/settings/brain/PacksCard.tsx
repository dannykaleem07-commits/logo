// owned by casework
import { useState } from 'react';
import { Card } from '../../../components/Card';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { brainApi, useBrainMutation, type BrainPack } from '../../../api/brainApi';
import { PackPreviewView } from './PackPreviewView';
import { ActivateForm } from './ActivateForm';

function PackRow({ pack }: { pack: BrainPack }) {
  const [open, setOpen] = useState(false);
  const deactivate = useBrainMutation(() => brainApi.deactivate(pack.id));
  const rollback = useBrainMutation((version: string) => brainApi.activate(pack.id, { version }));
  return (
    <li>
      <div className="list-main stack-sm">
        <div className="row">
          <span className="list-title">{pack.name}</span>
          {pack.activeVersion ? <Badge tone="green">active {pack.activeVersion}</Badge> : <Badge tone="grey">inactive</Badge>}
          <Badge tone="navy">precedence {pack.precedence}</Badge>
          {pack.business.map((b) => (
            <Badge key={b} tone="blue">
              {b}
            </Badge>
          ))}
          {pack.useForCcguk && !pack.business.includes('ccguk') && <Badge tone="amber">used for CCGUK</Badge>}
        </div>
        <div className="list-sub">
          {pack.id} · {pack.versions.length} version{pack.versions.length === 1 ? '' : 's'} · {pack.preview?.entries ?? 0} entries
        </div>
        {open && (
          <div className="stack-sm">
            {pack.preview && <PackPreviewView preview={pack.preview} />}
            <table className="table small">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Entries</th>
                  <th>Imported</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pack.versions.map((v) => (
                  <tr key={v.version}>
                    <td>{v.version}</td>
                    <td>{v.entries}</td>
                    <td>
                      <DateText value={v.importedAt} time />
                    </td>
                    <td>
                      {v.version === pack.activeVersion ? (
                        <Badge tone="green">active</Badge>
                      ) : pack.activeVersion ? (
                        <Button size="sm" loading={rollback.isPending} onClick={() => void rollback.mutateAsync(v.version).catch(() => undefined)}>
                          {pack.versions.findIndex((x) => x.version === v.version) > pack.versions.findIndex((x) => x.version === pack.activeVersion) ? 'Roll back to this' : 'Use this'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!pack.activeVersion && pack.preview && <ActivateForm preview={pack.preview} useForCcguk={pack.useForCcguk} />}
            <ApiErrorNotice error={deactivate.error ?? rollback.error} what="change the pack" />
          </div>
        )}
      </div>
      <div className="row">
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : 'Details'}
        </Button>
        {pack.activeVersion && (
          <Button size="sm" variant="ghost" loading={deactivate.isPending} onClick={() => void deactivate.mutateAsync(undefined).catch(() => undefined)}>
            Deactivate
          </Button>
        )}
      </div>
    </li>
  );
}

/** Packs in precedence order with their versions (activate, roll back, deactivate). */
export function PacksCard({ packs }: { packs: BrainPack[] }) {
  return (
    <Card title={`Packs (${packs.length})`} flush>
      {packs.length ? (
        <ul className="list">
          {packs.map((p) => (
            <PackRow key={p.id} pack={p} />
          ))}
        </ul>
      ) : (
        <EmptyState title="No brain packs yet">Import your CCGUK rules or a playbook below. The agents use the knowledge base until then.</EmptyState>
      )}
    </Card>
  );
}
