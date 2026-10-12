// owned by intake-web
/**
 * One-glance case brief after Register (docs/SMART-INTAKE.md §11.4, improvement 10): a plain summary, the key facts
 * with their sources, the liability guide (your decision), what is still missing and where the request is, the call to
 * make, the Autopilot's first steps, next actions and anything worth a look (owner only).
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Card } from '../../../components/Card';
import type { CaseBriefView as Brief } from '../../../api/bundlesApi';
import { CHECK_LABEL, CHECK_TONE, SIGNAL_SEVERITY_LABEL, SIGNAL_SEVERITY_TONE, whenText } from './bundleModel';

const REQUEST_TEXT: Record<Brief['request']['status'], string> = {
  waiting_for_you: 'A request for these is prepared and waiting for your approval.',
  sent: 'The request has been sent to the client.',
  not_prepared: 'No request was prepared.',
  prepared_no_email: 'No email address for the client — a reminder to ask them is in Needs you.',
};

export function CaseBriefBody({ brief, compact = false }: { brief: Brief; compact?: boolean }) {
  const claimPath = `/claims/${encodeURIComponent(brief.claim.id)}`;
  return (
    <div className="stack-sm bdl-brief">
      <p className="bdl-brief-summary">{brief.summary}</p>
      {brief.summarySource === 'ai' && <div className="xs muted">Summary written by the AI from the documents and checked against the details.</div>}
      {brief.callReminder && <div className="notice notice-info">{brief.callReminder}</div>}
      {brief.facts.length > 0 && (
        <dl className="bdl-facts">
          {brief.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>
                {f.value}
                {f.source && <span className="small muted"> — {f.source}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="bdl-brief-grid">
        <section>
          <h4 className="bdl-subhead">Liability guide — your decision</h4>
          {brief.liability.score !== null && (
            <div>
              Score {brief.liability.score}
              {brief.liability.band ? ` (${brief.liability.band})` : ''}
            </div>
          )}
          {brief.liability.reasons.length > 0 && (
            <ul className="small">
              {brief.liability.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {brief.liability.statements.map((s, i) => (
            <blockquote key={i} className="bdl-quote small">
              “{s.text}” <span className="muted">— {s.source}</span>
            </blockquote>
          ))}
          <div className="xs muted">{brief.liability.note}</div>
        </section>
        <section>
          <h4 className="bdl-subhead">Still missing</h4>
          {brief.missing.length ? (
            <ul className="bdl-checklist">
              {brief.missing.map((m) => (
                <li key={m.id} className="bdl-check">
                  <Badge tone={CHECK_TONE[m.status]}>{CHECK_LABEL[m.status]}</Badge> <span>{m.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">Nothing missing.</p>
          )}
          {brief.missing.length > 0 && (
            <p className="small">
              {brief.request.reason ?? REQUEST_TEXT[brief.request.status]}{' '}
              {brief.request.needsYouId && <Link to={`/needs-you/${encodeURIComponent(brief.request.needsYouId)}`}>Open in Needs you</Link>}
              {!brief.request.needsYouId && brief.request.outboxId && <Link to={`/outbox/${encodeURIComponent(brief.request.outboxId)}`}>Open in the outbox</Link>}
            </p>
          )}
        </section>
        <section>
          <h4 className="bdl-subhead">Autopilot — first steps</h4>
          {brief.autopilot.stopped ? (
            <p className="small">Autopilot is off: {brief.autopilot.stopped}</p>
          ) : brief.autopilot.firstSteps.length ? (
            <ol className="small bdl-steps">
              {brief.autopilot.firstSteps.map((s) => (
                <li key={s.id}>
                  <strong>{s.title}</strong> <Badge tone="grey">{s.mode}</Badge> <Badge tone="blue">{s.status}</Badge>
                  <div className="muted">{s.sentence}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">Nothing due yet.</p>
          )}
        </section>
        <section>
          <h4 className="bdl-subhead">Next actions</h4>
          {brief.nextActions.length ? (
            <ul className="small">
              {brief.nextActions.map((a) => (
                <li key={a.code}>
                  <strong>{a.title}</strong>
                  {a.dueAt ? ` — by ${whenText(a.dueAt, 'date')}` : ''}
                  <div className="muted">{a.why}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None.</p>
          )}
        </section>
      </div>
      {brief.signals.length > 0 && (
        <section className="bdl-risk">
          <h4 className="bdl-subhead">Worth a look (only you see this)</h4>
          <ul className="small">
            {brief.signals.map((s) => (
              <li key={s.id}>
                <Badge tone={s.acknowledged ? 'grey' : SIGNAL_SEVERITY_TONE[s.severity]}>{SIGNAL_SEVERITY_LABEL[s.severity]}</Badge> {s.title} — {s.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="small muted">
        Filed {brief.filed.documents} documents and {brief.filed.photos} photos{brief.filed.duplicatesSkipped ? ` (${brief.filed.duplicatesSkipped} copies not filed twice)` : ''} · {brief.filed.events} chronology entries · damage on {brief.filed.damageZones} parts
        {!compact && brief.bundle ? (
          <>
            {' '}
            · from bundle <Link to={`/intake/bundles/${encodeURIComponent(brief.bundle.id)}`}>{brief.bundle.name}</Link>
          </>
        ) : null}
      </div>
      {!compact && (
        <div className="row">
          <Link className="btn btn-primary" to={claimPath}>
            Open claim {brief.claim.reference}
          </Link>
        </div>
      )}
    </div>
  );
}

export function CaseBriefView({ brief }: { brief: Brief }) {
  return (
    <Card title={`Case brief — ${brief.claim.reference}`} className="bdl-brief-card">
      <CaseBriefBody brief={brief} />
    </Card>
  );
}
