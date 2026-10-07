// owned by casework
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import type { ClaimView } from '../claimFile';

/** Agent tab of the claim file (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the casework slice builds it. */
export function AgentTab({ view }: { view: ClaimView }) {
  return (
    <Card>
      <EmptyState title="Coming in 0.4">The Agent tab for {view.claim.reference} arrives with ClaimDesk Supreme.</EmptyState>
    </Card>
  );
}
