import type { GateResult } from '@ccguk/domain';
import { plainText } from '../../../lib/plainText';

const GATE_LABEL: Record<GateResult['gate'], string> = {
  need: 'Need',
  use: 'Use',
  period: 'Period',
  rate: 'Rate',
  impecuniosity: 'Impecuniosity',
  mitigation: 'Mitigation',
  enforceability: 'Enforceability',
  liability: 'Liability'
};

const GATE_WHY: Record<GateResult['gate'], string> = {
  need: 'Why a replacement vehicle was needed at all: occupation, journeys, dependants, other household vehicles (signed statement).',
  use: 'That the hire car was actually used: odometer and photo at delivery and collection, mileage prompts, fuel receipts.',
  period: 'Why hire ran as long as it did: roadworthiness, engineer dates, repair authorisation, parts delays, total-loss payment date (the chronology).',
  rate: 'That the rate is reasonable: agreement rate, GTA group (benchmark), basic hire rate comparators, excess terms.',
  impecuniosity: 'Lagden v O’Connor: statement of means, 3 months’ bank statements, credit limits, income — pleaded and proved (Diriye v Bojaj).',
  mitigation: 'Every insurer offer logged with the client’s decision and reasons; Mitigation Questionnaire with statement of truth.',
  enforceability: 'Cancellation information, Sch 3 form, express request to start, signed agreement (W v Veolia; Dimond v Lovell).',
  liability: 'Highway Code rules, CCTV or dashcam, an independent witness, no contradiction with the third-party account.'
};

const STATUS_WORD: Record<GateResult['status'], string> = { green: 'Complete', amber: 'Partial', red: 'Missing' };

/** The eight evidence gates as tiles; expanding one lists what is present and what is missing. */
export function GatesRow({ gates, expanded = false }: { gates: GateResult[]; expanded?: boolean }) {
  if (gates.length === 0) return <p className="small muted">Gates are evaluated by the API once the claim has services agreed.</p>;
  return (
    <div className="gates-row" role="list">
      {gates.map((g) => (
        <details key={g.gate} className={`gate-tile ${g.status}`} open={expanded || undefined} role="listitem">
          <summary title={g.missing.length ? `Missing: ${g.missing.map(plainText).join('; ')}` : 'Complete'}>
            <span className="gate-name">{GATE_LABEL[g.gate] ?? g.gate}</span>
            <span className="gate-light">{STATUS_WORD[g.status]}</span>
          </summary>
          <div className="gate-detail">
            <p style={{ margin: '6px 0 0' }}>{GATE_WHY[g.gate]}</p>
            {g.missing.length > 0 && (
              <>
                <strong style={{ display: 'block', marginTop: 6 }}>Missing</strong>
                <ul>
                  {g.missing.map((m) => (
                    <li key={m} className="missing">
                      {plainText(m)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {g.present.length > 0 && (
              <>
                <strong style={{ display: 'block', marginTop: 6 }}>On file</strong>
                <ul>
                  {g.present.map((m) => (
                    <li key={m} className="present">
                      {plainText(m)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function gateLabel(gate: GateResult['gate'] | string): string {
  return (GATE_LABEL as Record<string, string>)[gate] ?? gate;
}
