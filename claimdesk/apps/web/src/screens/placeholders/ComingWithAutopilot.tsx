// owned by ap-foundation
import type { ReactNode } from 'react';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/**
 * Placeholder for an Autopilot screen or panel that its slice has not built yet (docs/SUPREME-AUTOPILOT.md §K web stubs).
 * Every stub renders this, so the routes, tabs and Needs-you panels are wired before the screens land.
 */
export function ComingWithAutopilot({ title, children, bare = false }: { title: string; children?: ReactNode; bare?: boolean }) {
  const body = (
    <EmptyState title={`${title}: coming with Autopilot`} icon="🛠">
      {children ?? 'This part of the Autopilot (fleet booking, clash checks, paperwork and signing) is on the next build stage.'}
    </EmptyState>
  );
  return bare ? body : <Card>{body}</Card>;
}
