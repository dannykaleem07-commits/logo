// owned by claimai-web
/**
 * The claim header's AI input button (docs/CLAIM-AI-INPUT.md §14.1): a primary button with the count of inputs waiting
 * for the owner and an "n instructions" chip; it opens the AI input tab with the update box focused.
 */
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { useAiInputPanel } from '../../../api/claimAiApi';

export function aiInputPath(claimId: string, focus = true): string {
  return `/claims/${encodeURIComponent(claimId)}/ai${focus ? '?focus=update' : ''}`;
}

export function AiInputHeaderButton({ claimId }: { claimId: string }) {
  const navigate = useNavigate();
  const panel = useAiInputPanel(claimId);
  const open = panel.data?.badge.open ?? 0;
  const instructions = panel.data?.badge.instructions ?? 0;
  return (
    <div className="aiin-header">
      <Button variant="primary" className="aiin-header-button" onClick={() => navigate(aiInputPath(claimId))} aria-label={`AI input${open ? ` (${open} waiting for you)` : ''}`}>
        AI input
        {open > 0 && (
          <span className="aiin-count" aria-hidden="true">
            {open}
          </span>
        )}
      </Button>
      {instructions > 0 && (
        <button type="button" className="aiin-header-chip" onClick={() => navigate(aiInputPath(claimId, false))}>
          {instructions} instruction{instructions === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
