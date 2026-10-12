// owned by intake-web
/**
 * Photos (docs/SMART-INTAKE.md §11.4, improvement 7): thumbnails with the time the camera recorded (outlined when it is
 * before the accident — camera clocks are often wrong), the number plates read (client's car / other side / not on this
 * case) and the damaged parts the AI saw, which go to the claim's damage model when you register.
 */
import { Badge } from '../../../components/Badge';
import { Card } from '../../../components/Card';
import type { BundleFileView, RiskSignal } from '../../../api/bundlesApi';
import { PLATE_MATCH_LABEL, photoBeforeAccident, SEVERITY_LABEL, whenText } from './bundleModel';

export function PhotoStrip({ files, signals, accidentAt }: { files: BundleFileView[]; signals: RiskSignal[]; accidentAt: string | null }) {
  const photos = files.filter((f) => f.photo && !f.excluded).sort((a, b) => a.position - b.position);
  if (!photos.length) return null;
  return (
    <Card title={`Photos (${photos.length})`}>
      <ul className="bdl-photos">
        {photos.map((f) => {
          const before = photoBeforeAccident(f, signals, accidentAt);
          const p = f.photo!;
          return (
            <li key={f.id} className={`bdl-photo ${before ? 'bdl-photo-before' : ''}`.trim()}>
              <a href={f.fileUrl} target="_blank" rel="noreferrer" className="bdl-photo-link">
                <img src={f.fileUrl} alt={f.filename} loading="lazy" />
              </a>
              <div className="small bdl-photo-name" title={f.filename}>
                {f.filename}
              </div>
              <div className={`small ${before ? 'bdl-before' : 'muted'}`}>{p.takenAt ? `Taken ${whenText(p.takenAt)}${before ? ' — before the accident' : ''}` : 'No camera date'}</div>
              {f.duplicate && <div className="small muted">copy of another photo</div>}
              <div className="bdl-chips">
                {p.plates.map((pl) => (
                  <span key={pl.normalised} className={`bdl-plate bdl-plate-${pl.matches ?? 'none'}`} title={`Read with ${Math.round(pl.confidence * 100)}% confidence`}>
                    <span className="reg-plate">{pl.text}</span> {PLATE_MATCH_LABEL[pl.matches ?? 'none']}
                  </span>
                ))}
                {p.zones.map((z) => (
                  <Badge key={z.zoneId} tone={z.severity >= 3 ? 'red' : z.severity === 2 ? 'amber' : 'grey'} title={`${Math.round(z.confidence * 100)}% confidence`}>
                    {z.label} · {SEVERITY_LABEL[z.severity]}
                  </Badge>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
