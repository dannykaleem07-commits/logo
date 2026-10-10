// owned by knowledge-ui
/**
 * Knowledge ▸ Insurers (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 4): per insurer, what your own claims show. The list
 * gives n, median working days to pay, % paid and the top objection. The detail shows the 12-month and all-time tables
 * with n ("too few claims" below the minimum), contacts (learned and directory, with badges), procedures, documents
 * they ask for, letter effectiveness, unlinked parties (link tool) and a link to the directory. Statistics are COMPUTED:
 * internal only, never stated in a letter.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HeadOfLoss, InsurerProfileData } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { knowledgeApi, useInsurerLinks, useInsurerProfile, useInsurerProfiles, useKnowledgeMutation } from '../../api/knowledgeApi';
import { KnowledgeBadges, QueryGate } from './parts';
import { humanise, num1, pct, whenText } from './knowledgeView';

/** Fewer claims than this and the figures say "too few claims" (KB §11). */
export const TOO_FEW = 3;

export function InsurersTab({ slug, onSlug, onOpenItem }: { slug: string | undefined; onSlug: (s: string | undefined) => void; onOpenItem: (id: string) => void }) {
  const q = useInsurerProfiles();
  const rows = q.data?.insurers ?? [];
  return (
    <div className={slug ? 'kn-split' : 'stack'}>
      <QueryGate q={q} what="Insurer profiles">
        {rows.length ? (
          <div className="table-wrap card">
            <table className="table" aria-label="Insurers">
              <thead>
                <tr>
                  <th scope="col">Insurer</th>
                  <th scope="col">Claims (n)</th>
                  <th scope="col">Median days to pay</th>
                  <th scope="col">% paid</th>
                  <th scope="col">Top objection</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.insurerSlug} className={r.insurerSlug === slug ? 'kn-row-selected' : undefined}>
                    <td>
                      <button type="button" className="kn-link" onClick={() => onSlug(r.insurerSlug)}>
                        {r.name ?? r.insurerSlug}
                      </button>
                    </td>
                    <td>{r.claims}</td>
                    <td>{r.claims < TOO_FEW ? <span className="muted small">too few claims</span> : num1(r.medianWorkingDaysToPay)}</td>
                    <td>{r.claims < TOO_FEW ? '—' : pct(r.paidOfClaimedPct)}</td>
                    <td>{r.topObjection ? humanise(r.topObjection) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted kn-pad">Worked out from your own claims (working days, London). Internal only: never stated in a letter.</p>
          </div>
        ) : (
          <EmptyState title="No insurer statistics yet">They appear after the nightly statistics run once claims have outcomes.</EmptyState>
        )}
      </QueryGate>
      {slug && <InsurerDetail slug={slug} onClose={() => onSlug(undefined)} onOpenItem={onOpenItem} />}
    </div>
  );
}

