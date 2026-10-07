// owned by mail
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';

/** Email (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the mail slice builds the screen. */
export function EmailSettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Email" subtitle="The IONOS mailbox the agents read and send from" />
      <Card>
        <EmptyState title="Coming in 0.4">Email arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
