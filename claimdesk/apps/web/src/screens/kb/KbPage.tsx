import { useEffect, useState } from 'react';
import { plainText } from '../../lib/plainText';
import { useSearchParams } from 'react-router-dom';
import type { KbEntry, KbEntryType } from '@ccguk/domain';
import '../../styles/screens.css';
import { useGtaRates, useKbAdvise, useKbSearch, useTemplates } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge, VerificationBadge } from '../../components/Badge';
import { Select, TextInput } from '../../components/Form';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Money } from '../../components/Money';
import { Table, type Column } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { citationChips, DEFAULT_FORUM_CHECKS, GTA_BENCHMARK_NOTE, KB_TOPICS, KB_TYPE_LABEL, KB_TYPES, LICENCE_NOTE, planByStage, sortResults, topicLabel, unverifiedCitations, type CitationChip, type KbAdviceView } from './kb';

/** Knowledge base (BLUEPRINT §5): search with citations, the advisor, the get-paid-faster plan and GTA benchmark rates. */
export function KbPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'search';
  const setView = (v: string) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    setParams(next, { replace: true });
  };
  return (
    <div className="page">
      <PageHeader title="Knowledge base" subtitle="Curated, cited, human-approved. Unverified citations are flagged here and blocked by the consistency engine in any draft that relies on them." />
      <Tabs items={[{ id: 'search', label: 'Search' }, { id: 'advisor', label: 'Advisor' }, { id: 'plan', label: 'Get paid faster' }, { id: 'rates', label: 'GTA rates' }]} value={view} onChange={setView} ariaLabel="Knowledge base views" />
      <div style={{ marginTop: 16 }}>
        {view === 'advisor' ? <AdvisorPanel /> : view === 'plan' ? <PlanPanel /> : view === 'rates' ? <RatesPanel /> : <SearchPanel />}
      </div>
    </div>
  );
}

