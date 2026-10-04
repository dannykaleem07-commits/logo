import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/** Stand-in for screens built in the next stage. Replace the route element in app/router.tsx; keep the path. */
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="page">
      <PageHeader title={title} subtitle={description} />
      <Card>
        <EmptyState title={`${title} is being built`} icon="🛠">
          This screen is on the next build stage. The API routes it needs are already in <code>src/api/client.ts</code> and hooks in <code>src/api/hooks.ts</code>.
        </EmptyState>
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader title="Page not found" />
      <Card>
        <EmptyState title="There is nothing at this address" action={<Link className="btn btn-primary" to="/">Back to dashboard</Link>} />
      </Card>
    </div>
  );
}
