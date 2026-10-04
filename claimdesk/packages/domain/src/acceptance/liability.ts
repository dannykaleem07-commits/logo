/**
 * Liability score (BLUEPRINT §3.1 "Liability score: Highway Code rule references, CCTV and dashcam
 * availability, independent witness, a contradiction check against the third-party version, and the
 * prior-claim check on the same registration").
 *
 * Baseline 50, then additive factors, clamped to 0..100. Keyword detection runs on the client's account
 * (taken cold, verbatim) and the third party's account; every explicit flag in `extra` overrides the
 * heuristic for its factor. The score is a triage signal, not a legal opinion.
 */
import type { AccidentDetails } from '../types.js';

export interface LiabilityExtras {
  /** The third party's account contradicts the client's on a material point (overrides the heuristic). */
  thirdPartyAccountContradicts?: boolean;
  /** Prior claims on the same registration (BLUEPRINT §3.2 cross-file check). */
  priorClaimsOnRegistration?: number;
  /** Highway Code rules the third party breached (RTA 1988 s.38(7)). */
  highwayCodeRulesAgainstThirdParty?: number[];
  /** The third party admitted fault (overrides the heuristic; an apology is not an admission). */
  thirdPartyAdmitted?: boolean;
  /** CCTV or dashcam footage is actually on the file (not merely "available"). */
  footageObtained?: boolean;
}

export interface LiabilityFactor {
  factor: string;
  delta: number;
  note: string;
}

export interface LiabilityScore {
  /** Clamped 0..100. */
  score: number;
  /** Before clamping, for the audit trail. */
  rawScore: number;
  band: 'strong' | 'arguable' | 'weak';
  factors: LiabilityFactor[];
}

export const LIABILITY_BASELINE = 50;
/** Below this the liability is "weak" for the Tescher costs-exposure test. */
export const LIABILITY_WEAK_THRESHOLD = 55;
/** Below this, with hire dwarfing the other heads, the file is declined. */
export const LIABILITY_DECLINE_THRESHOLD = 40;

const REAR_END = /\brear[- ]?end|\bshunt|\bfrom behind\b|\binto the (back|rear) of\b|\bstationary\b[^.]*\b(hit|struck)\b[^.]*\bbehind\b/i;
const ADMISSION = /\badmit(s|ted)?\b(?!\s+(no|nothing))|\baccept(s|ed)?\s+(full\s+|all\s+)?(fault|liability|responsibility|blame)\b|\b(my|his|her|their)\s+fault\b|\b(was|am|is)\s+(to blame|at fault)\b|\btook\s+(full\s+)?responsibility\b/i;
const APOLOGY = /\bapolog|\bsorry\b/i;
const CONTRADICTION = /\bden(y|ies|ied)\b|\bdisput|\bnot\s+(my|his|her|their)\s+fault\b|\b(client|claimant|our driver|he|she)\s+(moved|pulled|cut|swerved|drifted|changed|came|undertook|reversed|was speeding|jumped)\b|\bblames?\b|\bsays?\s+(that\s+)?(the\s+)?(client|claimant)\b/i;
const DISPUTE_SCENARIO = /\bmerg(e|ed|es|ing)\b|\bslip[- ]?road\b|\broundabout\b|\bcar[- ]?park\b|\bparking\s+(bay|space|area)\b|\bmulti[- ]?storey\b|\bboth\s+(changing|changed|moving|moved)\s+lanes?\b|\bsimultaneous(ly)?\s+lane\b/i;

export function detectRearEndOrClearBreach(accident: AccidentDetails, extra: LiabilityExtras): string | undefined {
  if (extra.highwayCodeRulesAgainstThirdParty && extra.highwayCodeRulesAgainstThirdParty.length > 0) {
    return `Highway Code rule${extra.highwayCodeRulesAgainstThirdParty.length > 1 ? 's' : ''} ${extra.highwayCodeRulesAgainstThirdParty.join(', ')} against the third party (RTA 1988 s.38(7))`;
  }
  if (REAR_END.test(accident.circumstances ?? '')) return 'rear-end shunt on the client’s account (Highway Code rule 126: safe stopping distance)';
  if (accident.highwayCodeRules && accident.highwayCodeRules.length > 0) {
    return `Highway Code rule${accident.highwayCodeRules.length > 1 ? 's' : ''} ${accident.highwayCodeRules.join(', ')} cited on the file (RTA 1988 s.38(7)) — confirm they run against the third party`;
  }
  return undefined;
}

