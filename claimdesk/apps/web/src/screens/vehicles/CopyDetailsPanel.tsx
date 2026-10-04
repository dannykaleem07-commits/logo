import type { ExternalVehicleLink } from '@ccguk/domain';
import { PastedDetailsPanel } from './PastedDetailsPanel';
import { TotalCarCheckPanel, tccUrlFor } from './TotalCarCheckPanel';
import { applyParsed, type VehiclePickerValue } from './vehiclePicker';

/**
 * Total Car Check button + paste panel, applying the pasted details to a picker value (§E.2–E.3). Rendered by the
 * VehiclePicker when it shows the registration, and by the hosts that hide it (New claim, Vehicle tab, fleet edit).
 */
export function CopyDetailsPanel({
  registration,
  value,
  onChange,
  links,
  disabled,
  title = 'Read the details from Total Car Check'
}: {
  registration: string;
  value: VehiclePickerValue;
  onChange: (next: VehiclePickerValue) => void;
  links?: readonly ExternalVehicleLink[];
  disabled?: boolean;
  title?: string;
}) {
  return (
    <fieldset className="fieldset">
      <legend>{title}</legend>
      <div className="stack">
        <TotalCarCheckPanel registration={registration} links={links} />
        <PastedDetailsPanel
          registration={registration}
          currentMake={value.make}
          disabled={disabled}
          onUse={(r) => onChange(applyParsed(value, r.parsed, { selected: r.selected, match: r.match, pastedText: r.pastedText, url: tccUrlFor(registration, links) || undefined }))}
        />
      </div>
    </fieldset>
  );
}
