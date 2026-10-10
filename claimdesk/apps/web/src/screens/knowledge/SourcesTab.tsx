// owned by knowledge-ui
/**
 * Knowledge ▸ Sources (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 6): the allow-list (policy, licence, extract allowed,
 * enabled, self-test result, fetches today against the limit), a snapshot browser with diff, the FCL licence record and
 * the FCA key note (Settings ▸ AI), the owner-added domain form and the deny list with reasons (read-only).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceView } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Checkbox, Select, TextInput } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { knowledgeApi, useKnowledgeMutation, useKnowledgeSettings, useKnowledgeSnapshotDiff, useKnowledgeSnapshots, useKnowledgeSources } from '../../api/knowledgeApi';
import { QueryGate } from './parts';
import { humanise, whenText } from './knowledgeView';

const POLICY_LABEL: Record<SourceView['policy'], string> = { api: 'Official API', code_fetch: 'Fetched by code', agent_fetch: 'Fetched for research', link_only: 'Link only', deny: 'Never used' };

interface SelftestResult {
  at?: string;
  ok?: boolean;
  status?: number;
  detail?: string;
  inconclusive?: boolean;
}

export function SourcesTab() {
  const q = useKnowledgeSources();
  const toast = useToast();
  const [browse, setBrowse] = useState<string | undefined>();
  const toggle = useKnowledgeMutation((v: { domain: string; enabled: boolean }) => knowledgeApi.toggleSource(v.domain, v.enabled));
  const selftest = useKnowledgeMutation(() => knowledgeApi.selftest());
  const sources = q.data?.sources ?? [];
  const allowed = sources.filter((s) => s.policy !== 'deny');
  const denied = sources.filter((s) => s.policy === 'deny');
  const fcaPresent = (q.data as { fcaKeyPresent?: boolean } | undefined)?.fcaKeyPresent;
  return (
    <div className="stack">
      <QueryGate q={q} what="Sources">
        <Card
          title={`Allowed sources (${allowed.length})`}
          flush
          actions={
            <Button size="sm" loading={selftest.isPending} onClick={() => selftest.mutate(undefined, { onSuccess: () => toast.success('Self-test queued'), onError: (e) => toast.error((e as Error).message) })}>
              Run the self-test
            </Button>
          }
        >
          {allowed.length ? (
            <div className="table-wrap">
              <table className="table" aria-label="Allowed sources">
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Use</th>
                    <th scope="col">Licence</th>
                    <th scope="col">Extract</th>
                    <th scope="col">Self-test</th>
                    <th scope="col">Today</th>
                    <th scope="col">On</th>
                  </tr>
                </thead>
                <tbody>
                  {allowed.map((s) => {
                    const st = (s.selftest ?? null) as SelftestResult | null;
                    return (
                      <tr key={s.domain}>
                        <td>
                          <button type="button" className="kn-link" onClick={() => setBrowse(s.domain)}>
                            {s.domain}
                          </button>
                          {s.origin !== 'builtin' && <span className="small muted"> ({s.origin === 'owner' ? 'added by you' : 'insurer directory'})</span>}
                        </td>
                        <td className="small">{POLICY_LABEL[s.policy] ?? s.policy}</td>
                        <td className="small">{s.licence}</td>
                        <td className="small">{s.extractAllowed ? `yes (quotes up to ${s.maxQuoteWords} words)` : 'no'}</td>
                        <td>{st?.at ? <Badge tone={st.ok ? 'green' : st.inconclusive ? 'amber' : 'red'} title={st.detail}>{st.ok ? 'passed' : st.inconclusive ? 'unclear' : 'failed'}</Badge> : <span className="small muted">not run</span>}</td>
                        <td className="small">
                          {s.fetchesToday} / {s.perDay}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Use ${s.domain}`}
                            checked={s.enabled}
                            disabled={toggle.isPending}
                            onChange={(e) => toggle.mutate({ domain: s.domain, enabled: e.target.checked }, { onSuccess: () => toast.success(`${s.domain} ${e.target.checked ? 'enabled' : 'disabled'}`), onError: (err) => toast.error((err as Error).message) })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No sources">The built-in allow-list appears once research is installed.</EmptyState>
          )}
          <ApiErrorNotice error={toggle.error} what="change the source" />
        </Card>
        {browse && <SnapshotBrowser domain={browse} onClose={() => setBrowse(undefined)} />}
        <div className="kn-two">
          <AddSourceForm />
          <LicenceCard fcaPresent={fcaPresent} />
        </div>
        <Card title={`Never used (${denied.length})`}>
          {denied.length ? (
            <ul className="kn-lines">
              {denied.map((s) => (
                <li key={s.domain}>
                  <strong>{s.domain}</strong> <span className="small muted">{s.access || s.licence || 'denied'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No denied sites listed.</p>
          )}
        </Card>
      </QueryGate>
    </div>
  );
}

function LicenceCard({ fcaPresent }: { fcaPresent: boolean | undefined }) {
  const s = useKnowledgeSettings();
  const toast = useToast();
  const [reference, setReference] = useState('');
  const save = useKnowledgeMutation((ref: string) => knowledgeApi.patchSettings({ fclTransactionalLicence: { recorded: true, reference: ref, at: new Date().toISOString() } }));
  const lic = s.data?.fclTransactionalLicence;
  return (
    <Card title="Licences and keys">
      <div className="stack-sm">
        <div>
          <strong>Find Case Law transactional licence</strong>
          <div className="small">{lic?.recorded ? `Recorded: ${lic.reference ?? '—'}${lic.at ? ` on ${whenText(lic.at)}` : ''}${lic.by ? ` by ${lic.by}` : ''}` : 'Not recorded. Without it, judgments are linked, never copied.'}</div>
        </div>
        <div className="row">
          <TextInput label="Licence reference" value={reference} onChange={setReference} />
          <Button disabled={!reference.trim()} loading={save.isPending} onClick={() => save.mutate(reference.trim(), { onSuccess: () => (toast.success('Licence recorded'), setReference('')), onError: (e) => toast.error((e as Error).message) })}>
            Record
          </Button>
        </div>
        <ApiErrorNotice error={save.error} what="record the licence" />
        <div>
          <strong>FCA Handbook API key</strong>
          <div className="small">
            {fcaPresent === true ? 'Set.' : fcaPresent === false ? 'Not set: FCA Handbook pages are linked, not searched.' : 'Optional: lets research search the FCA Handbook.'} <Link to="/settings/ai">Settings ▸ AI secrets</Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

function AddSourceForm() {
  const toast = useToast();
  const [domain, setDomain] = useState('');
  const [policy, setPolicy] = useState<'code_fetch' | 'link_only' | ''>('link_only');
  const [licence, setLicence] = useState('');
  const [note, setNote] = useState('');
  const [extract, setExtract] = useState(false);
  const add = useKnowledgeMutation(() => knowledgeApi.addSource({ domain: domain.trim().toLowerCase(), policy: (policy || 'link_only') as 'code_fetch' | 'link_only', licence: licence.trim(), ...(note.trim() ? { note: note.trim() } : {}), extractAllowed: extract }));
  return (
    <Card title="Add a site">
      <div className="kn-form">
        <TextInput label="Domain" value={domain} onChange={setDomain} placeholder="example.gov.uk" />
        <Select
          label="How it may be used"
          value={policy}
          onChange={setPolicy}
          options={[
            { value: 'link_only', label: 'Link only (never fetched)' },
            { value: 'code_fetch', label: 'Fetched by code (no AI browsing)' },
          ]}
        />
        <TextInput label="Licence" value={licence} onChange={setLicence} placeholder="e.g. Open Government Licence" />
        <Checkbox label="The licence allows keeping an extract" checked={extract} onChange={setExtract} />
        <TextInput label="Note (optional)" value={note} onChange={setNote} />
        <div className="row">
          <Button variant="primary" disabled={!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) || !licence.trim()} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => (toast.success('Site added'), setDomain(''), setLicence(''), setNote('')), onError: (e) => toast.error((e as Error).message) })}>
            Add the site
          </Button>
        </div>
        <ApiErrorNotice error={add.error} what="add the site" />
      </div>
    </Card>
  );
}

function SnapshotBrowser({ domain, onClose }: { domain: string; onClose: () => void }) {
  const q = useKnowledgeSnapshots(domain);
  const [diffOf, setDiffOf] = useState<string | undefined>();
  const snaps = q.data?.snapshots ?? [];
  return (
    <Card title={`Stored copies from ${domain}`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <QueryGate q={q} what="Stored copies">
        {snaps.length ? (
          <ul className="kn-lines">
            {snaps.map((s) => (
              <li key={s.id}>
                <div className="row-between">
                  <span>
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      {s.title ?? s.url}
                    </a>{' '}
                    <span className="small muted">
                      {whenText(s.fetchedAt)} · HTTP {s.httpStatus} · {Math.round(s.bytes / 1024)} KB · {humanise(s.reason)}
                    </span>{' '}
                    {s.changed && <Badge tone="amber">changed</Badge>} {s.injectionFlags.length > 0 && <Badge tone="red" title={s.injectionFlags.join(', ')}>suspicious text</Badge>}
                  </span>
                  {s.previousId && (
                    <Button size="sm" variant="ghost" onClick={() => setDiffOf(diffOf === s.id ? undefined : s.id)}>
                      {diffOf === s.id ? 'Hide changes' : 'What changed'}
                    </Button>
                  )}
                </div>
                {diffOf === s.id && <SnapshotDiff id={s.id} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing stored from this site yet.</p>
        )}
      </QueryGate>
    </Card>
  );
}

function SnapshotDiff({ id }: { id: string }) {
  const q = useKnowledgeSnapshotDiff(id);
  return (
    <QueryGate q={q} what="The comparison">
      {q.data && (q.data.diff ? (
        <div className="kn-diff kn-snapdiff">
          {q.data.diff.map((d, i) =>
            d.op === 'eq' ? (
              <div key={i} className="muted">
                {d.text}
              </div>
            ) : d.op === 'ins' ? (
              <ins key={i} className="kn-ins kn-block-line">
                {d.text}
              </ins>
            ) : (
              <del key={i} className="kn-del kn-block-line">
                {d.text}
              </del>
            ),
          )}
          {!q.data.diff.length && <p className="small muted">No differences.</p>}
        </div>
      ) : (
        <p className="small muted">{q.data.note ?? 'No comparison available.'}</p>
      ))}
    </QueryGate>
  );
}
