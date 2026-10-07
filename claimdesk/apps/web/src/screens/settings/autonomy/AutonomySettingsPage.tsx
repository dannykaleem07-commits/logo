// owned by runtime
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';

/** Autonomy (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the runtime slice builds the screen. */
export function AutonomySettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Autonomy" subtitle="What the agents may do without asking you" />
      <Card>
        <EmptyState title="Coming in 0.4">Autonomy arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
