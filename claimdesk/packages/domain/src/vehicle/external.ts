/**
 * Links a handler opens in their own browser to read a vehicle's details (TEMPLATES-VEHICLES-DESKTOP §E.2).
 *
 * ClaimDesk never requests these URLs (ARCHITECTURE convention 10: no scraping). The user opens the page, reads the
 * free check and copies the details back; what they copy is saved as `unverified`.
 */
import type { ExternalVehicleLink } from '../types.js';
import { normaliseRegistration } from './registration.js';

/**
 * Total Car Check free-check URL. `{REG}` is replaced by the normalised registration (upper case, no spaces).
 * The format was seen in live search results but has not been confirmed with the site owner, so it is overridable
 * (API env `TOTALCARCHECK_URL_TEMPLATE`).
 */
export const TOTAL_CAR_CHECK_URL_TEMPLATE = 'https://totalcarcheck.co.uk/FreeCheck?regno={REG}';

export const GOV_MOT_HISTORY_URL = 'https://www.check-mot.service.gov.uk/';
export const GOV_VEHICLE_ENQUIRY_URL = 'https://vehicleenquiry.service.gov.uk/';

/** `{REG}` = normaliseRegistration(reg), URI-encoded; '' for an empty registration. */
export function totalCarCheckUrl(registration: string, template: string = TOTAL_CAR_CHECK_URL_TEMPLATE): string {
  const reg = normaliseRegistration(registration ?? '');
  if (!reg) return '';
  const t = template && template.includes('{REG}') ? template : TOTAL_CAR_CHECK_URL_TEMPLATE;
  return t.split('{REG}').join(encodeURIComponent(reg));
}

/** The links offered next to a registration search. The Total Car Check link is left out for an empty registration. */
export function externalVehicleLinks(registration: string, opts: { totalCarCheckTemplate?: string } = {}): ExternalVehicleLink[] {
  const links: ExternalVehicleLink[] = [];
  const tcc = totalCarCheckUrl(registration, opts.totalCarCheckTemplate);
  if (tcc) {
    links.push({
      id: 'totalcarcheck',
      label: 'Open on Total Car Check',
      url: tcc,
      note: 'Free check in your browser. Copy the details back into ClaimDesk; they are saved as unverified.',
      verified: false,
    });
  }
  links.push(
    {
      id: 'gov_mot_history',
      label: 'GOV.UK MOT history',
      url: GOV_MOT_HISTORY_URL,
      note: 'Official MOT history service. Enter the registration there; copy anything you use back by hand (saved as unverified).',
      verified: false,
    },
    {
      id: 'gov_vehicle_enquiry',
      label: 'GOV.UK vehicle enquiry',
      url: GOV_VEHICLE_ENQUIRY_URL,
      note: 'Official DVLA vehicle enquiry (tax and MOT status). Enter the registration there; copy anything you use back by hand (saved as unverified).',
      verified: false,
    },
  );
  return links;
}
