// owned by intake-web
/**
 * Claim Overview: the case brief from the intake bundle this claim was registered from (docs/SMART-INTAKE.md §6.13,
 * §11.5). Renders nothing when the claim did not come from a bundle (GET /claims/:id/intake-brief → 404). Collapsible.
 */
import { useState } from 'react';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { useClaimIntakeBrief, type CaseBriefView } from '../../../api/bundlesApi';
import { CaseBriefBody } from '../../intake/bundles/CaseBriefView';
import '../../intake/bundles/bundles.css';

/** A usable brief (an older API, or an unexpected body, renders nothing rather than breaking the Overview). */
export function isCaseBrief(x: unknown): x is CaseBriefView {
  const b = x as Partial<CaseBriefView> | null | undefined;
  return Boolean(
    b && typeof b.summary === 'string' && b.claim && Array.isArray(b.facts) && Array.isArray(b.missing) && Array.isArray(b.nextActions) && Array.isArray(b.signals) && b.liability && b.autopilot && b.request && b.filed,
  );
}

export function IntakeBriefCard({ claimId }: { claimId: string }) {
  const q = useClaimIntakeBrief(claimId);
  const [open, setOpen] = useState(true);
  if (!isCaseBrief(q.data)) return null;
  const brief = q.data;
  return (
    <Card
      title="Case brief (from the documents)"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open ? <CaseBriefBody brief={brief} compact /> : <p className="small muted">{brief.summary}</p>}
    </Card>
  );
}
