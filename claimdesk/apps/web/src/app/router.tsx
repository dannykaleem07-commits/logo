import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError, type RouteObject } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AuthGate } from './AuthGate';
import { LoginPage } from '../screens/login/LoginPage';
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
import { TemplatesPage } from '../screens/templates/TemplatesPage';
import { TemplateDetailPage } from '../screens/templates/TemplateDetailPage';
import { GtaRatesPage } from '../screens/gta/GtaRatesPage';
// ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §L, §P): stub pages owned by the runtime, gateway, mail, intake and casework slices.
import { NeedsYouPage } from '../screens/needsYou/NeedsYouPage';
import { AgentsPage } from '../screens/agents/AgentsPage';
import { DailyLogPage } from '../screens/dailyLog/DailyLogPage';
import { OutboxPage } from '../screens/outbox/OutboxPage';
import { IntakePage } from '../screens/intake/IntakePage';
import { AiSettingsPage } from '../screens/settings/ai/AiSettingsPage';
import { EmailSettingsPage } from '../screens/settings/email/EmailSettingsPage';
import { AutonomySettingsPage } from '../screens/settings/autonomy/AutonomySettingsPage';
import { NotificationsSettingsPage } from '../screens/settings/notifications/NotificationsSettingsPage';
import { BrainSettingsPage } from '../screens/settings/brain/BrainSettingsPage';

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
 * Route map. /login sits outside the app shell and is public; every other route is behind <AuthGate>, which sends
 * a signed-out user to /login?next=<path>. Claim-file tabs are nested under /claims/:id/* so the next stage can add
 * `overview | chronology | ledger | clocks | gates | documents | offers | vehicle | engineering | actions | flags`
 * as child routes inside ClaimFilePage without touching this file's shape.
 */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    path: '/',
    element: (
      <AuthGate>
        <AppShell />
      </AuthGate>
    ),
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
      { path: 'settings/templates', element: <TemplatesPage /> },
      { path: 'settings/templates/:id', element: <TemplateDetailPage /> },
      { path: 'settings/gta-rates', element: <GtaRatesPage /> },
      { path: 'needs-you', element: <NeedsYouPage /> },
      { path: 'needs-you/:id', element: <NeedsYouPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'daily-log', element: <DailyLogPage /> },
      { path: 'outbox', element: <OutboxPage /> },
      { path: 'outbox/:id', element: <OutboxPage /> },
      { path: 'intake', element: <IntakePage /> },
      { path: 'settings/ai', element: <AiSettingsPage /> },
      { path: 'settings/email', element: <EmailSettingsPage /> },
      { path: 'settings/autonomy', element: <AutonomySettingsPage /> },
      { path: 'settings/notifications', element: <NotificationsSettingsPage /> },
      { path: 'settings/brain', element: <BrainSettingsPage /> },
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
