// owned by intake-web
/**
 * Needs-you `new_claim` — the case-bundle variant (docs/SMART-INTAKE.md §9, §11.5). Renders only when the item's payload
 * names a bundle (older per-file cards keep the generic view). Shows the live bundle (the card's payload is not
 * rewritten when the bundle changes): readiness, key fields, counts, what stops registering, and Open bundle. The
 * item's own buttons (Register / Attach / Cancel) stay below.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { useBundleProgress } from '../../../api/bundlesApi';
import { ReadinessBadge } from '../../intake/bundles/bundleParts';
import { firstBlockerText, ownerBlockers, signalsText } from '../../intake/bundles/bundleModel';
import type { NeedsYouPanelProps } from './types';

interface BundlePayload {
  bundleId?: string;
  name?: string;
  revision?: number;
  keyFields?: Array<{ label: string; value: string }>;
  counts?: { files?: number; conflicts?: number; missing?: number; signalsWarn?: number };
  blockers?: Array<{ code: string; text: string; for: 'owner' | 'auto' }>;
}

export function bundleIdOf(payload: unknown): string | null {
  const p = payload as BundlePayload | null | undefined;
  return p && typeof p.bundleId === 'string' && p.bundleId ? p.bundleId : null;
}

export function BundleReadyPanel({ item, closed }: NeedsYouPanelProps) {
  const bundleId = bundleIdOf(item.payload);
  // Hooks run unconditionally; the query is disabled for per-file cards.
  const live = useBundleProgress(bundleId ?? undefined, Boolean(bundleId) && !closed);
  if (!bundleId) return null;
  const p = item.payload as BundlePayload;
  const b = live.data?.bundle;
  // The live summary carries every blocker (owner and automatic); the card's payload is the fallback.
  const ownerBlocks = ownerBlockers(b ? b.autoRegister.blockers : p.blockers ?? []);
  const conflicts = b?.conflictsOpen ?? p.counts?.conflicts ?? 0;
  const missing = b?.missingDocs ?? p.counts?.missing ?? 0;
  const files = b?.fileCounts.total ?? p.counts?.files ?? 0;
  const flags = b ? signalsText(b.signals) : p.counts?.signalsWarn ? signalsText({ warn: p.counts.signalsWarn, info: 0 }) : null;
  return (
    <div className="stack-sm">
      <div className="row">
        <strong>{b?.name ?? p.name ?? 'Case bundle'}</strong>
        {b && <ReadinessBadge bundle={b} />}
        {b && b.revision !== p.revision && p.revision !== undefined && <span className="small muted">(changed since this card was raised)</span>}
      </div>
      {p.keyFields && p.keyFields.length > 0 && (
        <dl className="ny-kv">
          {p.keyFields.map((f) => (
            <div key={f.label} className="row">
              <dt className="small muted">{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="row small">
        <span>
          {files} {files === 1 ? 'file' : 'files'}
        </span>
        {conflicts > 0 && <Badge tone="red">{conflicts} to check</Badge>}
        {missing > 0 && <Badge tone="amber">{missing} documents missing</Badge>}
        {flags && <Badge tone="amber">{flags}</Badge>}
      </div>
      {ownerBlocks.length > 0 && !closed && (
        <div className="notice notice-warn small">
          Before Register works: {firstBlockerText(ownerBlocks)}
          {ownerBlocks.length > 1 ? ` (+${ownerBlocks.length - 1} more)` : ''}
        </div>
      )}
      <div>
        <Link className="btn btn-secondary btn-sm" to={`/intake/bundles/${encodeURIComponent(bundleId)}`}>
          Open bundle
        </Link>
      </div>
    </div>
  );
}
