/**
 * Settings → Updates (anchor #updates; docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3): the installed version, whether a
 * newer ClaimDesk is out, its notes and the Setup download. The download opens in the browser; the owner runs it.
 */
import { useState } from 'react';
import { RELEASES_PAGE_URL, useCheckNow, useUpdateCheck } from '../../api/updatesApi';
import { useHealth } from '../../api/hooks';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { installedText, RUN_IT_TEXT, updateView } from './updates';
import './settings.css';

export function UpdatesCard({ id = 'updates' }: { id?: string }) {
  const health = useHealth();
  const check = useUpdateCheck({ staleTime: 60_000 });
  const checkNow = useCheckNow();
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = check.data?.current || health.data?.version;

  const onCheck = async () => {
    setChecking(true);
    setFailed(false);
    try {
      await checkNow();
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const view = check.data ? updateView(check.data) : undefined;
  const releasesLink = (
    <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">
      ClaimDesk releases page
    </a>
  );

  return (
    <Card
      id={id}
      title="Updates"
      actions={
        <Button size="sm" onClick={() => void onCheck()} loading={checking} disabled={check.isLoading}>
          Check now
        </Button>
      }
    >
      <div className="stack" aria-live="polite">
        <div>
          <strong>{installedText(current)}</strong>
        </div>
        {check.isLoading && !view ? (
          <div className="row xs muted">
            <Spinner /> Checking for updates…
          </div>
        ) : failed || check.isError || !view ? (
          <p className="xs muted" style={{ margin: 0 }}>
            Could not check for updates (no internet?). You can always download the latest version from the {releasesLink}.
          </p>
        ) : view.kind === 'available' ? (
          <div className="notice notice-info stack-sm">
            <div>
              <strong>{view.headline}</strong>
              {view.published ? ` — ${view.published}` : ''}
            </div>
            {view.notes && (
              <details>
                <summary>What's new</summary>
                <div className="xs" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 320, overflow: 'auto' }}>
                  {view.notes}
                </div>
              </details>
            )}
            {view.download ? (
              <a className="btn btn-primary update-download" href={view.download.href} target="_blank" rel="noopener noreferrer">
                {view.download.label}
              </a>
            ) : (
              <a className="btn btn-primary update-download" href={view.releaseUrl ?? RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">
                Open the release page
              </a>
            )}
            <div className="xs">{RUN_IT_TEXT}</div>
          </div>
        ) : view.kind === 'up_to_date' ? (
          <div className="ok-mark">{view.line}</div>
        ) : view.kind === 'disabled' ? (
          <p className="xs muted" style={{ margin: 0 }}>
            Update checks are switched off on this computer. You can always download the latest version from the {releasesLink}.
          </p>
        ) : (
          <p className="xs muted" style={{ margin: 0 }} title={view.detail}>
            Could not check for updates (no internet?). You can always download the latest version from the {releasesLink}.
          </p>
        )}
      </div>
    </Card>
  );
}
