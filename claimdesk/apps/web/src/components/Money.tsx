import { formatGBP } from '@ccguk/domain';
import type { Pence } from '@ccguk/domain';

/** Renders integer pence as £x,xxx.xx. Never pass pounds. */
export function Money({ pence, showPence = true, blankZero = false }: { pence: Pence | null | undefined; showPence?: boolean; blankZero?: boolean }) {
  if (pence === null || pence === undefined || Number.isNaN(pence)) return <span className="money muted">—</span>;
  if (blankZero && pence === 0) return <span className="money muted">—</span>;
  return <span className={pence < 0 ? 'money money-neg' : 'money'}>{formatGBP(pence, { showPence })}</span>;
}
