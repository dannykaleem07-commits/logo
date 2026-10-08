/**
 * Settings → 3D models as a page (for a `/settings/models3d` route; the integrator adds the route). The Settings page
 * itself shows the same manager inside `Models3dCard`, so this page is optional.
 */
import { Link } from 'react-router-dom';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Models3dManager } from './Models3dManager';

export function Models3dSettingsPage() {
  return (
    <div className="page">
      <PageHeader
        title="3D vehicle models"
        subtitle="Exact models you hold a licence for, mapped to damage zones"
        actions={
          <Link className="btn btn-secondary" to="/settings">
            Settings
          </Link>
        }
      />
      <Card>
        <Models3dManager />
      </Card>
    </div>
  );
}

export default Models3dSettingsPage;
