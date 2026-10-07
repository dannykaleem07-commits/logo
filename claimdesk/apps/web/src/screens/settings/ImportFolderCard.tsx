/**
 * Settings → Import folder (docs/SUPREME-DESIGN.md §0.3 point 3, §L.11): where to drop files of any size (Audatex
 * data, brain packs, big evidence, emails saved as .eml), an "Open folder" button (Windows) and the last 20 files
 * ClaimDesk took from it.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../../api/client';
import { IMPORT_PURPOSE_LABEL, IMPORT_STATUS_LABEL, sizeText, uploadsApi, type StagedImport } from '../../api/uploads';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateText } from '../../components/DateText';
import { Spinner } from '../../components/Spinner';
import './settings.css';

const FOLDER_HELP: Record<string, string> = {
  evidence: 'Evidence. Put a file in a folder named after the claim (for example evidence\\CCG-2026-00012\\) and it is added to that claim.',
  intake: 'Documents for ClaimDesk to read into a claim (V5C, licence, insurance certificate, estimates).',
  mail: 'Emails saved as .eml files — filed to the right claim like any other email.',
  'brain-packs': 'Brain packs (.ccbrain) and skill folders exported from your private playbook. They never leave this computer.',
  'engineer-data': 'Audatex and other engineer data packs (.cab). Any size.',
};

function statusTone(s: StagedImport['status']): 'green' | 'amber' | 'red' {
  return s === 'consumed' ? 'green' : s === 'failed' ? 'red' : 'amber';
}

export function ImportFolderCard({ id = 'import-folder' }: { id?: string }) {
  const qc = useQueryClient();
  const folder = useQuery({ queryKey: ['imports', 'folder'], queryFn: ({ signal }) => uploadsApi.importFolder(signal), staleTime: 60_000, retry: false });
  const recent = useQuery({ queryKey: ['imports', 'recent'], queryFn: ({ signal }) => uploadsApi.listImports({ limit: 20 }, signal), refetchInterval: 30_000, retry: false });
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const open = async () => {
    setOpening(true);
    setNote(null);
    try {
      await uploadsApi.openImportFolder();
    } catch (e) {
      setNote(isApiError(e) && e.status === 501 ? 'Opening the folder works on the Windows computer running ClaimDesk. Copy the path above instead.' : `Could not open the folder: ${(e as Error).message}`);
    } finally {
      setOpening(false);
    }
  };

  const items = (recent.data ?? []).slice(0, 20);

  return (
    <Card
      id={id}
      title="Import folder"
      actions={
        <>
          <Button size="sm" onClick={() => void qc.invalidateQueries({ queryKey: ['imports'] })} disabled={recent.isFetching}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" onClick={() => void open()} loading={opening} disabled={!folder.data}>
            Open folder
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="xs muted" style={{ margin: 0 }}>
          The easiest way to bring in big files (Audatex data, brain packs, large evidence): drop them into this folder on the computer running ClaimDesk. ClaimDesk takes each file once it has finished copying (about 10 seconds), checks it and moves it into its own data folder. Files here never go to the internet.
        </p>
        {folder.isLoading ? (
          <div className="row xs muted">
            <Spinner /> Finding the import folder…
          </div>
        ) : folder.data ? (
          <>
            <div>
              <div className="xs muted">Folder</div>
              <code style={{ overflowWrap: 'anywhere' }}>{folder.data.path}</code>
            </div>
            <ul className="xs" style={{ margin: 0, paddingLeft: 18 }}>
              {folder.data.subfolders.map((s) => (
                <li key={s.purpose}>
                  <strong>{s.purpose}</strong> — {FOLDER_HELP[s.purpose] ?? IMPORT_PURPOSE_LABEL[s.purpose]}
                </li>
              ))}
            </ul>
            {folder.data.watching === false && <p className="xs muted" style={{ margin: 0 }}>The folder is checked while ClaimDesk runs in the background (installed version).</p>}
          </>
        ) : (
          <p className="xs muted" style={{ margin: 0 }}>The import folder is not available on this ClaimDesk.</p>
        )}
        {note && (
          <div className="notice notice-info" role="status">
            {note}
          </div>
        )}
        <div>
          <div className="xs muted" style={{ marginBottom: 4 }}>
            Recently imported
          </div>
          {recent.isLoading ? (
            <div className="row xs muted">
              <Spinner /> Loading…
            </div>
          ) : items.length === 0 ? (
            <p className="xs muted" style={{ margin: 0 }}>
              Nothing yet.
            </p>
          ) : (
            <table className="table" aria-label="Recently imported files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>For</th>
                  <th>Size</th>
                  <th>Received</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="wrap">
                      <div className="strong">{i.filename}</div>
                      <div className="xs muted">
                        {i.claimRef ? `${i.claimRef} · ` : ''}
                        {i.source === 'upload' ? 'uploaded' : 'from the folder'} · <span className="hash" title={i.sha256}>{i.sha256.slice(0, 10)}…</span>
                      </div>
                      {i.error && <div className="xs" style={{ color: 'var(--red)' }}>{i.error}</div>}
                    </td>
                    <td>{IMPORT_PURPOSE_LABEL[i.purpose] ?? i.purpose}</td>
                    <td>{sizeText(i.bytes)}</td>
                    <td>
                      <DateText value={i.receivedAt} time />
                    </td>
                    <td>
                      <Badge tone={statusTone(i.status)}>{IMPORT_STATUS_LABEL[i.status] ?? i.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Card>
  );
}
