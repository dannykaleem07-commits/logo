/**
 * Witness independence (live File 4): a witness connected to the claimant is not independent and the file
 * needs corroboration from a source neither party controls.
 */
import type { Party } from '../types.js';
import { compareParties, type Connection, type ConnectionField, type LinkableParty, type RegisterName } from './connections.js';
import { round2 } from './normalise.js';

export interface WitnessIndependence {
  independent: boolean;
  /** 1 = no link found; lower is worse. */
  score: number;
  reasons: string[];
  suggestedCorroboration: string[];
}

/** Score deductions per shared field between witness and claimant (or driver). */
export const WITNESS_FIELD_PENALTY: Record<ConnectionField, number> = {
  bank: 0.8,
  phone: 0.6,
  email: 0.6,
  address: 0.5,
  vehicle: 0.5,
  name: 0.3
};

/** Score deductions when the witness appears on, or links to, a register. */
export const WITNESS_REGISTER_PENALTY: Partial<Record<RegisterName, number>> = {
  staff: 0.7,
  relatives: 0.7,
  suppliers: 0.4,
  previousClients: 0.3
};

export const CORROBORATION_SUGGESTIONS: string[] = [
  'CCTV from premises, council or TfL cameras covering the location (send preservation requests now; footage is often overwritten within weeks)',
  'Dashcam footage from either vehicle or from passing vehicles',
  "The third party's own admission: a contemporaneous call note, text or written statement",
  'Police collision report or incident reference, where the police attended or were notified',
  'Telematics or black-box data from either vehicle (ask for the raw feed, sampling interval and thresholds)',
  'A second witness with no connection to either party'
];

const FIELD_LABEL: Record<ConnectionField, string> = {
  phone: 'phone number',
  email: 'email address',
  address: 'address',
  bank: 'bank account',
  vehicle: 'vehicle',
  name: 'name'
};

/**
 * Independence is lost when the witness shares a contact/financial/address field with the claimant (or driver),
 * or appears on the staff or relatives register. Name similarity alone only lowers the score.
 *
 * `connections` may come from findConnections(); direct witness–claimant comparison is always re-run here so the
 * check works even when no precomputed connections are supplied.
 */
export function witnessIndependence(witness: LinkableParty | Party, claimant: LinkableParty | Party, connections: Connection[] = []): WitnessIndependence {
  const reasons: string[] = [];
  let score = 1;
  const seen = new Set<string>();

  const direct = compareParties(witness as LinkableParty, 'witnesses', claimant as LinkableParty, 'subject');
  const relevant = connections.filter((c) => c.aId === witness.id || c.bId === witness.id);

  const note = (key: string, penalty: number, reason: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    score -= penalty;
    reasons.push(reason);
  };

  for (const c of [...direct, ...relevant]) {
    const otherId = c.aId === witness.id ? c.bId : c.aId;
    const otherRegister = c.aId === witness.id ? c.bRegister : c.aRegister;
    if (otherId === claimant.id) {
      note(`claimant|${c.field}`, WITNESS_FIELD_PENALTY[c.field], `Witness ${witness.name} shares the claimant's ${FIELD_LABEL[c.field]}: ${c.detail}.`);
      continue;
    }
    if (otherRegister === 'subject') {
      // another party on the claim (driver, passenger)
      note(`${otherId}|${c.field}`, WITNESS_FIELD_PENALTY[c.field] * 0.8, `Witness ${witness.name} shares a ${FIELD_LABEL[c.field]} with another party on the claim (${otherId}): ${c.detail}.`);
      continue;
    }
    const regPenalty = WITNESS_REGISTER_PENALTY[otherRegister];
    if (regPenalty !== undefined) {
      const label = otherRegister === 'previousClients' ? 'previous-client' : otherRegister;
      note(`${otherRegister}|${otherId}`, regPenalty, `Witness ${witness.name} matches the ${label} register on ${FIELD_LABEL[c.field]} (${otherId}): ${c.detail}.`);
    }
  }

  score = round2(Math.max(0, Math.min(1, score)));

  const hardFields = new Set<ConnectionField>(['phone', 'email', 'bank', 'address', 'vehicle']);
  const hardLink = direct.some((c) => hardFields.has(c.field)) || relevant.some((c) => {
    const otherId = c.aId === witness.id ? c.bId : c.aId;
    const otherRegister = c.aId === witness.id ? c.bRegister : c.aRegister;
    return (otherId === claimant.id && hardFields.has(c.field)) || otherRegister === 'staff' || otherRegister === 'relatives';
  });

  const independent = !hardLink && score >= 0.6;
  if (independent && reasons.length === 0) reasons.push(`No connection found between witness ${witness.name} and the claimant on phone, email, address, bank, vehicle or name.`);

  return {
    independent,
    score,
    reasons,
    suggestedCorroboration: independent ? [] : [...CORROBORATION_SUGGESTIONS]
  };
}
