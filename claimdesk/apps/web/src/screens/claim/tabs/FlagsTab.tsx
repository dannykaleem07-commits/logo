import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import type { ClaimView } from '../claimFile';
import { FlagsBanner } from '../components/FlagsBanner';

const FLAG_MEANING: Array<{ code: string; meaning: string }> = [
  { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', meaning: 'A CCGUK fleet registration was entered as the client vehicle (lessons f, h). Hard stop until corrected.' },
  { code: 'DUPLICATE_REGISTRATION', meaning: 'Another claim exists on this registration. Linked but separate files: own ledger, documents and insurer.' },
  { code: 'NON_INDEPENDENT_WITNESS', meaning: 'A witness is connected to the claimant (lesson g). Corroborate with CCTV or the third party’s own account.' },
  { code: 'LEGACY_DETAIL', meaning: 'A legacy name, number or address was found (lesson i). Never let it reach a letter.' },
  { code: 'INJURY_REFERRAL', meaning: 'Injury reported: the injury element is referred out with no fee (lesson j); CCGUK continues the damage-only claim.' },
  { code: 'HIRE_ENFORCEABILITY_GAP', meaning: 'Cancellation information, Sch 3 form, express request or art 60F not recorded (W v Veolia risk).' },
  { code: 'MILEAGE_CONFLICT', meaning: 'Odometer readings disagree across documents (lesson e). Resolve before the engineer’s report issues.' },
  { code: 'SUPPLIER_RISK', meaning: 'A counterparty is in strike-off or has overdue filings (lesson k). Expect challenges to its invoices.' }
];

export function FlagsTab({ view }: { view: ClaimView }) {
  const flags = [...(view.flags ?? view.claim.flags)].sort((a, b) => Number(Boolean(a.clearedAt)) - Number(Boolean(b.clearedAt)) || b.raisedAt.localeCompare(a.raisedAt));
  return (
    <div className="stack">
      <Card title="Flags" actions={<span className="small muted">{flags.filter((f) => !f.clearedAt).length} open · {flags.filter((f) => f.clearedAt).length} cleared</span>}>
        {flags.length === 0 ? <EmptyState title="No flags on this file">Flags are raised by the system (cross-file checks, connected parties, legacy details) or by a handler.</EmptyState> : <FlagsBanner claimId={view.claim.id} flags={flags} showCleared />}
      </Card>
      <Card title="What the codes mean" flush>
        <ul className="list">
          {FLAG_MEANING.map((f) => (
            <li key={f.code}>
              <div className="list-main">
                <div className="list-title mono xs">{f.code}</div>
                <div className="list-sub">{f.meaning}</div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
