import { useNavigate, useParams } from 'react-router-dom';
import type { ClaimView } from '../claimFile';
import { EstimateEditor } from './engineering/EstimateEditor';
import { PavWorkbench } from './engineering/PavWorkbench';
import { TotalLossPanel } from './engineering/TotalLossPanel';
import { EngineerReportForm } from './engineering/EngineerReportForm';

const SECTIONS = [
  { id: 'estimate', label: 'Estimate' },
  { id: 'pav', label: 'PAV workbench' },
  { id: 'total-loss', label: 'Total loss' },
  { id: 'report', label: "Engineer's report" }
] as const;

type Section = (typeof SECTIONS)[number]['id'];

/** Engineering: estimate editor, PAV workbench, total-loss panel and the engineer's report (BLUEPRINT §4). */
export function EngineeringTab({ view }: { view: ClaimView }) {
  const { '*': rest } = useParams();
  const navigate = useNavigate();
  const current = ((rest ?? '').split('/')[0] || 'estimate') as Section;
  const section = SECTIONS.some((s) => s.id === current) ? current : 'estimate';
  return (
    <div className="stack">
      <div className="subtabs" role="tablist" aria-label="Engineering sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" className="subtab" aria-selected={s.id === section} onClick={() => navigate(`/claims/${view.claim.id}/engineering/${s.id}`)}>
            {s.label}
          </button>
        ))}
      </div>
      {section === 'estimate' && <EstimateEditor view={view} />}
      {section === 'pav' && <PavWorkbench view={view} />}
      {section === 'total-loss' && <TotalLossPanel view={view} />}
      {section === 'report' && <EngineerReportForm view={view} />}
    </div>
  );
}
