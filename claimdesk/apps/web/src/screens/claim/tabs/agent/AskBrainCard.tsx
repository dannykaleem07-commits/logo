// owned by casework
import { useState } from 'react';
import { Card } from '../../../../components/Card';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { DateText } from '../../../../components/DateText';
import { TextArea } from '../../../../components/Form';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import { caseworkApi, useCaseworkMutation, type MemoryNote } from '../../../../api/caseworkApi';
import { askError } from './agentView';
import { BasisChips } from './BasisChips';

/** "Ask the brain" (§L.9): the question goes to the researcher; the answer is saved as a note on the claim. */
export function AskBrainCard({ claimId, notes }: { claimId: string; notes: MemoryNote[] }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [touched, setTouched] = useState(false);
  const ask = useCaseworkMutation(claimId, (question: string) => caseworkApi.ask(claimId, question));
  const err = touched ? askError(q) : undefined;
  const research = notes.filter((n) => n.kind === 'research');
  const submit = () => {
    setTouched(true);
    if (askError(q)) return;
    void ask
      .mutateAsync(q.trim())
      .then(() => {
        toast.success('Asked — the answer will appear here as a claim note');
        setQ('');
        setTouched(false);
      })
      .catch(() => undefined);
  };
  return (
    <Card title="Ask the brain">
      <div className="stack">
        <TextArea label="Question" hint="Answered from the knowledge base, your brain packs and approved memory, with citations." value={q} onChange={setQ} error={err} rows={3} />
        <div className="row">
          <Button variant="primary" loading={ask.isPending} onClick={submit}>
            Ask
          </Button>
        </div>
        <ApiErrorNotice error={ask.error} what="ask the question" />
        {research.length > 0 && (
          <ul className="list">
            {research.map((n) => (
              <li key={n.id}>
                <div className="list-main stack-sm">
                  <div className="ag-answer">{n.text}</div>
                  <BasisChips basis={n.basis} />
                  <div className="ag-meta">
                    <DateText value={n.createdAt} time /> · <Badge tone={n.status === 'approved' ? 'green' : 'amber'}>{n.status}</Badge>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
