// owned by ap-foundation
import type { NeedsYouItem } from '../../../api/needsYouApi';

/** Props every Needs-you kind panel receives (docs/SUPREME-AUTOPILOT.md §H.3, §I.7). */
export interface NeedsYouPanelProps {
  item: NeedsYouItem;
  /** True once the item is resolved / expired / superseded (panels then show read-only). */
  closed: boolean;
}
