// owned by intake-web
/**
 * Worth a look (docs/SMART-INTAKE.md §11.4, improvement 9). Owner's eyes only: plain facts with the innocent
 * explanation (camera clocks are wrong, editors resize photos). Nothing is declined, reported or held against anyone;
 * these never reach the agents, documents, the chronology or any email. "Noted" keeps the signal, greyed, with your note.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { TextInput } from '../../../components/Form';
import type { BundleFileView, RiskSignal } from '../../../api/bundlesApi';
import { SIGNAL_SEVERITY_LABEL, SIGNAL_SEVERITY_TONE, sortSignals, whenText } from './bundleModel';

function SignalRow({ s, files, onAck, busy, closed }: { s: RiskSignal; files: BundleFileView[]; onAck: (id: string, note?: string) => void; busy: boolean; closed: boolean }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const names = s.fileIds.map((id) => files.find((f) => f.id === id)?.filename ?? id);
  return (
    <li className={`bdl-signal ${s.acknowledged ? 'bdl-signal-ack' : ''}`.trim()}>
      <div className="row-between">
        <span>
          <Badge tone={s.acknowledged ? 'grey' : SIGNAL_SEVERITY_TONE[s.severity]}>{SIGNAL_SEVERITY_LABEL[s.severity]}</Badge> <strong>{s.title}</strong>
        </span>
        {!s.acknowledged && !closed && !noting && (
          <Button size="sm" variant="ghost" onClick={() => setNoting(true)}>
            Noted
          </Button>
        )}
      </div>
      <p className="small">{s.message}</p>
      {(names.length > 0 || s.claims.length > 0) && (
        <div className="small muted">
          {names.join(', ')}
          {s.claims.map((c, i) => (
            <span key={c.id}>
              {i === 0 && names.length ? ' · ' : i > 0 ? ', ' : ''}
              <Link to={`/claims/${encodeURIComponent(c.id)}`}>{c.reference}</Link>
            </span>
          ))}
        </div>
      )}
      {noting && (
        <div className="bdl-ack">
          <TextInput label="Your note (optional)" value={note} onChange={setNote} autoFocus />
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                onAck(s.id, note.trim() || undefined);
                setNoting(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNoting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {s.acknowledged && (
        <div className="small muted">
          Noted by {s.acknowledged.by.replace(/^agent:/, '')} · {whenText(s.acknowledged.at)}
          {s.acknowledged.note ? ` — ${s.acknowledged.note}` : ''}
        </div>
      )}
    </li>
  );
}

export function RiskPanel({ signals, files, onAck, busy, closed }: { signals: RiskSignal[]; files: BundleFileView[]; onAck: (id: string, note?: string) => void; busy: boolean; closed: boolean }) {
  return (
    <Card title="Worth a look" className="bdl-risk">
      <p className="small muted">Only you see this. Nothing has been declined or reported.</p>
      {signals.length ? (
        <ul className="bdl-signals">
          {sortSignals(signals).map((s) => (
            <SignalRow key={s.id} s={s} files={files} onAck={onAck} busy={busy} closed={closed} />
          ))}
        </ul>
      ) : (
        <p className="small">Nothing stood out in these files.</p>
      )}
    </Card>
  );
}
