// owned by casework
import type { Basis } from '@ccguk/domain';
import { basisLabel } from '../../../../api/caseworkApi';

/** "Based on" chips (§E.7): fact, KB entry, pack entry, rule, event, evidence, memory, message. */
export function BasisChips({ basis }: { basis: Basis[] }) {
  if (!basis.length) return null;
  return (
    <div className="ag-chips" aria-label="Based on">
      {basis.map((b, i) => (
        <span key={`${b.kind}:${b.id}:${i}`} className="ag-chip" title={`${b.kind}: ${b.id}`}>
          <span className="ag-chip-kind">{b.kind}</span>
          {basisLabel(b)}
        </span>
      ))}
    </div>
  );
}
