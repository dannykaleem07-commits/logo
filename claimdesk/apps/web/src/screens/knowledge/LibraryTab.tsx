// owned by knowledge-ui
/**
 * Knowledge ▸ Library (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 5): every item, with filters; and "what would an agent
 * see": a search through `/knowledge/search` with an optional claim and agent that shows exactly the knowledge block
 * the agent would get. Item detail (the drawer) shows the version chain, provenance, check history, usage and
 * conflicts, with Retire and Record a check.
 */
import { useState } from 'react';
import { AGENT_NAMES, KNOWLEDGE_AREAS, KNOWLEDGE_KINDS, KNOWLEDGE_STATUSES, KNOWLEDGE_VERIFICATIONS, type KnowledgeArea, type KnowledgeItemsQuery, type KnowledgeKind, type KnowledgeStatus, type KnowledgeVerification } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { AGENT_LABEL } from '../../api/agentsApi';
import { useKnowledgeItems, useKnowledgeSearch } from '../../api/knowledgeApi';
import { KnowledgeBadges, QueryGate } from './parts';
import { AREA_LABEL, KIND_LABEL, STATUS_LABEL, STATUS_TONE, humanise, scopeLabel, whenText } from './knowledgeView';

const PAGE = 50;

export function LibraryTab({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<KnowledgeStatus | 'all'>('active');
  const [kind, setKind] = useState<KnowledgeKind | ''>('');
  const [area, setArea] = useState<KnowledgeArea | ''>('');
  const [verification, setVerification] = useState<KnowledgeVerification | ''>('');
  const [offset, setOffset] = useState(0);
  const query: KnowledgeItemsQuery = { status, ...(kind ? { kind } : {}), ...(area ? { area } : {}), ...(verification ? { verification } : {}), ...(text.trim() ? { q: text.trim() } : {}), limit: PAGE, offset };
  const q = useKnowledgeItems(query);
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setOffset(0));
  return (
    <div className="stack">
      <AgentPreview />
      <Card title="All knowledge" flush>
        <div className="row kn-filters kn-pad">
          <input className="input" type="search" placeholder="Search titles and text" aria-label="Search knowledge" value={text} onChange={(e) => reset(setText)(e.target.value)} />
          <select className="select" aria-label="Status" value={status} onChange={(e) => reset(setStatus)(e.target.value as KnowledgeStatus | 'all')}>
            <option value="all">Any status</option>
            {KNOWLEDGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Kind" value={kind} onChange={(e) => reset(setKind)(e.target.value as KnowledgeKind | '')}>
            <option value="">Any kind</option>
            {KNOWLEDGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Area" value={area} onChange={(e) => reset(setArea)(e.target.value as KnowledgeArea | '')}>
            <option value="">Any area</option>
            {KNOWLEDGE_AREAS.map((a) => (
              <option key={a} value={a}>
                {AREA_LABEL[a]}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Checked" value={verification} onChange={(e) => reset(setVerification)(e.target.value as KnowledgeVerification | '')}>
            <option value="">Checked or not</option>
            {KNOWLEDGE_VERIFICATIONS.map((v) => (
              <option key={v} value={v}>
                {humanise(v)}
              </option>
            ))}
          </select>
        </div>
        <QueryGate q={q} what="The library">
          {items.length ? (
            <div className="table-wrap">
              <table className="table" aria-label="Knowledge items">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Applies to</th>
                    <th scope="col">Badges</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <button type="button" className="kn-link" onClick={() => onOpenItem(i.id)}>
                          {i.title}
                        </button>
                        <span className="small muted"> v{i.version}</span>
                      </td>
                      <td className="small">{KIND_LABEL[i.kind]}</td>
                      <td className="small">{scopeLabel(i.scope)}</td>
                      <td>
                        <KnowledgeBadges badges={i.badges} supportN={i.supportN} />
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
                      </td>
                      <td className="small">{whenText(i.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row-between kn-pad">
                <span className="small muted">
                  {offset + 1}–{offset + items.length} of {total}
                </span>
                <span className="row">
                  <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Previous
                  </Button>
                  <Button size="sm" variant="ghost" disabled={offset + items.length >= total} onClick={() => setOffset(offset + PAGE)}>
                    Next
                  </Button>
                </span>
              </div>
            </div>
          ) : (
            <EmptyState title="Nothing matches">Change the filters, or wait for the learners to propose something.</EmptyState>
          )}
        </QueryGate>
      </Card>
    </div>
  );
}

/** "Exactly what an agent sees" (§11 Library): the ranked hits and the block injected into its prompt. */
function AgentPreview() {
  const [text, setText] = useState('');
  const [claimId, setClaimId] = useState('');
  const [agent, setAgent] = useState('case_manager');
  const [submitted, setSubmitted] = useState<{ q: string; claimId: string; agent: string } | null>(null);
  const q = useKnowledgeSearch(submitted?.q ?? '', submitted?.claimId ?? '', submitted?.agent ?? '');
  return (
    <Card title="What would an agent see?">
      <form
        className="row kn-filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length >= 2) setSubmitted({ q: text.trim(), claimId: claimId.trim(), agent });
        }}
      >
        <input className="input kn-grow" type="search" placeholder="e.g. Aviva handling reference" aria-label="Agent search" value={text} onChange={(e) => setText(e.target.value)} />
        <input className="input" placeholder="Claim id (optional)" aria-label="Claim id" value={claimId} onChange={(e) => setClaimId(e.target.value)} />
        <select className="select" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {AGENT_NAMES.map((a) => (
            <option key={a} value={a}>
              {AGENT_LABEL[a] ?? humanise(a)}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={text.trim().length < 2}>
          Show
        </Button>
      </form>
      {submitted && (
        <QueryGate q={q} what="The agent preview">
          {q.data && (
            <div className="stack-sm" style={{ marginTop: 12 }}>
              {q.data.hits.length ? (
                <ol className="kn-hits">
                  {q.data.hits.map((h) => (
                    <li key={h.ref}>
                      <div className="row">
                        <strong>{h.title}</strong>
                        <KnowledgeBadges badges={h.badges} supportN={h.computed?.n ?? null} />
                        <span className="small muted">
                          {h.ref} · {h.layer} · score {h.score.toFixed(2)}
                          {h.mayCiteOutbound ? ' · may be cited' : ' · internal'}
                        </span>
                      </div>
                      {h.whyRanked.length > 0 && <div className="small muted">{h.whyRanked.join('; ')}</div>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="small muted">Nothing would be shown to the agent for this.</p>
              )}
              {q.data.block && (
                <details>
                  <summary className="small">The exact block the agent gets</summary>
                  <pre className="kn-block">{q.data.block}</pre>
                </details>
              )}
            </div>
          )}
        </QueryGate>
      )}
    </Card>
  );
}
