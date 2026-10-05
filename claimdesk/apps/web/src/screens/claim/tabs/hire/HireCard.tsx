/**
 * One hire agreement: dates, the pricing figures recorded when it was set up (agreed rate, both GTA guides, the
 * difference, the higher-group notice), indicative charges with the benchmark and like-for-like lines, the paperwork
 * checklist, an "Entered late" badge and the list of corrections. "Edit dates & rate" is on every card.
 */
import { Link } from 'react-router-dom';
import { formatGBP, HIRE_DAY_CONVENTION } from '@ccguk/domain';
import { api } from '../../../../api/client';
import type { HireListItem } from '../../../../api/hireApi';
import { Badge, VerificationBadge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { DateText } from '../../../../components/DateText';
import { KeyValue } from '../../../../components/KeyValue';
import { Money } from '../../../../components/Money';
import { partyName, type ClaimView } from '../../claimFile';
import { correctionChangesText, enforceabilityChecklist, enforceabilityScore, enteredLateText, GTA_BENCHMARK_NOTE, HIRE_TRIGGERS, hireRunning, hireTotals, londonShort } from '../../lib/hire';
import { higherGroupNotice, likeForLikeLine, signedGBP, snapshotSummary } from '../../lib/hirePricing';

export function HireCard({ h, view, nowIso, onEnd, onEdit }: { h: HireListItem; view: ClaimView; nowIso: string; onEnd: () => void; onEdit: () => void }) {
  const running = hireRunning(h, nowIso);
  const dueBack = running && h.endAt ? h.endAt : undefined;
  const totals = h.calculation ?? hireTotals(h, nowIso);
  const items = enforceabilityChecklist(h);
  const score = enforceabilityScore(h);
  const trigger = HIRE_TRIGGERS.find((t) => t.value === h.endTrigger);
  const higher = h.pricing ? higherGroupNotice(h.pricing) : undefined;
  const likeForLike = likeForLikeLine(totals);
  const corrections = h.corrections ?? [];
  return (
    <section className="card service-card">
      <header className="card-header">
        <h3 className="card-title row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {h.agreementNumber}
          <Badge tone={running ? 'blue' : 'grey'} dot title={dueBack ? 'The end date is in the future: charged up to today until then. Use Edit dates to change it.' : undefined}>
            {dueBack ? `running — due back ${londonShort(dueBack)}` : running ? 'running' : 'ended'}
          </Badge>
          <Badge tone="grey" title={`GTA group — ${GTA_BENCHMARK_NOTE}`}>
            group {h.gtaGroup}
          </Badge>
          <Badge tone={score.ok === score.total ? 'green' : score.ok >= 3 ? 'amber' : 'red'} title="Paperwork checklist">
            paperwork {score.ok}/{score.total}
          </Badge>
          {h.backdated && (
            <Badge tone="amber" title={enteredLateText(h)}>
              Entered late
            </Badge>
          )}
        </h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {h.documentId && (
            <Link className="btn btn-ghost btn-sm" to={`../documents/${h.documentId}`}>
              Agreement document
            </Link>
          )}
          <Button size="sm" onClick={onEdit}>
            Edit dates &amp; rate
          </Button>
          {running && !h.endAt && (
            <Button size="sm" variant="primary" onClick={onEnd}>
              End hire
            </Button>
          )}
        </div>
      </header>
      {(h.pricing || h.backdated || corrections.length > 0) && (
        <div className="hire-pricing">
          {h.pricing && (
            <div>
              <span className="strong">{snapshotSummary(h.pricing)}</span>
              {!h.pricing.snapshot && <span className="xs muted"> · worked out today from the client's car's current group</span>}
            </div>
          )}
          {higher && (
            <div className="notice notice-warn xs" role="note">
              ⚠ {higher}
            </div>
          )}
          {h.backdated && <div className="xs muted">Entered late: {enteredLateText(h)}</div>}
          {corrections.length > 0 && (
            <details className="hire-corrections">
              <summary>Corrected {corrections.length}×</summary>
              <ul>
                {[...corrections].reverse().map((c) => (
                  <li key={`${c.at}-${c.by}`}>
                    {londonShort(c.at)} · {c.byName ?? c.by} · {c.reason || 'no reason given'}
                    {Object.keys(c.changes).length > 0 && <div className="muted">{correctionChangesText(c.changes)}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="card-body">
        <div className="stack">
          <KeyValue
            items={[
              { label: 'Start', value: <DateText value={h.startAt} time /> },
              {
                label: 'End',
                value: h.endAt ? (
                  <span>
                    <DateText value={h.endAt} time />
                    {trigger && (
                      <div className="basis">
                        {trigger.label} — {trigger.basis}
                      </div>
                    )}
                  </span>
                ) : (
                  <span className="muted">running (costed to now)</span>
                )
              },
              { label: 'Delivered / collected', value: `${h.deliveredAt ? new Date(h.deliveredAt).toLocaleDateString('en-GB') : '—'} / ${h.collectedAt ? new Date(h.collectedAt).toLocaleDateString('en-GB') : '—'}` },
              { label: 'Odometer out / in', value: `${h.odometerOut ?? '—'} / ${h.odometerIn ?? '—'} miles` },
              { label: 'Agreed daily rate (ex VAT)', value: <Money pence={h.dailyRatePence} /> },
              {
                label: 'Excess',
                value: (
                  <span>
                    <Money pence={h.excessPence} />
                    {h.excessWaiverDailyPence ? (
                      <span className="muted">
                        {' '}
                        · waiver <Money pence={h.excessWaiverDailyPence} />
                        /day
                      </span>
                    ) : null}
                  </span>
                )
              },
              {
                label: 'Additional drivers',
                value: h.additionalDrivers.length ? (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {h.additionalDrivers.map((d) => (
                      <li key={d.partyId}>
                        {partyName(view, d.partyId) ?? d.partyId}
                        {d.nonStandardRisk ? <Badge tone="amber" className="small"> non-standard risk · £5.50/day capped £110 (benchmark)</Badge> : <span className="muted"> · standard risk, no charge</span>}
                        {d.evidenceIds.length ? <span className="xs muted"> · {d.evidenceIds.length} evidence</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None'
                )
              },
              { label: 'Signed', value: h.signedAt ? <DateText value={h.signedAt} time /> : <Badge tone="red">not signed</Badge> },
              {
                label: 'Supporting',
                value: (
                  <span className="row xs" style={{ gap: 8 }}>
                    {h.needStatementEvidenceId ? (
                      <a href={api.evidenceFileUrl(h.needStatementEvidenceId)} target="_blank" rel="noreferrer">
                        statement of need
                      </a>
                    ) : (
                      <span className="muted">no statement of need</span>
                    )}
                    {h.mitigationQuestionnaireDocumentId ? <Link to={`../documents/${h.mitigationQuestionnaireDocumentId}`}>mitigation questionnaire</Link> : <span className="muted">no mitigation questionnaire</span>}
                    {h.statementOfMeansDocumentId ? <Link to={`../documents/${h.statementOfMeansDocumentId}`}>statement of means</Link> : <span className="muted">no statement of means</span>}
                  </span>
                )
              }
            ]}
          />
        </div>
        <div className="stack">
          <div>
            <div className="small strong" style={{ marginBottom: 6 }}>
              Charges {running ? '(indicative, to now)' : ''}
            </div>
            {totals ? (
              <div className="totals">
                <span>Days on hire</span>
                <span className="right">{totals.days}</span>
                <span>
                  Hire {totals.days} × {formatGBP(totals.dailyRatePence)}
                </span>
                <span className="right">{formatGBP(totals.hirePence)}</span>
                {totals.additionalDriverPence > 0 && (
                  <>
                    <span>Additional drivers</span>
                    <span className="right">{formatGBP(totals.additionalDriverPence)}</span>
                  </>
                )}
                {totals.excessWaiverPence > 0 && (
                  <>
                    <span>Excess waiver</span>
                    <span className="right">{formatGBP(totals.excessWaiverPence)}</span>
                  </>
                )}
                <span>Net</span>
                <span className="right">{formatGBP(totals.netPence)}</span>
                <span>VAT {Math.round(totals.vatRate * 100)}%</span>
                <span className="right">{formatGBP(totals.vatPence)}</span>
                <span className="total-line">Gross</span>
                <span className="right total-line">{formatGBP(totals.grossPence)}</span>
              </div>
            ) : (
              <span className="small muted">Charges cannot be worked out for this agreement.</span>
            )}
            {totals?.benchmark && (
              <div className="basis" style={{ marginTop: 6 }} title={totals.benchmark.note}>
                At the GTA guide for the car we give ({totals.benchmark.group}, {totals.benchmark.period}): {formatGBP(totals.benchmark.hireAtGtaRatePence)}, difference {signedGBP(totals.benchmark.differencePence)} <VerificationBadge verification={totals.benchmark.verification} /> — {GTA_BENCHMARK_NOTE}
              </div>
            )}
            {likeForLike && (
              <div className="basis" style={{ marginTop: 4 }} title={totals?.likeForLike?.note}>
                {likeForLike}
              </div>
            )}
            <div className="basis" style={{ marginTop: 6 }}>
              {HIRE_DAY_CONVENTION} The invoice uses the ledger figure, not this card.
            </div>
            {totals?.warnings.map((w) => (
              <div key={w} className="notice notice-warn xs" style={{ marginTop: 6 }}>
                {w}
              </div>
            ))}
          </div>
          <div>
            <div className="small strong" style={{ marginBottom: 6 }}>
              Paperwork checklist
            </div>
            <ul className="checklist">
              {items.map((i) => (
                <li key={i.key}>
                  <span className={`tick ${i.ok ? 'ok' : 'no'}`} aria-label={i.ok ? 'done' : 'missing'}>
                    {i.ok ? '✓' : '!'}
                  </span>
                  <span title={i.basis}>
                    <div>
                      {i.label}
                      {i.at ? (
                        <span className="muted">
                          {' '}
                          · <DateText value={i.at} time />
                        </span>
                      ) : i.key !== 'cca60f' ? (
                        <span className="muted"> · not recorded</span>
                      ) : null}
                    </div>
                  </span>
                </li>
              ))}
            </ul>
            {h.enforceability.notes && (
              <p className="xs muted" style={{ marginTop: 6 }}>
                {h.enforceability.notes}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
