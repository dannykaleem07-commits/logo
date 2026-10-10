// owned by knowledge-ui
/**
 * Knowledge screen (docs/SUPREME-KNOWLEDGE-BUILDER.md §11). STUB created by knowledge-core: the route `/knowledge` and
 * the nav entry exist; knowledge-ui builds the tabs (This week, Approve, Gaps, Insurers, Library, Sources, Versions,
 * Safety) here, against `api/knowledgeApi.ts`.
 */
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

export function KnowledgePage() {
  return (
    <div className="page">
      <PageHeader title="Knowledge" subtitle="What ClaimDesk has learned from your claims, your edits and official sources." />
      <Card>
        <EmptyState title="Coming in 0.5">
          The knowledge screen arrives in ClaimDesk 0.5. Nothing learned is used until you can see and undo it here.
        </EmptyState>
      </Card>
    </div>
  );
}
