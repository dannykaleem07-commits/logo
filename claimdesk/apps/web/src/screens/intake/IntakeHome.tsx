// owned by intake-web
/**
 * /intake (docs/SMART-INTAKE.md §11.1): two tabs — Case bundles (default; files read together into one claim) and
 * Single files (the per-file Intake screen, unchanged). The tab is kept in the address (`?tab=files`).
 */
import { useSearchParams } from 'react-router-dom';
import { Tabs } from '../../components/Tabs';
import { IntakePage } from './IntakePage';
import { BundlesListPage } from './bundles/BundlesListPage';
import './bundles/bundles.css';

type IntakeTab = 'bundles' | 'files';

export function IntakeHome() {
  const [params, setParams] = useSearchParams();
  const tab: IntakeTab = params.get('tab') === 'files' ? 'files' : 'bundles';
  return (
    <div className="bdl-home">
      <div className="bdl-hometabs">
        <Tabs
          ariaLabel="Intake"
          items={[
            { id: 'bundles', label: 'Case bundles' },
            { id: 'files', label: 'Single files' },
          ]}
          value={tab}
          onChange={(id) => setParams(id === 'files' ? { tab: 'files' } : {}, { replace: true })}
        />
      </div>
      <div role="tabpanel" id={`tabpanel-${tab}`}>
        {tab === 'files' ? <IntakePage /> : <BundlesListPage />}
      </div>
    </div>
  );
}
