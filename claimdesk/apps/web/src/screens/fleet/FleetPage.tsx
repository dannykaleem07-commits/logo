import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import '../../styles/screens.css';
import { useFleet, useFleetAlerts, usePenalties } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Badge } from '../../components/Badge';
import { isTerminalStage, type FleetUnitView } from './fleet';
import { UnitsTab } from './UnitsTab';
import { PenaltiesTab } from './PenaltiesTab';
import { PenaltyDialog } from './PenaltyDialog';
// Autopilot (docs/SUPREME-AUTOPILOT.md §I.3, §I.4, §C.5): built by ap-booking (calendar, movements) and ap-clash (clashes).
import { CalendarTab } from './CalendarTab';
import { MovementsTab } from './MovementsTab';
import { ClashesTab } from './ClashesTab';
import { LocationsTab } from './LocationsTab';

/**
 * Fleet (BLUEPRINT §3.12, lesson l): /fleet → units + alerts; /fleet/penalties → PCN / NIP workflow.
 * The "Log notice" dialog is shared by both tabs so a unit row can open it pre-filled.
 */
export function FleetPage() {
  const fleet = useFleet();
  const alerts = useFleetAlerts();
  const penalties = usePenalties();
  const [notice, setNotice] = useState<{ unitId?: string } | null>(null);
  const units = (fleet.data ?? []) as FleetUnitView[];
  const openPenalties = (penalties.data ?? []).filter((p) => !isTerminalStage(p.stage)).length;
  const blocking = (alerts.data ?? []).filter((a) => a.severity === 'block').length;

  return (
    <div className="page">
      <PageHeader
        title="Fleet"
        subtitle={fleet.data ? `${units.length} unit${units.length === 1 ? '' : 's'} · ${units.filter((u) => u.status === 'on_hire').length} on hire · declared use and policy cover checked before every allocation` : 'Units, compliance alerts and the PCN / NIP workflow'}
      />
      <nav className="subnav" aria-label="Fleet sections">
        <NavLink to="/fleet" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Units & alerts {blocking > 0 && <Badge tone="red">{blocking}</Badge>}
        </NavLink>
        <NavLink to="/fleet/penalties" className={({ isActive }) => (isActive ? 'active' : '')}>
          Penalties {openPenalties > 0 && <Badge tone="amber">{openPenalties}</Badge>}
        </NavLink>
        <NavLink to="/fleet/calendar" className={({ isActive }) => (isActive ? 'active' : '')}>
          Calendar
        </NavLink>
        <NavLink to="/fleet/movements" className={({ isActive }) => (isActive ? 'active' : '')}>
          Movements
        </NavLink>
        <NavLink to="/fleet/clashes" className={({ isActive }) => (isActive ? 'active' : '')}>
          Clashes
        </NavLink>
        <NavLink to="/fleet/locations" className={({ isActive }) => (isActive ? 'active' : '')}>
          Locations
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<UnitsTab onLogNotice={(unitId) => setNotice({ unitId })} />} />
        <Route path="penalties" element={<PenaltiesTab onLogNotice={() => setNotice({})} />} />
        <Route path="calendar" element={<CalendarTab />} />
        <Route path="movements" element={<MovementsTab />} />
        <Route path="clashes" element={<ClashesTab />} />
        <Route path="locations" element={<LocationsTab />} />
        <Route path="*" element={<Navigate to="/fleet" replace />} />
      </Routes>
      <PenaltyDialog open={notice !== null} units={units} initialUnitId={notice?.unitId} onClose={() => setNotice(null)} />
    </div>
  );
}
