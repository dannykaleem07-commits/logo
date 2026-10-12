// owned by intake-web
/**
 * Case bundles list (docs/SMART-INTAKE.md §11.2): each bundle with its readiness, file progress, groups, conflicts,
 * missing documents and the owner-only "worth a look" count. Polls every 4 s while any bundle is reading.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Badge } from '../../../components/Badge';
import { useBundles, type BundleListFilter, type BundleSummary } from '../../../api/bundlesApi';
import { ProgressBar, ReadinessBadge } from './bundleParts';
import { groupCountText, whenText } from './bundleModel';
import './bundles.css';

export const LIST_FILTERS: Array<{ id: BundleListFilter; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'done', label: 'Registered' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

function Row({ b }: { b: BundleSummary }) {
  const flags = b.signals.warn + b.signals.info;
  return (
    <li className="bdl-row">
      <Link className="bdl-row-link" to={`/intake/bundles/${encodeURIComponent(b.id)}`}>
        <div className="bdl-row-top">
          <span className="bdl-row-name">
            {b.source === 'folder' && (
              <span className="bdl-folder" title={`From the import folder${b.folderKey ? ` “${b.folderKey}”` : ''}`} aria-label="From the import folder">
                ▣
              </span>
            )}
            {b.name}
          </span>
          <ReadinessBadge bundle={b} />
        </div>
        <div className="bdl-row-mid">
          <ProgressBar value={b.fileCounts.read} total={b.fileCounts.total} label={`${b.fileCounts.read} of ${b.fileCounts.total} files read`} />
          <span className="small muted">
            {b.fileCounts.read}/{b.fileCounts.total} files read
            {b.fileCounts.waitingAi ? ` · ${b.fileCounts.waitingAi} waiting for the AI` : ''}
            {b.fileCounts.failed ? ` · ${b.fileCounts.failed} with a problem` : ''}
          </span>
        </div>
        <div className="bdl-row-bottom small">
          <span>{groupCountText(b.groupCount)}</span>
          {b.conflictsOpen > 0 && <Badge tone="red">{b.conflictsOpen} {b.conflictsOpen === 1 ? 'conflict' : 'conflicts'}</Badge>}
          {b.missingDocs > 0 && <Badge tone="amber">{b.missingDocs} missing</Badge>}
          {flags > 0 && (
            <Badge tone={b.signals.warn ? 'amber' : 'grey'} title="Worth a look (only you see this)">
              ⚑ {flags}
            </Badge>
          )}
          {b.autoRegister.settingOn && b.autoRegister.eligible && <Badge tone="green">will register automatically</Badge>}
          <span className="muted">updated {whenText(b.updatedAt)}</span>
        </div>
      </Link>
    </li>
  );
}

export function BundlesListPage({ tabs }: { tabs?: ReactNode }) {
  const [filter, setFilter] = useState<BundleListFilter>('open');
  const q = useBundles(filter);
  const items = q.data?.items ?? [];
  return (
    <div className="page bdl-page">
      <PageHeader
        title="Intake — case bundles"
        subtitle="Type a name, drop the files: they are read together into one claim."
        actions={
          <Link className="btn btn-primary" to="/intake/bundles/new">
            New bundle
          </Link>
        }
      />
      {tabs}
      <Card>
        <div className="bdl-filters" role="tablist" aria-label="Show">
          {LIST_FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`chip ${filter === f.id ? 'chip-on' : ''}`.trim()} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ApiErrorNotice error={q.error} what="load the bundles" />
        ) : items.length ? (
          <ul className="bdl-rows">
            {items.map((b) => (
              <Row key={b.id} b={b} />
            ))}
          </ul>
        ) : (
          <EmptyState
            title={filter === 'open' ? 'No open bundles' : 'Nothing here'}
            action={
              <Link className="btn btn-primary" to="/intake/bundles/new">
                New bundle
              </Link>
            }
          >
            Start one with a temporary name and drop the files — or put a folder in inbox\intake\.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