function SearchPanel() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [submitted, setSubmitted] = useState(params.get('q') ?? '');
  const type = (params.get('type') ?? '') as KbEntryType | '';
  const topic = params.get('topic') ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSubmitted(q.trim());
      if ((params.get('q') ?? '') !== q.trim()) setParam('q', q.trim());
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const search = useKbSearch({ q: submitted, type: type || undefined, topic: topic || undefined, limit: 30 });
  const results = sortResults(search.data ?? []);

  return (
    <Card flush>
      <div className="toolbar">
        <TextInput label="Search" type="search" value={q} onChange={setQ} placeholder="e.g. impecuniosity pleading, GTA 4.8, ICOBS 8.2.6" autoFocus />
        <Select<KbEntryType> label="Type" value={type} onChange={(v) => setParam('type', v)} placeholder="Any type" options={KB_TYPES.map((t) => ({ value: t, label: KB_TYPE_LABEL[t] }))} />
        <Select label="Topic" value={topic} onChange={(v) => setParam('topic', v)} placeholder="Any topic" options={KB_TOPICS} />
      </div>
      {!submitted ? (
        <EmptyState title="Type to search the knowledge base">Cases, statutes, CPR, GTA paragraphs, FCA Handbook, FOS, guidance and fees — each with its verification status and licence.</EmptyState>
      ) : search.isLoading ? (
        <Loading label="Searching…" />
      ) : search.error ? (
        <div style={{ padding: 16 }}>
          <ApiErrorNotice error={search.error} what="search the knowledge base" />
        </div>
      ) : results.length === 0 ? (
        <EmptyState title="No entries match">Try a citation fragment (e.g. "EWCA Civ 733") or a topic filter.</EmptyState>
      ) : (
        <div>
          {results.map((e) => (
            <ResultCard key={e.id} entry={e} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ResultCard({ entry }: { entry: KbEntry }) {
  return (
    <article className="kb-result">
      <div className="row-between">
        <span className="row" style={{ gap: 8 }}>
          <span className="kb-cite">{entry.citation}</span>
          <Badge tone={entry.type === 'gta' ? 'navy' : 'grey'}>{KB_TYPE_LABEL[entry.type]}</Badge>
        </span>
        <VerificationBadge verification={entry.verification} />
      </div>
      <div className="strong small" style={{ marginTop: 4 }}>
        {entry.title}
      </div>
      <p className="kb-principle">{entry.principle}</p>
      {entry.type === 'gta' && <p className="basis">{GTA_BENCHMARK_NOTE}</p>}
      {entry.verification.status !== 'verified' && (
        <div className="notice notice-warn" style={{ marginTop: 6 }}>
          <strong>Unverified citation.</strong> Check it on {entry.url ? 'the linked source' : 'Find Case Law / legislation.gov.uk'} before relying on it in a letter{entry.verification.sourceNote ? ` — ${entry.verification.sourceNote}` : ''}.
        </div>
      )}
      <div className="row xs muted" style={{ marginTop: 6 }}>
        {entry.url && (
          <a href={entry.url} target="_blank" rel="noreferrer noopener">
            Open source ↗
          </a>
        )}
        {entry.licence && <span title={LICENCE_NOTE[entry.licence]}>{entry.licence}</span>}
        {entry.topics.map((t) => (
          <Badge key={t} tone="grey">
            {topicLabel(t)}
          </Badge>
        ))}
      </div>
    </article>
  );
}

function CitationChips({ chips }: { chips: CitationChip[] }) {
  return (
    <span className="chip-row" style={{ marginTop: 4 }}>
      {chips.map((c) =>
        c.url ? (
          <a key={c.id} className={`cite-chip ${c.unverified ? 'unverified' : ''}`} href={c.url} target="_blank" rel="noreferrer noopener" title={`${c.title ?? ''}${c.unverified ? ' — UNVERIFIED' : ''}`}>
            {c.label}
            {c.unverified ? ' ?' : ''}
          </a>
        ) : (
          <span key={c.id} className={`cite-chip ${c.unverified ? 'unverified' : ''}`} title={`${c.title ?? ''}${c.unverified ? ' — UNVERIFIED' : ''}`}>
            {c.label}
            {c.unverified ? ' ?' : ''}
          </span>
        )
      )}
    </span>
  );
}

function AdvisorPanel() {
  const [params, setParams] = useSearchParams();
  const topic = params.get('topic') ?? '';
  const advise = useKbAdvise(topic || undefined);
  const advice = advise.data as KbAdviceView | undefined;
  const setTopic = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('topic', v);
    else next.delete('topic');
    setParams(next, { replace: true });
  };
  const unverified = advice ? unverifiedCitations(advice) : [];
  const forums = advice?.forumChecks ?? DEFAULT_FORUM_CHECKS;

  return (
    <div className="grid-2">
      <div className="stack">
        <Card title="Advisor">
          <Select label="Topic" value={topic} onChange={setTopic} placeholder="Pick a topic" options={KB_TOPICS} autoFocus />
          <p className="basis" style={{ marginTop: 12 }}>
            Guidance is assembled from the cited knowledge base for a handler to read. It is not legal advice to the client and nothing here is sent to anyone; documents still go draft → consistency check → approval.
          </p>
        </Card>
        {!topic ? (
          <Card>
            <EmptyState title="Pick a topic" />
          </Card>
        ) : advise.isLoading ? (
          <Card>
            <Loading label="Assembling guidance…" />
          </Card>
        ) : advise.error ? (
          <ApiErrorNotice error={advise.error} what="load the advice" />
        ) : advice ? (
          <Card title={topicLabel(topic)}>
            <p>{advice.summary}</p>
            {unverified.length > 0 && (
              <div className="notice notice-warn" role="alert" style={{ marginBottom: 12 }}>
                <strong>
                  {unverified.length} unverified citation{unverified.length === 1 ? '' : 's'}:
                </strong>{' '}
                {unverified.join(', ')}. The consistency engine flags any draft relying on these — verify on the source first.
              </div>
            )}
            {advice.points.length === 0 ? (
              <EmptyState title="No points returned" />
            ) : (
              <ol className="advice-points">
                {advice.points.map((p, i) => (
                  <li key={i}>
                    {p.text}
                    <CitationChips chips={citationChips(p.citations, advice.entries)} />
                  </li>
                ))}
              </ol>
            )}
            {advice.caveats.length > 0 && (
              <>
                <h4 style={{ marginTop: 16 }}>Caveats</h4>
                <ul className="small">
                  {advice.caveats.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            {advice.perimeter && advice.perimeter.length > 0 && (
              <div className="notice notice-danger" style={{ marginTop: 12 }}>
                <strong>Perimeter.</strong> {advice.perimeter.join(' ')}
              </div>
            )}
          </Card>
        ) : null}
      </div>
      <div className="stack">
        <Card title="Forum check" flush>
          <ul className="list">
            {forums.map((f) => (
              <li key={f.forum}>
                <div className="list-main">
                  <div className="list-title">{f.forum}</div>
                  <div className="list-sub">{f.basis}</div>
                </div>
                <Badge tone={f.open ? 'green' : 'red'} dot>
                  {f.open ? 'open' : 'not open'}
                </Badge>
              </li>
            ))}
          </ul>
          <div className="card-footer xs muted">Naming a forum that is not open is blocked in drafts (FORUM_NOT_OPEN). Litigation documents are drafts for the claimant or an instructed solicitor to sign.</div>
        </Card>
        {advice?.entries && advice.entries.length > 0 && (
          <Card title="Entries cited" flush>
            {sortResults(advice.entries).map((e) => (
              <ResultCard key={e.id} entry={e} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

function PlanPanel() {
  const templates = useTemplates();
  const titleFor = (id: string | undefined) => templates.data?.find((t) => t.id === id)?.title;
  const groups = planByStage();
  let n = 0;
  return (
    <div className="stack">
      <div className="notice notice-info">
        <strong>Get-paid-faster playbook (BLUEPRINT §7).</strong> The claim file's <em>Next actions</em> tab shows which of these are due now for a given claim and which are blocked by an evidence gate. Steps marked <Badge tone="navy">benchmark</Badge> rest on GTA wording: an industry benchmark, not a legal entitlement (CCGUK is not a subscriber).
      </div>
      {groups.map((g) => (
        <Card key={g.stage} title={g.label} flush>
          <ol className="plan-steps">
            {g.steps.map((s) => {
              n += 1;
              return (
                <li key={s.code}>
                  <span className="n">{n}</span>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="strong">{s.title}</span>
                      {s.benchmarkOnly && <Badge tone="navy">benchmark</Badge>}
                    </div>
                    <div className="small" style={{ marginTop: 2 }}>
                      {plainText(s.why)}
                    </div>
                    <div className="row xs muted" style={{ marginTop: 6 }}>
                      {s.basis.map(plainText).filter(Boolean).map((b) => (
                        <span key={b} className="cite-chip">
                          {b}
                        </span>
                      ))}
                      {s.templateId && (
                        <span title={titleFor(s.templateId) ? `${titleFor(s.templateId)} — generate from a claim file → Documents` : 'Generate from a claim file → Documents'}>
                          Template: <code>{s.templateId}</code>
                          {titleFor(s.templateId) ? ` · ${titleFor(s.templateId)}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      ))}
    </div>
  );
}

function RatesPanel() {
  const rates = useGtaRates();
  type Row = NonNullable<typeof rates.data>[number];
  const columns: Column<Row>[] = [
    { key: 'group', header: 'Group', render: (r) => <Badge tone="navy">{r.group}</Badge> },
    { key: 'desc', header: 'Description', render: (r) => r.description ?? <span className="muted">—</span> },
    { key: 'rate', header: 'Daily rate (ex VAT)', numeric: true, render: (r) => <Money pence={r.dailyRatePence} /> },
    { key: 'period', header: 'Period', render: (r) => `${r.period} (${r.effectiveFrom} → ${r.effectiveTo})` },
    { key: 'verification', header: 'Verification', render: (r) => <VerificationBadge verification={r.verification} /> }
  ];
  return (
    <Card title="GTA maximum daily rates" flush>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <p className="basis">{GTA_BENCHMARK_NOTE} 2026–27 rates apply to new hires from 1 July 2026 (e.g. S1 £42.32, M £56.66, M1 £65.49 ex VAT). Templates say "industry benchmark"; the consistency engine flags GTA_CITED_AS_LAW otherwise.</p>
      </div>
      {rates.isLoading ? <Loading /> : rates.error ? <div style={{ padding: 16 }}><ApiErrorNotice error={rates.error} what="load GTA rates" /></div> : <Table columns={columns} rows={rates.data ?? []} rowKey={(r) => `${r.group}-${r.period}`} empty={<EmptyState title="No rates loaded" />} />}
    </Card>
  );
}
