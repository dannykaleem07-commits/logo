// owned by mail
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import type { ClaimView } from '../claimFile';

/** Mailbox tab of the claim file (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the mail slice builds it. */
export function MailboxTab({ view }: { view: ClaimView }) {
  return (
    <Card>
      <EmptyState title="Coming in 0.4">The Mailbox tab for {view.claim.reference} arrives with ClaimDesk Supreme.</EmptyState>
    </Card>
  );
}
