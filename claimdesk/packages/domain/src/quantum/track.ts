/**
 * Track allocation by value (BLUEPRINT §5.2 "Track limits": small claims up to £10,000; fast track up to
 * £25,000; intermediate track £25,000–£100,000; multi-track above). CPR 26.9 (as renumbered from 1 October
 * 2023 when the intermediate track was introduced).
 *
 * Personal-injury sub-limits (£1,000 / £5,000 for the small claims track) are deliberately not modelled:
 * CCGUK refers every injury element out and does not run injury claims (perimeter.md Part 2).
 */
import type { Pence, Track } from '../types.js';

export const TRACK_LIMITS_PENCE: Record<Exclude<Track, 'multi'>, Pence> = {
  small_claims: 1_000_000, // £10,000
  fast: 2_500_000, // £25,000
  intermediate: 10_000_000, // £100,000
};

export interface TrackOptions {
  /** True when the claim includes an injury element. Changes nothing about the value test; adds the refer-out note. */
  personalInjury?: boolean;
}

export interface TrackAllocation {
  track: Track;
  /** The value ceiling of the allocated track, or undefined for the multi-track. */
  limitPence?: Pence;
  basis: string;
  note: string;
}

export const TRACK_BASIS = 'CPR 26.9 (track limits, as stated in BLUEPRINT §5.2): small claims ≤ £10,000; fast ≤ £25,000; intermediate ≤ £100,000; otherwise multi-track. Allocation is for the court; this is the expected track by value.';

/** The expected track for a money claim of `claimPence`. */
export function allocateTrack(claimPence: Pence, opts: TrackOptions = {}): Track {
  return trackAllocation(claimPence, opts).track;
}

/** Expected track with its limit, basis and the notes a letter or bundle index needs. */
export function trackAllocation(claimPence: Pence, opts: TrackOptions = {}): TrackAllocation {
  if (!Number.isFinite(claimPence) || claimPence < 0) throw new Error('allocateTrack: claimPence must be non-negative pence');
  let track: Track;
  let limitPence: Pence | undefined;
  if (claimPence <= TRACK_LIMITS_PENCE.small_claims) {
    track = 'small_claims';
    limitPence = TRACK_LIMITS_PENCE.small_claims;
  } else if (claimPence <= TRACK_LIMITS_PENCE.fast) {
    track = 'fast';
    limitPence = TRACK_LIMITS_PENCE.fast;
  } else if (claimPence <= TRACK_LIMITS_PENCE.intermediate) {
    track = 'intermediate';
    limitPence = TRACK_LIMITS_PENCE.intermediate;
  } else {
    track = 'multi';
  }
  const notes: string[] = [];
  if (track === 'small_claims') {
    notes.push('Small claims track: fixed and limited costs recovery (CPR 27.14); the claimant is the litigant in person and CCGUK may assist as a lay representative where the claimant attends (Lay Representatives (Rights of Audience) Order 1999).');
  } else if (track === 'fast' || track === 'intermediate') {
    notes.push('Fast or intermediate track: fixed recoverable costs apply (CPR Part 45, from 1 October 2023); a costs-risk conversation with the claimant and an instructed solicitor is needed before issue.');
  } else {
    notes.push('Multi-track: outside the small-operator model; instruct a solicitor before any step.');
  }
  if (opts.personalInjury) {
    notes.push('Personal injury element present: the PI sub-limits for the small claims track are not applied because CCGUK refers injury out (LASPO 2012 ss.56–60; FCA claims-management perimeter) and runs the damage-only claim.');
  }
  notes.push('Litigation documents are drafts for signature by the claimant or an instructed solicitor (Legal Services Act 2007 s.12).');
  const out: TrackAllocation = { track, basis: TRACK_BASIS, note: notes.join(' ') };
  if (limitPence !== undefined) out.limitPence = limitPence;
  return out;
}