export function detectDisputeScenario(accident: AccidentDetails): string | undefined {
  const text = `${accident.circumstances ?? ''} ${accident.location ?? ''}`;
  const m = DISPUTE_SCENARIO.exec(text);
  return m ? m[0].toLowerCase() : undefined;
}

export function detectContradiction(accident: AccidentDetails, extra: LiabilityExtras): boolean {
  if (typeof extra.thirdPartyAccountContradicts === 'boolean') return extra.thirdPartyAccountContradicts;
  const tp = (accident.thirdPartyAccount ?? '').trim();
  return tp.length > 0 && CONTRADICTION.test(tp);
}

export function detectAdmission(accident: AccidentDetails, extra: LiabilityExtras): 'admitted' | 'apology_only' | 'none' {
  if (extra.thirdPartyAdmitted === true) return 'admitted';
  if (extra.thirdPartyAdmitted === false) return 'none';
  const tp = accident.thirdPartyAccount ?? '';
  if (ADMISSION.test(tp)) return 'admitted';
  if (APOLOGY.test(tp)) return 'apology_only';
  return 'none';
}

export function liabilityBand(score: number): LiabilityScore['band'] {
  if (score >= 70) return 'strong';
  if (score >= LIABILITY_WEAK_THRESHOLD) return 'arguable';
  return 'weak';
}

export function scoreLiability(accident: AccidentDetails, extra: LiabilityExtras = {}): LiabilityScore {
  const factors: LiabilityFactor[] = [{ factor: 'baseline', delta: LIABILITY_BASELINE, note: 'Every file starts at 50: liability is unknown until evidence says otherwise.' }];

  const breach = detectRearEndOrClearBreach(accident, extra);
  if (breach) factors.push({ factor: 'clear_breach_by_third_party', delta: 25, note: `Clear Highway Code breach by the third party: ${breach}.` });

  const admission = detectAdmission(accident, extra);
  if (admission === 'admitted') factors.push({ factor: 'third_party_admission', delta: 20, note: 'Third party admitted fault. Get it in writing or on a recorded line; an admission at the scene is often withdrawn once the insurer is involved.' });
  else if (admission === 'apology_only') factors.push({ factor: 'third_party_apology', delta: 0, note: 'The third party apologised. An apology is not an admission of liability (Compensation Act 2006 s.2) — no uplift.' });

  if (accident.independentWitness) factors.push({ factor: 'independent_witness', delta: 15, note: 'Independent witness identified. Take a signed statement now; run the connected-party check before relying on it (BLUEPRINT §3.9).' });

  const footageAvailable = accident.cctvAvailable === true || accident.dashcamAvailable === true;
  if (footageAvailable) {
    const which = [accident.cctvAvailable && 'CCTV', accident.dashcamAvailable && 'dashcam'].filter(Boolean).join(' and ');
    if (extra.footageObtained) factors.push({ factor: 'footage_obtained', delta: 15, note: `${which} footage is on the file (hashed, original file).` });
    else factors.push({ factor: 'footage_available_not_obtained', delta: 8, note: `${which} reported available but not yet obtained: obtain within 7 days (most systems overwrite within weeks). Full +15 once the original file is on the file.` });
  }

  if (accident.policeAttended) factors.push({ factor: 'police_attended', delta: 5, note: `Police attended${accident.policeReference ? ` (ref ${accident.policeReference})` : ''}: request the collision report (Met Police fee £215.10 per the 2026 schedule, BLUEPRINT §7.2).` });

  if (detectContradiction(accident, extra)) factors.push({ factor: 'third_party_account_contradicts', delta: -15, note: 'The third party’s account contradicts the client’s on a material point. Independent evidence decides it; do not build the client’s account to fit (perimeter.md Part 1).' });

  const scenario = detectDisputeScenario(accident);
  if (scenario) factors.push({ factor: 'dispute_prone_scenario', delta: -20, note: `Lane-merge / roundabout / car-park scenario ("${scenario}"): liability is routinely disputed and often split without independent evidence.` });

  const prior = Math.max(0, Math.floor(extra.priorClaimsOnRegistration ?? 0));
  if (prior > 0) {
    const delta = -Math.min(20, 10 * prior);
    factors.push({ factor: 'prior_claims_same_registration', delta, note: `${prior} prior claim${prior > 1 ? 's' : ''} on the same registration (−10 each, capped at −20): expect the insurer’s linkage checks to find them; disclose, never explain away.` });
  }

  const rawScore = factors.reduce((a, f) => a + f.delta, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  return { score, rawScore, band: liabilityBand(score), factors };
}
