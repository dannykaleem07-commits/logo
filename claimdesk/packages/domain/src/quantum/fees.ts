/**
 * Court fees (BLUEPRINT §5.2 "Court fees (2026 tables from secondary sources)"; §10 "confirm against EX50").
 *
 * The lookup is table-driven so the knowledge base (`kb/data/court-fees.json`) can inject a verified table.
 * `defaultCourtFees` is the blueprint's own table and is marked 'unverified' throughout: it came from
 * secondary sources and must be confirmed against the HMCTS EX50 before go-live. Code never upgrades
 * the status — a human with the EX50 URL does.
 */
import type { Pence, Verification } from '../types.js';
import { formatGBP } from '../money.js';

export type FeeKind = 'issue' | 'hearing_small_claims';

export interface FeeBand {
  kind: FeeKind;
  /** Inclusive lower bound of the claim value, in pence. */
  fromPence: Pence;
  /** Inclusive upper bound of the claim value, in pence. Use `Number.MAX_SAFE_INTEGER` for an open band. */
  toPence: Pence;
  /** Fixed fee for the band. */
  feePence?: Pence;
  /** Percentage of the claim value, for ad valorem bands (e.g. 5 for 5%). */
  pct?: number;
  /** Cap applied to a percentage fee, if any. */
  capPence?: Pence;
  verification: Verification;
  note?: string;
}

export interface CourtFeeResult {
  kind: FeeKind;
  claimPence: Pence;
  feePence: Pence;
  band: FeeBand;
  verification: Verification;
  note: string;
}

export const EX50_SOURCE_NOTE = 'BLUEPRINT §5.2: 2026 figures from secondary sources — confirm against the HMCTS EX50 before go-live';

const UNVERIFIED_BLUEPRINT: Verification = { status: 'unverified', sourceNote: EX50_SOURCE_NOTE };
const UNVERIFIED_INTERMEDIATE: Verification = {
  status: 'unverified',
  sourceNote: `${EX50_SOURCE_NOTE}. Intermediate small-claims hearing bands are the builder's best knowledge of EX50 (not in the blueprint) and must be checked.`,
};

const OPEN = Number.MAX_SAFE_INTEGER;
const gbp = (pounds: number): Pence => Math.round(pounds * 100);

/** Blueprint §5.2 issue fees and small-claims hearing fees. All unverified. */
export const defaultCourtFees: FeeBand[] = [
  // --- Issue fees (money claims) ---
  { kind: 'issue', fromPence: 0, toPence: gbp(300), feePence: gbp(35), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(300) + 1, toPence: gbp(500), feePence: gbp(50), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(500) + 1, toPence: gbp(1_000), feePence: gbp(70), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(1_000) + 1, toPence: gbp(1_500), feePence: gbp(80), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(1_500) + 1, toPence: gbp(3_000), feePence: gbp(115), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(3_000) + 1, toPence: gbp(5_000), feePence: gbp(205), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(5_000) + 1, toPence: gbp(10_000), feePence: gbp(455), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'issue', fromPence: gbp(10_000) + 1, toPence: gbp(200_000), pct: 5, verification: UNVERIFIED_BLUEPRINT, note: '5% of the claim value' },
  {
    kind: 'issue',
    fromPence: gbp(200_000) + 1,
    toPence: OPEN,
    feePence: gbp(10_000),
    verification: UNVERIFIED_INTERMEDIATE,
    note: 'Maximum issue fee over £200,000 (builder’s knowledge of EX50; not stated in the blueprint). Out of CCGUK’s track range in practice.',
  },
  // --- Small claims hearing fees ---
  { kind: 'hearing_small_claims', fromPence: 0, toPence: gbp(300), feePence: gbp(27), verification: UNVERIFIED_BLUEPRINT },
  { kind: 'hearing_small_claims', fromPence: gbp(300) + 1, toPence: gbp(500), feePence: gbp(59), verification: UNVERIFIED_INTERMEDIATE },
  { kind: 'hearing_small_claims', fromPence: gbp(500) + 1, toPence: gbp(1_000), feePence: gbp(85), verification: UNVERIFIED_INTERMEDIATE },
  { kind: 'hearing_small_claims', fromPence: gbp(1_000) + 1, toPence: gbp(1_500), feePence: gbp(123), verification: UNVERIFIED_INTERMEDIATE },
  { kind: 'hearing_small_claims', fromPence: gbp(1_500) + 1, toPence: gbp(3_000), feePence: gbp(181), verification: UNVERIFIED_INTERMEDIATE },
  { kind: 'hearing_small_claims', fromPence: gbp(3_000) + 1, toPence: OPEN, feePence: gbp(346), verification: UNVERIFIED_BLUEPRINT, note: 'Over £3,000 (small claims track ceiling £10,000)' },
];

export interface CourtFeeOptions {
  kind?: FeeKind;
}

/**
 * Look up the fee for a claim value in an injected fee table (default: the blueprint table, unverified).
 * Percentage bands are rounded half-up to the penny. Throws when no band covers the value.
 */
export function courtFee(claimPence: Pence, fees: FeeBand[] = defaultCourtFees, opts: CourtFeeOptions = {}): CourtFeeResult {
  const kind = opts.kind ?? 'issue';
  if (!Number.isInteger(claimPence) || claimPence < 0) throw new Error('courtFee: claimPence must be non-negative integer pence');
  const band = fees.find((b) => b.kind === kind && claimPence >= b.fromPence && claimPence <= b.toPence);
  if (!band) throw new Error(`courtFee: no ${kind} fee band covers ${claimPence} pence`);
  let feePence: Pence;
  if (band.feePence !== undefined) feePence = band.feePence;
  else if (band.pct !== undefined) {
    feePence = Math.round((claimPence * band.pct) / 100);
    if (band.capPence !== undefined) feePence = Math.min(feePence, band.capPence);
  } else throw new Error('courtFee: fee band has neither feePence nor pct');
  const label = kind === 'issue' ? 'Issue fee' : 'Small claims hearing fee';
  const note =
    `${label} for a claim of ${formatGBP(claimPence)}: ` +
    (band.pct !== undefined ? `${band.pct}% of the claim value` : `fixed band ${formatGBP(band.fromPence)}–${band.toPence === OPEN ? 'no upper limit' : formatGBP(band.toPence)}`) +
    `. Verification: ${band.verification.status}${band.verification.sourceNote ? ` — ${band.verification.sourceNote}` : ''}. ` +
    'Court fees are recoverable as a disbursement if the claim succeeds (CPR 27.14(2)(c) on the small claims track).';
  return { kind, claimPence, feePence, band, verification: band.verification, note };
}
