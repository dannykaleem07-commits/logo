// owned by runtime
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';

/** Notifications (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the runtime slice builds the screen. */
export function NotificationsSettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Notifications" subtitle="Pop-ups, quiet hours and the daily log" />
      <Card>
        <EmptyState title="Coming in 0.4">Notifications arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
