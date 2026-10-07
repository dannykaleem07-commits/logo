// owned by gateway
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';

/** AI (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the gateway slice builds the screen. */
export function AiSettingsPage() {
  return (
    <div className="page">
      <PageHeader title="AI" subtitle="Claude sign-in, models and usage" />
      <Card>
        <EmptyState title="Coming in 0.4">AI arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
