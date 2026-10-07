// owned by casework
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';

/** Brain packs (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the casework slice builds the screen. */
export function BrainSettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Brain packs" subtitle="Company rules and playbooks the agents follow" />
      <Card>
        <EmptyState title="Coming in 0.4">Brain packs arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
