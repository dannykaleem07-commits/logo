// owned by ap-clash
/**
 * Clash panel (docs/SUPREME-AUTOPILOT.md §C.5): block findings red with "Override as manager" (class A, manager mode,
 * reason box), warn amber with "I've read this", info grey. Shown in the booking dialog, the Autopilot tab and Flags.
 * Stub created by ap-foundation (§K) with the agreed props; built by ap-clash.
 */
import type { ClashFinding } from '@ccguk/domain';
import { ComingWithAutopilot } from '../../placeholders/ComingWithAutopilot';

export interface ClashPanelProps {
  findings: ClashFinding[];
  managerMode: boolean;
  onAcknowledge(id: string, reason: string): void;
  onOverride(reason: string): void;
}

export function ClashPanel({ findings }: ClashPanelProps) {
  return (
    <ComingWithAutopilot title="Clash checks" bare>
      {findings.length ? `${findings.length} clash finding${findings.length === 1 ? '' : 's'} recorded.` : null}
    </ComingWithAutopilot>
  );
}
