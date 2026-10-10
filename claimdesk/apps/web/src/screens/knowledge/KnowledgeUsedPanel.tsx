// owned by knowledge-ui
/**
 * "Knowledge used" (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 Elsewhere): the knowledge an agent was given when it drafted
 * this email or document (`GET /knowledge/used`), one chip per ref with its badges; a chip opens the item drawer.
 * Mounted on Needs-you approve_send / approve_document cards, the outbox detail and the document view. Shows nothing
 * while loading, when nothing was used, or before knowledge-use is installed: it must never get in the way of approving.
 */
import { useState } from 'react';
import type { KnowledgeUsedResponse } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { useKnowledgeUsed } from '../../api/knowledgeApi';
import { ItemDrawer, KnowledgeBadges } from './parts';
import './knowledge.css';

export function KnowledgeUsedPanel({ targetKind, targetId, card = false }: { targetKind: KnowledgeUsedResponse['targetKind']; targetId: string | undefined; card?: boolean }) {
  const q = useKnowledgeUsed(targetKind, targetId);
  const [open, setOpen] = useState<string | undefined>();
  const refs = q.data?.refs ?? [];
  if (!targetId || q.isLoading || q.error || !refs.length) return null;
  const body = (
    <div className="kn-used" aria-label="Knowledge used">
      <div className="kn-used-row">
        {refs.map((r) =>
          r.itemId ? (
            <button key={r.ref} type="button" className={`kn-used-chip${r.cited ? ' cited' : ''}`} onClick={() => setOpen(r.itemId!)} title={r.cited ? 'Cited in the text' : 'Given to the agent'}>
              {r.title ?? r.ref}
              <KnowledgeBadges badges={r.badges} />
            </button>
          ) : (
            <span key={r.ref} className={`kn-used-chip${r.cited ? ' cited' : ''}`} title={r.cited ? 'Cited in the text' : 'Given to the agent'}>
              {r.title ?? r.ref}
              <KnowledgeBadges badges={r.badges} />
            </span>
          ),
        )}
      </div>
      <span className="small muted">Outlined chips were cited in the text; the rest were only given to the agent.</span>
      <ItemDrawer itemId={open} onClose={() => setOpen(undefined)} onOpenItem={setOpen} />
    </div>
  );
  if (card) return <Card title={`Knowledge used (${refs.length})`}>{body}</Card>;
  return (
    <div className="stack-sm">
      <h4 className="kn-h">Knowledge used ({refs.length})</h4>
      {body}
    </div>
  );
}
