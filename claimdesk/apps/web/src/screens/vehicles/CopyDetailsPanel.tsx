import { useState } from 'react';
import type { ExternalVehicleLink } from '@ccguk/domain';
import { PastedDetailsPanel } from './PastedDetailsPanel';
import { TotalCarCheckPanel, tccUrlFor } from './TotalCarCheckPanel';
import { applyParsed, type VehiclePickerValue } from './vehiclePickerModel';

/**
 * Total Car Check button + paste panel, applying the pasted details to a picker value (§E.2–E.3). Rendered by the
 * VehiclePicker when it shows the registration, and by the hosts that hide it (New claim, Vehicle tab, fleet edit).
 * The paste panel opens from a "Paste from Total Car Check" button (0.3 §E5) and closes again once the details are used.
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
  const [pasting, setPasting] = useState(false);
  return (
    <fieldset className="fieldset">
      <legend>{title}</legend>
      <div className="stack">
        <TotalCarCheckPanel registration={registration} links={links} />
        {pasting ? (
          <>
            <PastedDetailsPanel
              registration={registration}
              currentMake={value.make}
              disabled={disabled}
              onUse={(r) => {
                onChange(applyParsed(value, r.parsed, { selected: r.selected, match: r.match, pastedText: r.pastedText, url: tccUrlFor(registration, links) || undefined }));
                setPasting(false);
              }}
            />
            <div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPasting(false)}>
                Close the paste panel
              </button>
            </div>
          </>
        ) : (
          <div>
            <button type="button" className="btn btn-secondary btn-sm" aria-expanded={false} onClick={() => setPasting(true)} disabled={disabled}>
              Paste from Total Car Check
            </button>
          </div>
        )}
      </div>
    </fieldset>
  );
}
