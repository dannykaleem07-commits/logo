// owned by ap-foundation
/**
 * Needs-you kind → panel registry (docs/SUPREME-AUTOPILOT.md §H.3, §I.7). The Needs-you page renders the registered
 * panel for an item's kind above the generic prepared-item view. Each Autopilot slice provides its own panels (the
 * files are theirs); this map is the only shared place they are registered.
 */
import type { ComponentType } from 'react';
import type { NeedsYouKind } from '@ccguk/domain';
import type { NeedsYouPanelProps } from './panels/types';
import { ChooseCarPanel } from './panels/ChooseCarPanel';
import { AutopilotStepPanel } from './panels/AutopilotStepPanel';
import { ApprovePackPanel } from './panels/ApprovePackPanel';
import { ConfirmSignedPanel } from './panels/ConfirmSignedPanel';
import { ClashReviewPanel } from './panels/ClashReviewPanel';
import { EligibilityReviewPanel } from './panels/EligibilityReviewPanel';
import { BundleReadyPanel } from './panels/BundleReadyPanel';

export type { NeedsYouPanelProps };

export const KIND_PANELS: Readonly<Partial<Record<NeedsYouKind, ComponentType<NeedsYouPanelProps>>>> = {
  choose_car: ChooseCarPanel, // ap-autopilot
  autopilot_step: AutopilotStepPanel, // ap-autopilot
  approve_pack: ApprovePackPanel, // ap-paperwork
  confirm_signed: ConfirmSignedPanel, // ap-paperwork
  clash_review: ClashReviewPanel, // ap-clash
  eligibility_review: EligibilityReviewPanel, // ap-clash
  new_claim: BundleReadyPanel, // intake-web: renders only for case bundles (payload.bundleId), else nothing
};

/** The registered panel for a kind, if any. */
export function panelFor(kind: NeedsYouKind): ComponentType<NeedsYouPanelProps> | undefined {
  return KIND_PANELS[kind];
}