function ProfileTable({ title, p, minN }: { title: string; p: InsurerProfileData | null; minN: number }) {
  if (!p) return <p className="small muted">{title}: not computed yet.</p>;
  const few = p.n.claims < Math.max(minN, TOO_FEW);
  const heads = Object.entries(p.heads) as [HeadOfLoss, NonNullable<InsurerProfileData['heads'][HeadOfLoss]>][];
  return (
    <div className="stack-sm">
      <h4 className="kn-h">
        {title} <span className="small muted">n = {p.n.claims} claims, {p.n.settled} settled · computed {whenText(p.computedAt)}</span>
      </h4>
      {few ? (
        <p className="small muted">Too few claims to say anything yet (fewer than {Math.max(minN, TOO_FEW)}).</p>
      ) : (
        <table className="table kn-data">
          <tbody>
            <tr>
              <th scope="row">Working days to pay</th>
              <td>
                median {num1(p.daysToPay.medianWorkingDays)} · 90th percentile {num1(p.daysToPay.p90WorkingDays)} (n {p.daysToPay.n})
              </td>
            </tr>
            {heads.map(([h, v]) => (
              <tr key={h}>
                <th scope="row">{humanise(h)}</th>
                <td>
                  {v.n < TOO_FEW ? (
                    <span className="muted">too few claims (n {v.n})</span>
                  ) : (
                    <>
                      paid {pct(v.paidOfClaimedPct?.median)} of claimed · first offer {pct(v.firstOfferOfClaimedPct?.median)} · reduced on {pct(v.reductionRatePct)} (n {v.n})
                    </>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">Reply time</th>
              <td>
                median {num1(p.responseHours.median)} hours (n {p.responseHours.n}) · chasers before payment {num1(p.chasersBeforePay.median)}
              </td>
            </tr>
            {p.objections.length > 0 && (
              <tr>
                <th scope="row">Objections</th>
                <td>{p.objections.slice(0, 5).map((o) => `${humanise(o.intent)} ${pct(o.pct)}`).join(' · ')}</td>
              </tr>
            )}
            {p.gta.subscriberClaims > 0 && (
              <tr>
                <th scope="row">GTA (benchmark only)</th>
                <td>
                  {p.gta.subscriberClaims} claims · hire paid at GTA rate {pct(p.gta.hirePaidAtGtaRatePct)} · first-notification disputes {pct(p.gta.firstNotificationDisputePct)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InsurerDetail({ slug, onClose, onOpenItem }: { slug: string; onClose: () => void; onOpenItem: (id: string) => void }) {
  const q = useInsurerProfile(slug);
  const p = q.data;
  const minN = TOO_FEW;
  return (
    <Card title={p?.name ?? slug} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <QueryGate q={q} what="This insurer">
        {p && (
          <div className="stack">
            <div className="row">
              <Badge tone="blue">COMPUTED</Badge>
              <span className="small muted">From your own claims · internal only</span>
              <Link className="small" to="/directory">
                Directory entry
              </Link>
            </div>
            {p.tooFewClaims && <div className="notice notice-info">Too few claims for reliable figures yet: treat everything here as a first impression.</div>}
            <ProfileTable title="Last 12 months" p={p.profile12m} minN={minN} />
            <ProfileTable title="All time" p={p.profileAll} minN={minN} />

            <section>
              <h4 className="kn-h">Contacts</h4>
              {p.contacts.length ? (
                <ul className="kn-lines">
                  {p.contacts.map((c, i) => {
                    const d = (c.item?.data ?? c.directory ?? {}) as Record<string, unknown>;
                    return (
                      <li key={c.item?.id ?? `dir-${i}`}>
                        <div className="row">
                          <strong>{String(d.team ?? d.name ?? (c.item ? c.item.title : 'Directory'))}</strong>
                          {c.item ? <KnowledgeBadges badges={c.badges} supportN={c.item.supportN} /> : <Badge tone="grey">DIRECTORY</Badge>}
                          {c.item && (
                            <button type="button" className="kn-link small" onClick={() => onOpenItem(c.item!.id)}>
                              open
                            </button>
                          )}
                        </div>
                        <div className="small">
                          {[d.name && d.team ? d.name : null, d.role, d.phone, d.email, d.ivr ? `menu: ${d.ivr}` : null, d.hours].filter(Boolean).join(' · ') || '—'}
                          {typeof d.observations === 'number' ? <span className="muted"> · learned from {d.observations} email{d.observations === 1 ? '' : 's'}</span> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="small muted">No contacts yet.</p>
              )}
            </section>

            {p.procedures.length > 0 && (
              <section>
                <h4 className="kn-h">Procedures</h4>
                <ul className="kn-lines">
                  {p.procedures.map(({ item, data }) => (
                    <li key={item.id}>
                      <button type="button" className="kn-link" onClick={() => onOpenItem(item.id)}>
                        {item.title}
                      </button>{' '}
                      <KnowledgeBadges badges={item.badges} supportN={item.supportN} />
                      <ol className="small">
                        {data.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h4 className="kn-h">Documents they ask for</h4>
              {p.docsRequested.length ? (
                <ul className="kn-lines">
                  {p.docsRequested.map((d) => (
                    <li key={d.doc} className="small">
                      {humanise(d.doc)} <span className="muted">({d.claims} claims)</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">None recorded.</p>
              )}
            </section>

            {p.stepEffectiveness.length > 0 && (
              <section>
                <h4 className="kn-h">What worked</h4>
                <ul className="kn-lines">
                  {p.stepEffectiveness.map((s) => (
                    <li key={s.id} className="small">
                      <button type="button" className="kn-link" onClick={() => onOpenItem(s.id)}>
                        {s.title}
                      </button>{' '}
                      <KnowledgeBadges badges={s.badges} supportN={s.supportN} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <UnlinkedParties slug={slug} parties={p.unlinkedParties} />
          </div>
        )}
      </QueryGate>
    </Card>
  );
}

/** Parties on claims not yet linked to an insurer: one click links them (human-only, audited `knowledge.link.set`). */
export function UnlinkedParties({ slug, parties }: { slug: string; parties: { partyId: string; name: string; claims: number }[] }) {
  const toast = useToast();
  const all = useInsurerLinks(true);
  const link = useKnowledgeMutation((partyId: string) => knowledgeApi.setInsurerLink(partyId, slug));
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? (all.data?.parties ?? parties) : parties;
  return (
    <section>
      <div className="row-between">
        <h4 className="kn-h">Parties not yet linked</h4>
        <button type="button" className="kn-link small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'only likely matches' : 'show every unlinked party'}
        </button>
      </div>
      {list.length ? (
        <ul className="kn-lines">
          {list.map((u) => (
            <li key={u.partyId} className="row-between">
              <span>
                {u.name} <span className="small muted">({u.claims} claims)</span>
              </span>
              <Button size="sm" loading={link.isPending && link.variables === u.partyId} onClick={() => link.mutate(u.partyId, { onSuccess: () => toast.success(`Linked ${u.name} to ${slug}`), onError: (e) => toast.error((e as Error).message) })}>
                Link to {slug}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Every likely party is linked.</p>
      )}
      <ApiErrorNotice error={link.error} what="link the party" />
      <p className="small muted">Links decide which insurer's statistics a claim uses. ClaimDesk links only exact name, brand or email-domain matches by itself; your links always win.</p>
    </section>
  );
}
