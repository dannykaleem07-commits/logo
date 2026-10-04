/**
 * Guided photo capture checklist (BLUEPRINT §2 "Guided Image Capture": 8–12 shots — four corners, damage
 * close-ups, odometer, VIN plate, tyres, plus number plate and interior). Every capture records EXIF time,
 * device, GPS, upload time and SHA-256 at capture.
 */
import type { GuidedShot } from '../types.js';

export interface GuidedShotInstruction {
  shot: GuidedShot;
  instruction: string;
  required: boolean;
}

const BASE: GuidedShotInstruction[] = [
  { shot: 'front_left', required: true, instruction: 'Stand at the front-left corner, about 3 metres back, and frame the whole vehicle including the front and nearside.' },
  { shot: 'front_right', required: true, instruction: 'Stand at the front-right corner, about 3 metres back, and frame the whole vehicle including the front and offside.' },
  { shot: 'rear_left', required: true, instruction: 'Stand at the rear-left corner, about 3 metres back, and frame the whole vehicle including the rear and nearside.' },
  { shot: 'rear_right', required: true, instruction: 'Stand at the rear-right corner, about 3 metres back, and frame the whole vehicle including the rear and offside.' },
  { shot: 'number_plate', required: true, instruction: 'Photograph the rear number plate square-on so every character is legible.' },
  { shot: 'vin_plate', required: true, instruction: 'Photograph the VIN plate (windscreen base or door shut) so the 17-character VIN is legible.' },
  { shot: 'odometer', required: true, instruction: 'With the ignition on, photograph the odometer so the mileage and the units (miles/km) are legible. Repeat at delivery and at collection.' },
  { shot: 'damage_close_1', required: true, instruction: 'Close-up of the main damage area from about 1 metre, with a panel edge in frame for scale.' },
  { shot: 'damage_close_2', required: true, instruction: 'Second close-up of the damage from a different angle, showing its extent across adjoining panels.' },
  { shot: 'damage_close_3', required: false, instruction: 'Any further damage area, or the same damage with a coin or hand in frame for scale.' },
  { shot: 'tyre_fl', required: false, instruction: 'Front-left tyre: tread face and sidewall, showing wear and any damage.' },
  { shot: 'interior', required: false, instruction: 'Interior from the driver door: dashboard warning lights, airbag condition, seats and any loose items.' }
];

const ALL_TYRES: GuidedShotInstruction[] = [
  { shot: 'tyre_fr', required: false, instruction: 'Front-right tyre: tread face and sidewall, showing wear and any damage.' },
  { shot: 'tyre_rl', required: false, instruction: 'Rear-left tyre: tread face and sidewall, showing wear and any damage.' },
  { shot: 'tyre_rr', required: false, instruction: 'Rear-right tyre: tread face and sidewall, showing wear and any damage.' }
];

export interface GuidedShotListOptions {
  /** Include all four tyres (15 shots) rather than the representative front-left tyre (12 shots). */
  includeAllTyres?: boolean;
}

/** Ordered checklist for the guided-capture overlay: 12 shots by default, 7 of them required. */
export function guidedShotList(opts: GuidedShotListOptions = {}): GuidedShotInstruction[] {
  const list = BASE.map((s) => ({ ...s }));
  if (opts.includeAllTyres) {
    const idx = list.findIndex((s) => s.shot === 'tyre_fl');
    list.splice(idx + 1, 0, ...ALL_TYRES.map((s) => ({ ...s })));
  }
  return list;
}
