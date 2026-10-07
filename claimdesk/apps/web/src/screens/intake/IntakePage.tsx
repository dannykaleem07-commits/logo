// owned by intake
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/** Intake (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the intake slice builds the screen. */
export function IntakePage() {
  return (
    <div className="page">
      <PageHeader title="Intake" subtitle="Files read by the agents and the details they found" />
      <Card>
        <EmptyState title="Coming in 0.4">Intake arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
