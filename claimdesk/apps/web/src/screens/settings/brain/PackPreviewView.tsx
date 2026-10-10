// owned by casework
import { Badge } from '../../../components/Badge';
import type { PackPreview } from '../../../api/brainApi';
import { kindSummary } from './brainView';

/** What a pack version holds: entry counts by kind, red lines, a sample of entries, import warnings. */
export function PackPreviewView({ preview }: { preview: PackPreview }) {
  return (
    <div className="stack-sm">
      <div className="small">
        <strong>{preview.entries}</strong> entries — {kindSummary(preview.byKind)} · from a {preview.sourceKind === 'skill' ? 'skill folder' : preview.sourceKind === 'ccbrain' ? '.ccbrain file' : 'pack folder'}
      </div>
      {preview.redLines.length > 0 && (
        <div className="stack-sm">
          <span className="small muted">Red lines (always apply):</span>
          {preview.redLines.map((r) => (
            <div key={r.id} className="row small">
              <Badge tone={r.action === 'block' ? 'red' : 'amber'}>{r.action}</Badge>
              {r.title}
            </div>
          ))}
        </div>
      )}
      {preview.sample.length > 0 && (
        <ul className="small muted">
          {preview.sample.slice(0, 8).map((e) => (
            <li key={e.id}>
              {e.kind}: {e.title}
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.map((w) => (
        <div key={w} className="small" role="note">
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}
