// owned by casework
import { useState } from 'react';
import { Card } from '../../../components/Card';
import { Badge } from '../../../components/Badge';
import { Select, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { BUSINESS_LABEL, useBrainSearch, type Business } from '../../../api/brainApi';

/** Test retrieval: what would an agent find for this question (precedence first, then relevance)? */
export function SearchCard() {
  const [q, setQ] = useState('');
  const [business, setBusiness] = useState<Business>('ccguk');
  const search = useBrainSearch(q, business);
  return (
    <Card title="Test a search">
      <div className="stack">
        <div className="row">
          <TextInput label="Search the active packs" value={q} onChange={setQ} type="search" />
          <Select label="For" value={business} onChange={(v) => v && setBusiness(v)} options={(Object.keys(BUSINESS_LABEL) as Business[]).map((b) => ({ value: b, label: BUSINESS_LABEL[b] }))} />
        </div>
        {search.isFetching && <Loading />}
        <ApiErrorNotice error={search.error} what="search the packs" />
        {search.data && (
          <ul className="list">
            {search.data.hits.length === 0 && <li className="small muted">Nothing found in the active packs.</li>}
            {search.data.hits.map((h) => (
              <li key={h.ref}>
                <div className="list-main stack-sm">
                  <div className="row">
                    <span className="list-title">{h.title}</span>
                    <Badge tone="grey">{h.kind}</Badge>
                    {h.verification && h.verification !== 'verified' && <Badge tone="amber">{h.verification}</Badge>}
                  </div>
                  <div className="list-sub">
                    {h.packName} {h.version} · precedence {h.precedence} · {h.ref}
                  </div>
                  <div className="small">{h.excerpt}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
