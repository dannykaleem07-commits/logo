import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError, type RouteObject } from 'react-router-dom';
import { AppShell } from './AppShell';
import { DashboardPage } from '../screens/dashboard/DashboardPage';
import { ClaimsListPage } from '../screens/claims/ClaimsListPage';
import { NewClaimPage } from '../screens/claims/new/NewClaimPage';
import { ClaimFilePage } from '../screens/claim/ClaimFilePage';
import { NotFoundPage } from '../screens/placeholders/PlaceholderPage';
import { FleetPage } from '../screens/fleet/FleetPage';
import { DirectoryPage } from '../screens/directory/DirectoryPage';
import { KbPage } from '../screens/kb/KbPage';
import { AnalyticsPage } from '../screens/analytics/AnalyticsPage';
import { SettingsPage } from '../screens/settings/SettingsPage';
import { CapturePage } from '../screens/capture/CapturePage';
import { WatchPage } from '../screens/watch/WatchPage';

function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : 'Unknown error';
  return (
    <div className="error-box" role="alert">
      <h2>{isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : 'Something went wrong'}</h2>
      <pre>{message}</pre>
      <Link className="btn btn-primary" to="/">
        Back to dashboard
      </Link>
    </div>
  );
}

/**
 * Route map. Claim-file tabs are nested under /claims/:id/* so the next stage can add
 * `overview | chronology | ledger | clocks | gates | documents | offers | vehicle | engineering | actions | flags`
 * as child routes inside ClaimFilePage without touching this file's shape.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'claims', element: <ClaimsListPage /> },
      { path: 'claims/new', element: <NewClaimPage /> },
      { path: 'claims/:id/*', element: <ClaimFilePage /> },
      { path: 'fleet/*', element: <FleetPage /> },
      { path: 'directory', element: <DirectoryPage /> },
      { path: 'kb', element: <KbPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'watch', element: <WatchPage /> },
      { path: 'capture', element: <CapturePage /> },
      { path: 'capture/:claimId', element: <CapturePage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
];

/** Browser router for main.tsx. Tests build a memory router from `routes` instead (see router.smoke.test.tsx). */
export function createAppRouter() {
  return createBrowserRouter(routes);
}
