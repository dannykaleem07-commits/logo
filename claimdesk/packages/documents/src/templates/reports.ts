/**
 * Reports and schedules — the engineering and valuation documents that support every head of loss:
 *
 *   report.engineer   The engineer's report (BLUEPRINT §4.6) with CPR 35 / PD 35 content when prepared for court
 *   report.pav        The pre-accident value report (BLUEPRINT §4.3–4.4): comparables, normalisation, median, IQR, audit trail
 *   schedule.loss     The schedule of loss by head, each line with its source document, interest and totals
 *
 * Shapes follow @ccguk/domain types (Estimate, EstimateLine, EstimateTotals, TotalLossAssessment, PavSubject,
 * Comparable, SalvageCategory, HeadOfLoss). The engines compute; the API assembles; the template prints. Every
 * amount and date is printed through format.ts. The only arithmetic here is deriving an estimate line's amount
 * (hours × rate, quantity × unit price) when the API has not supplied `amountPence` on the line — section totals
 * and the net / VAT / gross figures always come from the data (EstimateTotals).
 *
 * The engineer, not CCGUK staff, signs an engineer's report; the claimant verifies a schedule of loss used in
 * proceedings (litigant in person). Nothing here implies regulated status.
 */
import type {
  Comparable,
  Estimate,
  EstimateLine,
  EstimateLineKind,
  HeadOfLoss,
  ISODate,
  ISODateTime,
  OdometerSource,
  PavSubject,
  Pence,
  SalvageCategory,
  TotalLossAssessment,
  Track
} from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type FigureRow, type Signatory, sampleBaseData, sampleRecipient } from '../common.js';
import {
  bulletList,
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatGBP,
  formatMiles,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatRate,
  formatRegistration,
  nl2p,
  numberedList,
  plural
} from '../format.js';
import { sha256Hex } from '../hash.js';
import {
  baseLayout,
  callout,
  figuresTable,
  keyValueTable,
  type ScheduleLine,
  scheduleTable,
  signatureBlock,
  statementOfTruth,
  subjectBlock
} from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const REPORT_CSS = `
.photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:3mm 0 5mm;}
figure.photo{margin:0;break-inside:avoid;page-break-inside:avoid;}
figure.photo img{display:block;width:100%;height:auto;max-height:72mm;object-fit:cover;border:1px solid var(--rule);background:var(--tint);}
figure.photo figcaption{font-size:8.5pt;margin-top:1mm;line-height:1.35;}
.hash{font-family:'Courier New',Courier,monospace;font-size:6.5pt;color:var(--silver);word-break:break-all;}
table.estimate{font-size:8.5pt;}
table.estimate tr.group{break-after:avoid;page-break-after:avoid;}
table.estimate tr.group td{background:var(--tint);color:var(--navy);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:8pt;}
table.data caption{break-after:avoid;page-break-after:avoid;}
table.estimate td.small-note{font-size:7.5pt;color:var(--silver);}
.excluded{color:#8A1C1C;font-weight:700;letter-spacing:.04em;}
table.excluded-lines td{color:#555;}
table.comparables{font-size:7.8pt;}
table.comparables th,table.comparables td{padding:1.3mm 1.6mm;}
table.comparables td.url{font-size:6.8pt;word-break:break-all;color:var(--silver);}
table.comparables td.trim{white-space:nowrap;}
table.comparables tr.excluded-row td{color:var(--silver);}
table.audit{font-size:8.5pt;}
.declaration ol>li{margin-bottom:1.4mm;}
.verdict{font-weight:700;color:var(--navy);}
`;

/** Generic header + rows table; every cell escaped. `numeric` columns are right-aligned; `rowClass` per row. */
function dataTable(
  headings: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  opts: { caption?: string; numeric?: number[]; className?: string; rowClass?: (i: number) => string; cellClass?: (col: number) => string } = {}
): string {
  if (rows.length === 0) return '';
  const numeric = new Set(opts.numeric ?? []);
  const cls = (i: number): string => {
    const parts = [numeric.has(i) ? 'num' : '', opts.cellClass ? opts.cellClass(i) : ''].filter(Boolean);
    return parts.length > 0 ? ` class="${parts.join(' ')}"` : '';
  };
  const head = `<thead><tr>${headings.map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows
    .map((r, ri) => {
      const rc = opts.rowClass ? opts.rowClass(ri) : '';
      return `<tr${rc ? ` class="${rc}"` : ''}>${r.map((cell, i) => `<td${cls(i)}>${escapeHtml(cell)}</td>`).join('')}</tr>`;
    })
    .join('\n');
  return `<table class="data${opts.className ? ` ${opts.className}` : ''}">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

const ODOMETER_SOURCE_LABELS: Record<OdometerSource, string> = {
  mot: 'MOT record',
  accident_report: 'accident report',
  handover: 'handover report',
  collection: 'collection report',
  engineer: 'read by the engineer at inspection',
  photo: 'photograph',
  v5c: 'V5C',
  client: 'stated by the claimant',
  manual: 'manual entry'
};

/** ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage, 28 May 2025. */
export const SALVAGE_CATEGORY_LABELS: Record<SalvageCategory, string> = {
  A: 'Category A — scrap only: the whole vehicle must be crushed; no parts may be re-used',
  B: 'Category B — break for parts: the body shell must be crushed; other parts may be re-used',
  S: 'Category S — structurally damaged but repairable',
  N: 'Category N — non-structurally damaged and repairable'
};

const SALVAGE_SOURCE_LABELS: Record<TotalLossAssessment['salvageSource'], string> = {
  bid: 'actual salvage bid',
  offer: 'salvage offer received',
  estimate: 'estimated — no bid yet obtained'
};

function yesNo(v: boolean): string {
  return v ? 'Yes' : 'No';
}

/** `7.2p per mile` — a fractional-pence factor, so formatGBP (integer pence) does not apply. */
export function formatPencePerMile(pencePerMile: number): string {
  const decimals = Number.isInteger(pencePerMile) ? 0 : 1;
  return `${formatNumber(pencePerMile, decimals)}p per mile`;
}

/** `+5%`, `0%`, `-3%` for the engineer's condition adjustment (whole-number percentage points). */
function formatSignedPercent(pct: number): string {
  const s = formatPercent(pct / 100);
  return pct > 0 ? `+${s}` : s;
}

// ---------------------------------------------------------------------------
// Estimate rendering (shared by report.engineer)
// ---------------------------------------------------------------------------

/** An estimate line as the API supplies it. `amountPence` is the ledger's figure for the line when it holds one. */
export type EstimateLineView = EstimateLine & { amountPence?: Pence };

/** The estimate as printed: domain Estimate without persistence ids, plus an optional reference and basis note. */
export interface EstimateView extends Omit<Estimate, 'id' | 'claimId' | 'vehicleId' | 'createdAt' | 'lines'> {
  lines: EstimateLineView[];
  reference?: string;
  /** How times and prices were arrived at: "Manual estimate; labour times from CCGUK's own labour library (medians of approved estimates); OEM part prices from the dealer". */
  basis?: string;
}

/** Amount for a line: the supplied `amountPence`, else hours × rate (labour, paint), quantity × unit price, or materials. */
export function estimateLineAmount(line: EstimateLineView, est: Pick<EstimateView, 'labourRatePence' | 'paintRatePence'>): Pence {
  if (line.amountPence !== undefined) return line.amountPence;
  if (line.hours !== undefined) {
    const rate = line.ratePence ?? (line.kind === 'paint' ? est.paintRatePence : est.labourRatePence);
    return Math.round(line.hours * rate);
  }
  if (line.unitPence !== undefined) return Math.round(line.quantity * line.unitPence);
  if (line.materialsPence !== undefined) return line.materialsPence;
  return 0;
}

const LINE_GROUP_ORDER: EstimateLineKind[] = ['labour', 'part', 'paint', 'materials', 'adas', 'diagnostic', 'specialist', 'sundry'];
const LINE_GROUP_LABELS: Record<EstimateLineKind, string> = {
  labour: 'Labour',
  part: 'Parts',
  paint: 'Paint',
  materials: 'Paint materials',
  adas: 'ADAS',
  diagnostic: 'Diagnostics',
  specialist: 'Specialist',
  sundry: 'Sundries'
};
const PART_SOURCE_LABELS: Record<NonNullable<EstimateLine['partSource']>, string> = { oem: 'OEM', aftermarket: 'aftermarket', green: 'green (recycled)', unknown: 'source not stated' };

/** `1.5 hours`, `1 hour`, `7.3 hours` — labour and paint times to one decimal place. */
export function formatHours(hours: number): string {
  const n = formatNumber(hours, Number.isInteger(hours) ? 0 : 1);
  return `${n} ${hours === 1 ? 'hour' : 'hours'}`;
}

function lineQuantity(l: EstimateLineView): string {
  if (l.hours !== undefined) return formatHours(l.hours);
  return formatNumber(l.quantity);
}

function lineRate(l: EstimateLineView, est: Pick<EstimateView, 'labourRatePence' | 'paintRatePence'>): string {
  if (l.hours !== undefined) return formatGBP(l.ratePence ?? (l.kind === 'paint' ? est.paintRatePence : est.labourRatePence));
  if (l.unitPence !== undefined) return formatGBP(l.unitPence);
  return '';
}

function lineRows(lines: ReadonlyArray<EstimateLineView>, est: EstimateView, excluded: boolean): string {
  const groups = LINE_GROUP_ORDER.filter((k) => lines.some((l) => l.kind === k));
  const out: string[] = [];
  for (const kind of groups) {
    out.push(`<tr class="group"><td colspan="6">${escapeHtml(LINE_GROUP_LABELS[kind])}${excluded ? ' — EXCLUDED' : ''}</td></tr>`);
    for (const l of lines.filter((x) => x.kind === kind)) {
      const item = `${l.panel ? `${escapeHtml(l.panel)}: ` : ''}${escapeHtml(l.description)}${excluded ? ' <span class="excluded">EXCLUDED</span>' : ''}${
        l.note ? `<span class="note">${escapeHtml(l.note)}</span>` : ''
      }`;
      const part = [l.partNumber ? `Part ${l.partNumber}` : '', l.partSource ? PART_SOURCE_LABELS[l.partSource] : ''].filter(Boolean).join(' · ');
      out.push(
        `<tr><td>${escapeHtml(l.operation)}</td><td>${item}</td><td class="small-note">${escapeHtml(part)}</td><td class="num">${escapeHtml(lineQuantity(l))}</td><td class="num">${escapeHtml(
          lineRate(l, est)
        )}</td><td class="num">${escapeHtml(formatGBP(estimateLineAmount(l, est)))}</td></tr>`
      );
    }
  }
  return out.join('\n');
}

function paintMaterialsLabel(est: EstimateView): string {
  switch (est.paintMaterialsMethod) {
    case 'per_hour':
      return est.paintMaterialsPerHourPence !== undefined ? `${formatRate(est.paintMaterialsPerHourPence, 'paint hour')}` : 'per paint hour';
    case 'paint_system':
      return 'paint-system figure';
    default:
      return 'fixed sum';
  }
}

/** The itemised estimate: accident lines grouped by kind, pre-existing lines in their own EXCLUDED table, then the ledger totals. */
export function estimateSection(est: EstimateView): string {
  const headings = ['Operation', 'Item', 'Part / source', 'Quantity', 'Rate', 'Amount'];
  const head = `<thead><tr>${headings.map((h, i) => `<th${i >= 3 ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const claimed = est.lines.filter((l) => !l.preExisting);
  const preExisting = est.lines.filter((l) => l.preExisting);
  const t = est.totals;

  const claimedTable = `<table class="data estimate"><caption>Accident damage — repair estimate${est.reference ? ` ${escapeHtml(est.reference)}` : ''}</caption>${head}<tbody>
${lineRows(claimed, est, false)}
</tbody></table>`;

  const excludedTable =
    preExisting.length > 0
      ? `<div class="avoid-break"><table class="data estimate excluded-lines"><caption>Pre-existing damage — EXCLUDED from the claim (${escapeHtml(formatGBP(t.preExistingExcludedPence))})</caption>${head}<tbody>
${lineRows(preExisting, est, true)}
</tbody></table>
<p class="small">These items were present before the accident. They are listed so that the separation is transparent. They are not included in any figure below and are not claimed.</p></div>`
      : `<p class="small">No pre-existing damage was identified that required separation from the accident damage.</p>`;

  const totalsRows: FigureRow[] = [
    { label: 'Labour', note: `${formatHours(t.labourHours)} at ${formatRate(est.labourRatePence, 'hour')}`, valuePence: t.labourPence },
    { label: 'Parts', valuePence: t.partsPence },
    { label: 'Paint labour', note: `${formatHours(t.paintHours)} at ${formatRate(est.paintRatePence, 'hour')}`, valuePence: t.paintLabourPence },
    { label: 'Paint materials', note: paintMaterialsLabel(est), valuePence: t.paintMaterialsPence },
    { label: 'Other', note: 'ADAS calibration, diagnostics, specialist and sundry items', valuePence: t.otherPence },
    { label: 'Net repair cost', valuePence: t.netPence, emphasis: true },
    { label: `VAT at ${formatPercent(est.vatRate)}`, valuePence: t.vatPence },
    { label: 'Gross repair cost', valuePence: t.grossPence, emphasis: true }
  ];
  const reconciliation =
    est.importedTotalPence !== undefined
      ? `<p class="small">Imported estimate total ${escapeHtml(formatGBP(est.importedTotalPence))}; ${est.reconciled ? 'reconciled to the itemised lines above.' : 'NOT reconciled to the itemised lines above — the difference is noted in the opinion.'}</p>`
      : '';
  return `${est.basis ? `<p>${escapeHtml(est.basis)}</p>` : ''}
${claimedTable}
${excludedTable}
<div class="avoid-break">${figuresTable(totalsRows, { caption: 'Estimate totals' })}${reconciliation}</div>`;
}

// ---------------------------------------------------------------------------
// report.engineer
// ---------------------------------------------------------------------------

export interface ReportPhoto {
  /** Data URL or path resolvable by the renderer. */
  src: string;
  caption: string;
  /** SHA-256 of the original file (evidence store). */
  sha256: string;
  capturedAt?: DateLike;
  evidenceId?: string;
}

export interface PavSummary {
  pavPence: Pence;
  medianPence: Pence;
  iqrLowPence: Pence;
  iqrHighPence: Pence;
  comparablesUsed: number;
  comparablesExcluded?: number;
  tradeGuidePence?: Pence;
  tradeGuideSource?: string;
  /** Reference of the separate PAV report. */
  reportReference?: string;
  overrideReason?: string;
}

export interface EngineerReportData extends BaseDocumentData {
  report: {
    reference: string;
    issuedAt: DateLike;
    /** Adds the CPR 35 / PD 35 content: substance of instructions, duty to the court, declaration, statement of truth. */
    forCourt: boolean;
    feePence: Pence;
  };
  instructions: {
    instructedBy: string;
    instructedAt: DateLike;
    /** What the engineer was asked to do. */
    purpose: string;
    /** Specific questions put to the engineer, if any. */
    questions?: string[];
    /** Documents and material supplied with the instruction. */
    materialsSupplied?: string[];
  };
  engineer: {
    name: string;
    qualifications: string;
    company?: string;
    /** Relevant experience in one or two sentences. */
    experience?: string;
    /** Appropriately Qualified Person id for salvage categorisation, when held. */
    aqpId?: string;
    /** Disclosure of the engineer's relationship to the instructing party (conflicts are disclosed, never hidden). */
    independence?: string;
  };
  inspection: {
    basis: 'physical' | 'desktop';
    at?: DateLike;
    place?: string;
    /** Weather, lighting, whether the vehicle was on a ramp, wheels removed, etc. */
    conditions?: string;
    /** Desktop basis: what the assessment was made from. */
    materials?: string[];
  };
  vehicle: {
    registration: string;
    vin?: string;
    make: string;
    model: string;
    variant?: string;
    colour?: string;
    fuelType?: string;
    transmission?: string;
    /** ISO date of first registration, or YYYY-MM. */
    firstRegistered?: string;
    yearOfManufacture?: number;
    engineCapacityCc?: number;
    odometer: { miles: number; source: OdometerSource; date?: DateLike; note?: string };
    mot: { status: string; expiryDate?: DateLike; lastTest?: { date: DateLike; result: string; odometerMiles?: number } };
    previousWriteOffCategory?: SalvageCategory;
  };
  /** The claimant's account of the accident, as supplied to the engineer (not within the engineer's knowledge). */
  circumstances: string;
  preAccidentCondition: string;
  damage: {
    description: string;
    /** Areas of damage, e.g. "Nearside front", "Front". */
    areas?: string[];
    consistentWithCircumstances: boolean;
    consistencyNote?: string;
  };
  photos: ReportPhoto[];
  repair: {
    method?: string;
    estimate?: EstimateView;
    roadworthy: boolean;
    roadworthyReason: string;
    durationWorkingDays?: number;
    durationNote?: string;
  };
  totalLoss?: TotalLossAssessment;
  pav?: PavSummary;
  salvage?: {
    category: SalvageCategory;
    valuePence: Pence;
    source: TotalLossAssessment['salvageSource'];
    basis?: string;
  };
  adasNotes?: string;
  evNotes?: string;
  diagnosticFaultCodes?: string[];
  /** The engineer's opinion and summary of conclusions. */
  opinion: string;
  /** Required when `report.forCourt` is true. */
  court?: {
    /** PD 35 para 3.2(3): the substance of all material instructions, written and oral. */
    substanceOfInstructions: string;
    track?: Track;
    /** PD 27A para 7.3(2) cap, from the knowledge base with its verification. */
    smallClaimsExpertFeeCapPence?: Pence;
    /** PD 35 para 3.2(2): literature or other material relied on. */
    literature?: string[];
    /** PD 35 para 3.2(6): where there is a range of opinion, a summary of it and the reasons for the engineer's own. */
    rangeOfOpinion?: string;
  };
}

const ENGINEER_REPORT_REQUIRED = [
  'settings.registeredOffice',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate',
  'report.reference',
  'report.issuedAt',
  'report.forCourt',
  'report.feePence',
  'instructions.instructedBy',
  'instructions.instructedAt',
  'instructions.purpose',
  'engineer.name',
  'engineer.qualifications',
  'inspection.basis',
  'vehicle.registration',
  'vehicle.make',
  'vehicle.model',
  'vehicle.odometer.miles',
  'vehicle.odometer.source',
  'vehicle.mot.status',
  'circumstances',
  'preAccidentCondition',
  'damage.description',
  'damage.consistentWithCircumstances',
  'photos',
  'repair.roadworthy',
  'repair.roadworthyReason',
  'opinion'
] as const;

/** Placeholder photograph for samples: an SVG data URL with its real SHA-256, so the grid and hash line render. */
export function placeholderPhoto(label: string, caption: string, capturedAt?: DateLike): ReportPhoto {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#D9DCE3"/><rect x="40" y="40" width="560" height="340" fill="none" stroke="#8A8F9B" stroke-width="2" stroke-dasharray="8 6"/><text x="320" y="222" font-family="Arial, Helvetica, sans-serif" font-size="30" text-anchor="middle" fill="#0D1C50">${label}</text></svg>`;
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    caption,
    sha256: sha256Hex(svg),
    capturedAt
  };
}

function photoGrid(photos: ReadonlyArray<ReportPhoto>): string {
  if (photos.length === 0) return '<p class="muted">No photographs accompany this report.</p>';
  return `<div class="photo-grid">${photos
    .map(
      (p, i) =>
        `<figure class="photo"><img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.caption)}"><figcaption><strong>Photo ${i + 1}.</strong> ${escapeHtml(p.caption)}${
          p.capturedAt ? ` <span class="muted">(${escapeHtml(formatDateTime(p.capturedAt))})</span>` : ''
        }<br><span class="hash">SHA-256 ${escapeHtml(p.sha256)}</span></figcaption></figure>`
    )
    .join('')}</div>`;
}

function vehicleTable(v: EngineerReportData['vehicle']): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Registration', value: formatRegistration(v.registration) },
    { label: 'VIN', value: v.vin ?? 'Not recorded' },
    { label: 'Make, model and variant', value: [v.make, v.model, v.variant].filter(Boolean).join(' ') }
  ];
  if (v.colour) rows.push({ label: 'Colour', value: v.colour });
  if (v.fuelType || v.transmission) rows.push({ label: 'Fuel and transmission', value: [v.fuelType, v.transmission].filter(Boolean).join(', ') });
  if (v.engineCapacityCc !== undefined) rows.push({ label: 'Engine', value: `${formatNumber(v.engineCapacityCc)} cc` });
  if (v.firstRegistered) {
    rows.push({ label: 'First registered', value: /^\d{4}-\d{2}-\d{2}$/.test(v.firstRegistered) ? formatDateLong(v.firstRegistered) : v.firstRegistered });
  }
  if (v.yearOfManufacture !== undefined) rows.push({ label: 'Year of manufacture', value: String(v.yearOfManufacture) });
  rows.push({
    label: 'Odometer',
    value: `${formatMiles(v.odometer.miles)} — ${ODOMETER_SOURCE_LABELS[v.odometer.source]}${v.odometer.date ? `, ${formatDateLong(v.odometer.date)}` : ''}${
      v.odometer.note ? `. ${v.odometer.note}` : ''
    }`
  });
  rows.push({ label: 'MOT status', value: `${v.mot.status}${v.mot.expiryDate ? `, expires ${formatDateLong(v.mot.expiryDate)}` : ''}` });
  if (v.mot.lastTest) {
    rows.push({
      label: 'Last MOT test',
      value: `${formatDateLong(v.mot.lastTest.date)} — ${v.mot.lastTest.result}${v.mot.lastTest.odometerMiles !== undefined ? ` at ${formatMiles(v.mot.lastTest.odometerMiles)}` : ''}`
    });
  }
  rows.push({ label: 'Previous write-off category', value: v.previousWriteOffCategory ? SALVAGE_CATEGORY_LABELS[v.previousWriteOffCategory] : 'None recorded' });
  return keyValueTable(rows);
}

/** Repair route vs total-loss route, from the TotalLossAssessment the engine produced. */
export function totalLossSection(tl: TotalLossAssessment): string {
  const repairRows: FigureRow[] = [
    { label: 'Repair cost (net)', valuePence: tl.repairNetPence },
    {
      label: 'Projected hire during repair',
      note: `${plural(tl.projectedHireDays, 'day')} at ${formatRate(tl.hireDailyRatePence, 'day')}; projected repair duration ${plural(tl.projectedRepairWorkingDays, 'working day')}`,
      valuePence: tl.projectedHirePence
    },
    { label: 'Projected storage', valuePence: tl.projectedStoragePence },
    { label: 'Repair route total', valuePence: tl.repairRouteCostPence, emphasis: true }
  ];
  const tlRows: FigureRow[] = [
    { label: 'Pre-accident value', valuePence: tl.pavPence },
    {
      label: 'Less salvage',
      note: `${SALVAGE_SOURCE_LABELS[tl.salvageSource]}${tl.salvageCategory ? `; ${SALVAGE_CATEGORY_LABELS[tl.salvageCategory]}` : ''}`,
      valuePence: -tl.salvagePence
    },
    { label: 'Total-loss route total', valuePence: tl.totalLossRouteCostPence, emphasis: true }
  ];
  let verdict: string;
  switch (tl.decision) {
    case 'repair':
      verdict = `Repair. The repair route costs less than the total-loss route; the margin between the routes is ${formatGBP(tl.marginPence)}.`;
      break;
    case 'total_loss':
      verdict = `Total loss. The total-loss route costs less than the repair route; the margin between the routes is ${formatGBP(tl.marginPence)}.`;
      break;
    default:
      verdict = `Borderline. The margin between the routes is ${formatGBP(tl.marginPence)}; the decision turns on the engineering factors noted below.`;
  }
  return `<p>The comparison is commercial: the cost of repairing the vehicle, with the hire and storage that the repair period would cause, against its pre-accident value less what the salvage would realise. Salvage is taken from an actual bid or offer where one exists, never from a fixed percentage. Whether the vehicle can be repaired is an engineering question answered separately above.</p>
<div class="avoid-break">${figuresTable(repairRows, { caption: 'Repair route' })}</div>
<div class="avoid-break">${figuresTable(tlRows, { caption: 'Total-loss route' })}
<p class="verdict">Assessment: ${escapeHtml(verdict)}</p></div>
${bulletList(tl.notes)}`;
}

function pavSummarySection(p: PavSummary): string {
  const rows: FigureRow[] = [
    { label: 'Pre-accident value', valuePence: p.pavPence, emphasis: true },
    { label: 'Median of normalised comparables', valuePence: p.medianPence },
    { label: 'Interquartile range', text: `${formatGBP(p.iqrLowPence)} to ${formatGBP(p.iqrHighPence)}` },
    { label: 'Comparables used', text: `${formatNumber(p.comparablesUsed)}${p.comparablesExcluded !== undefined ? ` (${formatNumber(p.comparablesExcluded)} excluded)` : ''}` }
  ];
  if (p.tradeGuidePence !== undefined) rows.push({ label: 'Trade guide figure (shown alongside)', note: p.tradeGuideSource, valuePence: p.tradeGuidePence });
  return `<div class="avoid-break">${figuresTable(rows, { caption: 'Pre-accident value summary' })}</div>
<p>${
    p.overrideReason
      ? `The value asserted differs from the median for this reason: ${escapeHtml(p.overrideReason)}`
      : 'The value asserted is the median of the normalised comparables.'
  }${p.reportReference ? ` The comparables, normalisation and audit trail are in PAV report ${escapeHtml(p.reportReference)}.` : ''}</p>`;
}

/** The expert's declaration (Guidance for the Instruction of Experts in Civil Claims, Civil Justice Council), in the engineer's own voice. */
function expertDeclaration(): string {
  const items = [
    'I understand that my duty is to help the court to achieve the overriding objective by giving independent assistance by way of objective, unbiased opinion on matters within my expertise, both in preparing reports and in giving oral evidence. I understand that this duty overrides any obligation to the party by whom I am engaged or the person who has paid or is liable to pay me. I confirm that I have complied with and will continue to comply with that duty.',
    'I confirm that I have not entered into any arrangement where the amount or payment of my fees is in any way dependent on the outcome of the case.',
    'I know of no conflict of interest of any kind, other than any which I have disclosed in my report.',
    'I do not consider that any interest which I have disclosed affects my suitability as an expert witness on any issue on which I have given evidence.',
    'I will advise the party by whom I am instructed if, between the date of my report and the trial, there is any change in circumstances which affects my answers to points 3 and 4 above.',
    'I have shown the sources of all information I have used.',
    'I have exercised reasonable care and skill in order to be accurate and complete in preparing this report.',
    'I have endeavoured to include in my report those matters, of which I have knowledge or of which I have been made aware, that might adversely affect the validity of my opinion. I have clearly stated any qualifications to my opinion.',
    'I have not, without forming an independent view, included or excluded anything which has been suggested to me by others, including those instructing me.',
    'I will notify those instructing me immediately and confirm in writing if, for any reason, my existing report requires any correction or qualification.',
    'I understand that my report will form the evidence to be given under oath or affirmation; that the court may at any stage direct a discussion to take place between experts; that the court may direct that, following a discussion between the experts, the parties should prepare a statement of the issues on which the experts agree and disagree with a summary of the reasons; that I may be required to attend court to be cross-examined on my report; and that I am likely to be the subject of public adverse criticism by the judge if the court concludes that I have not taken reasonable care in trying to meet the standards set out above.',
    'I have read Part 35 of the Civil Procedure Rules and Practice Direction 35, including the Guidance for the Instruction of Experts in Civil Claims, and I have complied with their requirements.'
  ];
  return `<div class="declaration">${numberedList(items)}</div>`;
}

function courtSections(d: EngineerReportData): string {
  const c = d.court;
  const feeCap = c?.smallClaimsExpertFeeCapPence;
  const smallClaims = `<h3>Small claims track</h3>
<p>If this claim is allocated to the small claims track, CPR 27.2 disapplies most of Part 35. No expert evidence may be given at a hearing without the court’s permission (CPR 27.5). The fee recoverable for an expert is limited${
    feeCap !== undefined ? ` to ${escapeHtml(formatGBP(feeCap))}` : ''
  } by PD 27A paragraph 7.3(2). The fee for this report is ${escapeHtml(formatGBP(d.report.feePence))}.${
    c?.track ? ` The claim is currently understood to be on the ${escapeHtml(c.track.replace('_', ' '))} track.` : ''
  }</p>`;
  return `<h2>Part 35 content</h2>
<h3>Substance of instructions (PD 35 paragraph 3.2(3))</h3>
${nl2p(c?.substanceOfInstructions ?? d.instructions.purpose)}
${c?.literature && c.literature.length > 0 ? `<h3>Literature and material relied on (PD 35 paragraph 3.2(2))</h3>${bulletList(c.literature)}` : ''}
${c?.rangeOfOpinion ? `<h3>Range of opinion (PD 35 paragraph 3.2(6))</h3>${nl2p(c.rangeOfOpinion)}` : ''}
<h3>Facts and opinion</h3>
<p>Facts stated from my own inspection and from the records I have identified are within my own knowledge. The circumstances of the accident are as described to me by the claimant and are not within my knowledge; I have assessed the damage against that account. The inspection and the estimate were carried out by me personally.</p>
<h3>Expert’s duty to the court (CPR 35.3)</h3>
<p>I understand that my duty is to help the court on matters within my expertise and that this duty overrides any obligation to the person from whom I have received instructions or by whom I am paid. I have complied with that duty and will continue to do so.</p>
<h3>Expert’s declaration</h3>
${expertDeclaration()}
${smallClaims}
${statementOfTruth({ kind: 'expert', signatoryName: d.engineer.name, date: d.report.issuedAt })}`;
}

export const engineerReportTemplate: Template<EngineerReportData> = {
  id: 'report.engineer',
  version: '1.0.0',
  kind: 'report',
  title: 'Engineer’s report',
  recipientRole: 'other',
  description: 'The engineer’s report (BLUEPRINT §4.6): instructions, inspection, vehicle identification, damage with photographs, estimate with pre-existing items excluded, roadworthiness, total-loss comparison, PAV, salvage, ADAS/EV, opinion — and CPR 35 content when for court.',
  requiredData: [...ENGINEER_REPORT_REQUIRED],
  titleFor: (d) => `Engineer’s report ${d.report.reference}`,
  sample: () => sampleEngineerReport(),
  render: (d) => {
    const v = d.vehicle;
    const r = d.repair;
    const vehicleName = [v.make, v.model, v.variant].filter(Boolean).join(' ');

    const instructionRows: Array<{ label: string; value: string }> = [
      { label: 'Instructed by', value: d.instructions.instructedBy },
      { label: 'Date of instruction', value: formatDateLong(d.instructions.instructedAt) },
      { label: 'Purpose', value: d.instructions.purpose },
      { label: 'Report prepared for court', value: d.report.forCourt ? 'Yes — Part 35 content included' : 'No — for the claimant and the handling of the claim' },
      { label: 'Fee', value: formatGBP(d.report.feePence) }
    ];

    const engineerRows: Array<{ label: string; value: string }> = [
      { label: 'Name', value: `${d.engineer.name}${d.engineer.company ? `, ${d.engineer.company}` : ''}` },
      { label: 'Qualifications', value: d.engineer.qualifications }
    ];
    if (d.engineer.experience) engineerRows.push({ label: 'Experience', value: d.engineer.experience });
    if (d.engineer.aqpId) engineerRows.push({ label: 'AQP identifier (salvage categorisation)', value: d.engineer.aqpId });
    engineerRows.push({
      label: 'Independence',
      value:
        d.engineer.independence ??
        `The engineer is engaged by ${brand.company.registeredName}, which also supplies accident management services to the claimant. That relationship is disclosed. The opinions in this report are the engineer’s own.`
    });

    const inspectionRows: Array<{ label: string; value: string }> = [
      { label: 'Basis', value: d.inspection.basis === 'physical' ? 'Physical inspection of the vehicle' : 'Desktop assessment from photographs and records' }
    ];
    if (d.inspection.at) inspectionRows.push({ label: 'Date and time', value: formatDateTime(d.inspection.at) });
    if (d.inspection.place) inspectionRows.push({ label: 'Place', value: d.inspection.place });
    if (d.inspection.conditions) inspectionRows.push({ label: 'Conditions', value: d.inspection.conditions });
    if (d.inspection.materials && d.inspection.materials.length > 0) inspectionRows.push({ label: 'Material assessed', value: d.inspection.materials.join('; ') });

    const roadworthy = `<p class="verdict">${r.roadworthy ? 'Roadworthy.' : 'Unroadworthy.'}</p>${nl2p(r.roadworthyReason)}`;
    const duration =
      r.durationWorkingDays !== undefined
        ? `<p>Estimated repair duration: <strong>${escapeHtml(plural(r.durationWorkingDays, 'working day'))}</strong> from authorisation and parts availability.${
            r.durationNote ? ` ${escapeHtml(r.durationNote)}` : ''
          }</p>`
        : `<p>No repair duration is given${r.durationNote ? `: ${escapeHtml(r.durationNote)}` : '.'}</p>`;

    const salvage = d.salvage
      ? `${keyValueTable(
          [
            { label: 'Category', value: SALVAGE_CATEGORY_LABELS[d.salvage.category] },
            { label: 'Salvage value', value: `${formatGBP(d.salvage.valuePence)} (${SALVAGE_SOURCE_LABELS[d.salvage.source]})` },
            ...(d.salvage.basis ? [{ label: 'Basis', value: d.salvage.basis }] : [])
          ],
          'Salvage'
        )}<p class="small">Categorisation follows the ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage (28 May 2025). Categories reflect structural or non-structural damage, not repair cost.</p>`
      : `<p>No salvage category is assigned: the vehicle is to be repaired.${
          d.totalLoss ? ` The salvage figure used in the total-loss comparison above (${escapeHtml(formatGBP(d.totalLoss.salvagePence))}, ${escapeHtml(SALVAGE_SOURCE_LABELS[d.totalLoss.salvageSource])}) is for that comparison only.` : ''
        }</p>`;

    const techRows: string[] = [];
    techRows.push(`<h3>ADAS</h3>${nl2p(d.adasNotes ?? 'No driver-assistance systems are affected by the damage or the repair method.')}`);
    techRows.push(`<h3>EV and hybrid systems</h3>${nl2p(d.evNotes ?? 'Not applicable: the vehicle has no high-voltage system.')}`);
    techRows.push(
      `<h3>Diagnostic fault codes</h3>${
        d.diagnosticFaultCodes && d.diagnosticFaultCodes.length > 0 ? bulletList(d.diagnosticFaultCodes) : '<p>No diagnostic scan was carried out, or no fault codes were stored.</p>'
      }`
    );

    const body = `
${subjectBlock(d.claim, { claimantLabel: 'Claimant' })}
<h2>1. Instructions</h2>
${keyValueTable(instructionRows)}
${d.instructions.questions && d.instructions.questions.length > 0 ? `<p>Questions put to the engineer:</p>${numberedList(d.instructions.questions)}` : ''}
${d.instructions.materialsSupplied && d.instructions.materialsSupplied.length > 0 ? `<p>Material supplied with the instruction:</p>${bulletList(d.instructions.materialsSupplied)}` : ''}
<h2>2. The engineer</h2>
${keyValueTable(engineerRows)}
<h2>3. Inspection</h2>
${keyValueTable(inspectionRows)}
<h2>4. Vehicle identification</h2>
${vehicleTable(v)}
<h2>5. Pre-accident condition</h2>
${nl2p(d.preAccidentCondition)}
<h2>6. Circumstances as described to the engineer</h2>
${nl2p(d.circumstances)}
<p class="small">This account was supplied by the claimant. It is not within the engineer’s knowledge; the damage is assessed against it in section 8.</p>
<h2>7. Damage</h2>
${d.damage.areas && d.damage.areas.length > 0 ? `<p>Areas of damage: ${escapeHtml(d.damage.areas.join('; '))}.</p>` : ''}
${nl2p(d.damage.description)}
<h3>Photographs</h3>
<p class="small">Each photograph is held in the evidence store with its original EXIF data; the SHA-256 shown is the hash of the original file.</p>
${photoGrid(d.photos)}
<h2>8. Consistency with the circumstances</h2>
<p class="verdict">${d.damage.consistentWithCircumstances ? 'The damage is consistent with the circumstances described.' : 'The damage is not wholly consistent with the circumstances described.'}</p>
${d.damage.consistencyNote ? nl2p(d.damage.consistencyNote) : ''}
<h2>9. Repair method and estimate</h2>
${r.method ? nl2p(r.method) : ''}
${r.estimate ? estimateSection(r.estimate) : '<p>No repair estimate was prepared.</p>'}
<h2>10. Roadworthiness</h2>
${roadworthy}
<h2>11. Repair duration</h2>
${duration}
<h2>12. Total-loss assessment</h2>
${d.totalLoss ? totalLossSection(d.totalLoss) : '<p>No total-loss comparison was required: the repair cost is well within the pre-accident value.</p>'}
<h2>13. Pre-accident value</h2>
${d.pav ? pavSummarySection(d.pav) : '<p>No pre-accident valuation was required for this report.</p>'}
<h2>14. Salvage</h2>
${salvage}
<h2>15. ADAS, EV and diagnostics</h2>
${techRows.join('\n')}
<h2>16. Opinion</h2>
${nl2p(d.opinion)}
${d.report.forCourt ? courtSections(d) : `<p class="small">This report is prepared for the claimant and for ${escapeHtml(brand.company.registeredName)} in the handling of the claim. It is not prepared for use in court proceedings. If proceedings are issued, a version containing the CPR Part 35 and PD 35 content can be issued on request.</p>`}
${
  d.report.forCourt
    ? ''
    : signatureBlock({ name: d.engineer.name, role: d.engineer.qualifications }, d.report.issuedAt, { onBehalfOf: d.engineer.company ?? '' })
}`;

    return baseLayout({
      title: 'Engineer’s report',
      subtitle: `${vehicleName}, ${formatRegistration(v.registration)} — accident on ${formatDateLong(d.claim.accidentDate)}`,
      kind: 'report',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      meta: [
        { label: 'Report', value: d.report.reference },
        { label: 'Issued', value: formatDateLong(d.report.issuedAt) },
        { label: 'Engineer', value: d.engineer.name }
      ],
      bodyHtml: body,
      extraCss: REPORT_CSS
    });
  }
};

/** A complete, internally consistent fixture: a repairable, unroadworthy Golf with pre-existing rear-bumper damage separated out. */
export function sampleEngineerReport(overrides: Partial<EngineerReportData> = {}): EngineerReportData {
  const estimate: EstimateView = {
    reference: 'EST-2026-0042',
    basis:
      'Manual estimate prepared by the engineer. Labour times are from CCGUK’s own labour library (medians of approved estimates for this model, panel and operation). Part prices are OEM dealer list prices on the date of the estimate. Paint is charged as hours at the paint rate plus materials per paint hour.',
    labourRatePence: 4800,
    paintRatePence: 4800,
    paintMaterialsMethod: 'per_hour',
    paintMaterialsPerHourPence: 3000,
    vatRate: 0.2,
    lines: [
      { id: 'l1', kind: 'labour', operation: 'Replace', panel: 'Front bumper', description: 'Remove and refit front bumper assembly', quantity: 1, hours: 1.5, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'l2', kind: 'labour', operation: 'Replace', panel: 'Bonnet', description: 'Replace bonnet, align and adjust', quantity: 1, hours: 1.2, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'l3', kind: 'labour', operation: 'Repair', panel: 'NSF wing', description: 'Repair nearside front wing', quantity: 1, hours: 2, ratePence: 4800, source: 'manual', confirmedByEngineer: true },
      { id: 'l4', kind: 'labour', operation: 'Strip/Refit', panel: 'NSF headlamp', description: 'Strip and refit nearside front headlamp', quantity: 1, hours: 0.5, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'p1', kind: 'part', operation: 'Replace', panel: 'Front bumper', description: 'Front bumper cover', partNumber: '5G0 807 221', partSource: 'oem', quantity: 1, unitPence: 18500, source: 'manual', confirmedByEngineer: true },
      { id: 'p2', kind: 'part', operation: 'Replace', panel: 'Bonnet', description: 'Bonnet', partNumber: '5G0 823 031', partSource: 'oem', quantity: 1, unitPence: 32000, source: 'manual', confirmedByEngineer: true },
      { id: 'p3', kind: 'part', operation: 'Replace', panel: 'NSF headlamp', description: 'Nearside front headlamp (LED)', partNumber: '5G1 941 005', partSource: 'oem', quantity: 1, unitPence: 41500, source: 'manual', confirmedByEngineer: true },
      { id: 'p4', kind: 'part', operation: 'Replace', description: 'Bumper fixings kit', partSource: 'aftermarket', quantity: 1, unitPence: 2450, source: 'manual', confirmedByEngineer: true },
      { id: 'pa1', kind: 'paint', operation: 'Refinish', panel: 'Front bumper', description: 'Refinish front bumper cover', quantity: 1, hours: 2, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'pa2', kind: 'paint', operation: 'Refinish', panel: 'Bonnet', description: 'Refinish bonnet', quantity: 1, hours: 2.5, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'pa3', kind: 'paint', operation: 'Refinish', panel: 'NSF wing', description: 'Refinish nearside front wing', quantity: 1, hours: 1.8, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'pa4', kind: 'paint', operation: 'Blend', panel: 'NSF door', description: 'Blend nearside front door for colour match', quantity: 1, hours: 1, ratePence: 4800, source: 'library', confirmedByEngineer: true },
      { id: 'm1', kind: 'materials', operation: 'Materials', description: 'Paint materials, 7.3 paint hours', quantity: 1, materialsPence: 21900, source: 'manual', confirmedByEngineer: true },
      { id: 'a1', kind: 'adas', operation: 'Calibrate', panel: 'Front camera', description: 'Front camera recalibration after bonnet replacement', quantity: 1, unitPence: 15000, source: 'manual', confirmedByEngineer: true, note: 'Required by the manufacturer’s repair method after bonnet removal.' },
      { id: 'd1', kind: 'diagnostic', operation: 'Scan', description: 'Pre- and post-repair diagnostic scan', quantity: 1, unitPence: 6000, source: 'manual', confirmedByEngineer: true },
      { id: 'x1', kind: 'labour', operation: 'Repair', panel: 'Rear bumper', description: 'Scuff and scratches to rear bumper, offside corner', quantity: 1, hours: 1, ratePence: 4800, source: 'manual', confirmedByEngineer: true, preExisting: true, note: 'Weathered damage with road grime in the scratches; unrelated to a frontal impact.' },
      { id: 'x2', kind: 'paint', operation: 'Refinish', panel: 'Rear bumper', description: 'Refinish rear bumper', quantity: 1, hours: 1.5, ratePence: 4800, source: 'manual', confirmedByEngineer: true, preExisting: true }
    ],
    totals: {
      labourPence: 24960,
      partsPence: 94450,
      paintLabourPence: 35040,
      paintMaterialsPence: 21900,
      otherPence: 21000,
      preExistingExcludedPence: 12000,
      netPence: 197350,
      vatPence: 39470,
      grossPence: 236820,
      labourHours: 5.2,
      paintHours: 7.3
    }
  };
  const totalLoss: TotalLossAssessment = {
    repairNetPence: 197350,
    projectedRepairWorkingDays: 8,
    projectedHireDays: 12,
    hireDailyRatePence: 4980,
    projectedHirePence: 59760,
    projectedStoragePence: 36000,
    pavPence: 1625000,
    salvagePence: 215000,
    salvageSource: 'bid',
    repairRouteCostPence: 293110,
    totalLossRouteCostPence: 1410000,
    decision: 'repair',
    marginPence: 1116890,
    notes: ['No structural damage was found; the front chassis legs, suspension and steering are undamaged.', 'Parts are available from the dealer within three working days.']
  };
  return {
    ...sampleBaseData({ date: '2026-08-14', recipient: undefined }),
    report: { reference: 'ER-2026-0042', issuedAt: '2026-08-14', forCourt: false, feePence: 28500 },
    instructions: {
      instructedBy: 'Courtesy Cars Group UK Ltd on behalf of the claimant, Ms Jane Example',
      instructedAt: '2026-08-10',
      purpose:
        'To inspect the claimant’s vehicle, record the accident damage, separate any pre-existing damage, prepare a repair method and estimate, state whether the vehicle is roadworthy, assess whether it is economic to repair, and report.',
      materialsSupplied: ['Claimant’s account of the accident (FNOL record, 9 August 2026)', 'Recovery operator’s condition photographs (9 August 2026)', 'DVLA and DVSA vehicle and MOT records']
    },
    engineer: {
      name: 'Mr Sam Example',
      qualifications: 'IMI Accredited Vehicle Damage Assessor; Member, Institute of Automotive Engineer Assessors',
      experience: 'Fourteen years assessing accident damage to private cars and light commercial vehicles for repairers, fleets and claimants.'
    },
    inspection: {
      basis: 'physical',
      at: '2026-08-12T10:30:00+01:00',
      place: 'Example Yard, Unit 1, Example Industrial Estate, Example Town',
      conditions: 'Indoors under workshop lighting; vehicle on a two-post lift; nearside front wheel removed for inspection of the suspension and inner wing.'
    },
    vehicle: {
      registration: 'AB12CDE',
      vin: 'WVWZZZCDZMW000000',
      make: 'Volkswagen',
      model: 'Golf',
      variant: '1.5 TSI Life',
      colour: 'Atlantic Blue',
      fuelType: 'Petrol',
      transmission: 'Manual',
      firstRegistered: '2021-03-18',
      yearOfManufacture: 2021,
      engineCapacityCc: 1498,
      odometer: { miles: 41660, source: 'engineer', date: '2026-08-12', note: 'Consistent with the last MOT reading and the vehicle’s annual mileage.' },
      mot: { status: 'Valid', expiryDate: '2027-03-11', lastTest: { date: '2026-03-12', result: 'Pass', odometerMiles: 38410 } }
    },
    circumstances:
      'The claimant states that on 9 August 2026 at about 14:35 she was stationary in the nearside lane at the junction of High Street and Station Road when the third-party vehicle, changing lanes from her offside, struck the front nearside corner of her car.',
    preAccidentCondition:
      'Good for its age and mileage. Full dealer service history to 38,410 miles. Original paint on all panels except the rear bumper, which carried pre-existing scuffing at the offside corner (see the excluded items). Tyres 4–6 mm, matching brand. Interior clean and undamaged.',
    damage: {
      areas: ['Front', 'Nearside front'],
      description:
        'Impact to the front nearside corner at low speed. The front bumper cover is split at the nearside and detached from its upper fixings. The bonnet leading edge is creased across the nearside third and the bonnet latch area is distorted. The nearside front wing is dented and creased behind the headlamp. The nearside headlamp lens is cracked and the lamp body mounting lugs are broken. The nearside front wheel is displaced on its hub; on removal the suspension, hub, lower arm and inner wing were found undamaged. No deformation to the front chassis legs or the bonnet slam panel.',
      consistentWithCircumstances: true,
      consistencyNote:
        'The damage is concentrated on the front nearside corner at bumper and bonnet height, with the direction of deformation rearward and towards the offside. That is consistent with a side-swipe from a vehicle moving from the offside into the claimant’s lane as described. There is no damage suggesting a rear or offside impact.'
    },
    photos: [
      placeholderPhoto('Front nearside, three-quarter', 'Front nearside three-quarter view showing the detached bumper cover and bonnet crease.', '2026-08-12T10:34:00+01:00'),
      placeholderPhoto('Nearside headlamp', 'Nearside headlamp: lens cracked, mounting lugs broken.', '2026-08-12T10:36:00+01:00'),
      placeholderPhoto('NSF wing', 'Nearside front wing: dent and crease behind the headlamp.', '2026-08-12T10:38:00+01:00'),
      placeholderPhoto('Odometer', 'Odometer at inspection: 41,660 miles.', '2026-08-12T10:40:00+01:00'),
      placeholderPhoto('VIN plate', 'VIN plate, lower windscreen, nearside.', '2026-08-12T10:41:00+01:00'),
      placeholderPhoto('Rear bumper (excluded)', 'Rear bumper offside corner: pre-existing weathered scuffing, excluded from the estimate.', '2026-08-12T10:44:00+01:00')
    ],
    repair: {
      method:
        'Replace the front bumper cover, bonnet and nearside headlamp with OEM parts. Repair and refinish the nearside front wing. Blend the nearside front door for colour match. Recalibrate the front camera after bonnet replacement, as the manufacturer’s repair method requires. Diagnostic scan before and after repair.',
      estimate,
      roadworthy: false,
      roadworthyReason:
        'The nearside headlamp is inoperative and the front bumper cover is detached and fouling the nearside front wheel. The vehicle cannot lawfully or safely be driven until repaired.',
      durationWorkingDays: 8,
      durationNote: 'Allows three working days for parts, four for strip, repair, paint and refit, and one for calibration and inspection.'
    },
    totalLoss,
    pav: {
      pavPence: 1625000,
      medianPence: 1625000,
      iqrLowPence: 1598000,
      iqrHighPence: 1667000,
      comparablesUsed: 6,
      comparablesExcluded: 2,
      tradeGuidePence: 1540000,
      tradeGuideSource: 'Trade guide retail figure, August 2026',
      reportReference: 'PAV-2026-0042'
    },
    adasNotes: 'The vehicle has a front camera (lane assist) mounted to the windscreen and a front radar behind the badge. The radar is undamaged. Bonnet replacement disturbs the camera’s reference position; the manufacturer’s method requires recalibration, which is included in the estimate.',
    diagnosticFaultCodes: ['B1001 — Front camera: calibration required (stored after the impact)', 'B2210 — Nearside headlamp: open circuit'],
    opinion:
      'The vehicle sustained low-speed frontal nearside damage consistent with the claimant’s account. It is unroadworthy until repaired. It is economic to repair: the net repair cost is a small fraction of the pre-accident value and the repair route is cheaper than the total-loss route by a wide margin. Pre-existing scuffing to the rear bumper has been identified, listed and excluded; nothing in the estimate relates to it. I estimate eight working days to complete the repair from authorisation.',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// report.pav
// ---------------------------------------------------------------------------

export interface PavAuditEntry {
  at: DateLike;
  action: string;
  by?: string;
  detail?: string;
}

export interface PavReportData extends BaseDocumentData {
  report: {
    reference: string;
    issuedAt: DateLike;
  };
  /** The subject vehicle (domain PavSubject without the persistence id), plus VIN and first registration for identification. */
  subject: Omit<PavSubject, 'vehicleId'> & { vehicleId?: string; vin?: string; firstRegistered?: ISODate };
  /** Required when `subject.odometerBasis` is 'projected_from_mot'. */
  odometerProjection?: {
    lastMotDate: ISODate;
    lastMotMiles: number;
    /** The vehicle's own annual mileage derived from its MOT history. */
    annualMiles: number;
    projectedToDate: ISODate;
    /** How the annual mileage was derived, e.g. "Average of the last three MOT intervals". */
    method?: string;
  };
  /** The search criteria the engine applied (BLUEPRINT §4.4 step 2). */
  criteria: {
    yearTolerance: number;
    mileageTolerancePct: number;
    radiusMiles: number;
    minimumComparables: number;
    /** When the radius had to be widened to reach the minimum. */
    radiusWidenedToMiles?: number;
  };
  comparables: Comparable[];
  /** Per-mile factor applied in normalisation (fractional pence allowed) and where it came from. */
  perMilePence: number;
  perMileSource: 'regression' | 'fallback_band';
  perMileNote?: string;
  medianPence: Pence;
  iqrLowPence: Pence;
  iqrHighPence: Pence;
  tradeGuidePence?: Pence;
  tradeGuideSource?: string;
  /** The figure asserted: the median unless the engineer overrides with a reason. */
  pavPence: Pence;
  overrideReason?: string;
  /** Generated reasoning paragraph, approved by the engineer. */
  reasoning: string;
  auditTrail: PavAuditEntry[];
  approver: Signatory & { qualifications?: string; approvedAt: DateLike };
}

const PAV_REQUIRED = [
  'settings.registeredOffice',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate',
  'report.reference',
  'report.issuedAt',
  'subject.registration',
  'subject.make',
  'subject.model',
  'subject.year',
  'subject.odometerAtLoss',
  'subject.odometerBasis',
  'subject.conditionGrade',
  'subject.conditionAdjustmentPct',
  'criteria.yearTolerance',
  'criteria.mileageTolerancePct',
  'criteria.radiusMiles',
  'criteria.minimumComparables',
  'comparables',
  'perMilePence',
  'perMileSource',
  'medianPence',
  'iqrLowPence',
  'iqrHighPence',
  'pavPence',
  'reasoning',
  'auditTrail',
  'approver.name',
  'approver.role',
  'approver.approvedAt'
] as const;

const SELLER_LABELS: Record<Comparable['seller'], string> = { dealer: 'Dealer', private: 'Private', unknown: 'Not stated' };
const CONDITION_LABELS: Record<PavSubject['conditionGrade'], string> = { excellent: 'Excellent', good: 'Good', average: 'Average', poor: 'Poor' };
const SERVICE_HISTORY_LABELS: Record<NonNullable<PavSubject['serviceHistory']>, string> = { full: 'Full', partial: 'Partial', none: 'None', unknown: 'Unknown' };

/** Comparables with capture evidence, normalised price and inclusion status; the URL prints under the source. */
export function comparablesTable(comparables: ReadonlyArray<Comparable>): string {
  if (comparables.length === 0) return '<p>No comparables were captured.</p>';
  const headings = ['#', 'Captured', 'Source and URL', 'Advert price', 'Mileage', 'Year', 'Trim', 'Seller', 'Distance', 'Normalised', 'Status'];
  const numeric = new Set([3, 4, 5, 8, 9]);
  const head = `<thead><tr>${headings.map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = comparables
    .map((c, i) => {
      const flags = [c.writeOffCategory ? `Cat ${c.writeOffCategory}` : '', c.exFleet ? 'ex-fleet' : '', c.priceOnApplication ? 'POA' : ''].filter(Boolean).join(', ');
      const cells: string[] = [
        escapeHtml(String(i + 1)),
        escapeHtml(formatDateTime(c.capturedAt)),
        `${escapeHtml(c.source)}${c.url ? `<br><span class="url">${escapeHtml(c.url)}</span>` : ''}`,
        escapeHtml(c.priceOnApplication ? 'POA' : formatGBP(c.pricePence)),
        escapeHtml(formatMiles(c.mileage)),
        escapeHtml(String(c.year)),
        `${escapeHtml(c.trim ?? '—')}${flags ? `<br><span class="small-note">${escapeHtml(flags)}</span>` : ''}`,
        escapeHtml(SELLER_LABELS[c.seller]),
        escapeHtml(c.distanceMiles !== undefined ? formatMiles(c.distanceMiles) : '—'),
        escapeHtml(c.normalisedPricePence !== undefined ? formatGBP(c.normalisedPricePence) : '—'),
        c.excluded ? `<span class="excluded">EXCLUDED</span> — ${escapeHtml(c.exclusionReason ?? 'reason not recorded')}` : 'Included'
      ];
      return `<tr${c.excluded ? ' class="excluded-row"' : ''}>${cells
        .map((cell, ci) => `<td${numeric.has(ci) ? ' class="num"' : ci === 6 ? ' class="trim"' : ''}>${cell}</td>`)
        .join('')}</tr>`;
    })
    .join('\n');
  return `<table class="data comparables">${head}<tbody>\n${body}\n</tbody></table>`;
}

export const pavReportTemplate: Template<PavReportData> = {
  id: 'report.pav',
  version: '1.0.0',
  kind: 'report',
  title: 'Pre-accident value report',
  recipientRole: 'other',
  description: 'PAV report (BLUEPRINT §4.4): subject vehicle and odometer basis, comparables with capture evidence, per-mile and condition normalisation, median and IQR, trade guide alongside, reasoning, audit trail and approver.',
  requiredData: [...PAV_REQUIRED],
  titleFor: (d) => `Pre-accident value report ${d.report.reference}`,
  sample: () => samplePavReport(),
  render: (d) => {
    const s = d.subject;
    const included = d.comparables.filter((c) => !c.excluded);
    const excluded = d.comparables.filter((c) => c.excluded);
    const vehicleName = [s.make, s.model, s.trim].filter(Boolean).join(' ');

    const subjectRows: Array<{ label: string; value: string }> = [
      { label: 'Registration', value: formatRegistration(s.registration) },
      { label: 'Vehicle', value: `${vehicleName}, ${s.year}` }
    ];
    if (s.vin) subjectRows.push({ label: 'VIN', value: s.vin });
    if (s.firstRegistered) subjectRows.push({ label: 'First registered', value: formatDateLong(s.firstRegistered) });
    if (s.fuelType || s.transmission) subjectRows.push({ label: 'Fuel and transmission', value: [s.fuelType, s.transmission].filter(Boolean).join(', ') });
    subjectRows.push({
      label: 'Odometer at loss',
      value:
        s.odometerBasis === 'reading'
          ? `${formatMiles(s.odometerAtLoss)} — actual reading`
          : `${formatMiles(s.odometerAtLoss)} — projected from the MOT history${
              d.odometerProjection
                ? `: ${formatMiles(d.odometerProjection.lastMotMiles)} at the MOT on ${formatDateLong(d.odometerProjection.lastMotDate)}, plus the vehicle’s own annual mileage of ${formatMiles(
                    d.odometerProjection.annualMiles
                  )} projected to ${formatDateLong(d.odometerProjection.projectedToDate)}${d.odometerProjection.method ? ` (${d.odometerProjection.method})` : ''}`
                : ''
            }`
    });
    subjectRows.push({ label: 'Condition', value: `${CONDITION_LABELS[s.conditionGrade]} — adjustment ${formatSignedPercent(s.conditionAdjustmentPct)} (engineer’s assessment)` });
    if (s.serviceHistory) subjectRows.push({ label: 'Service history', value: SERVICE_HISTORY_LABELS[s.serviceHistory] });
    subjectRows.push({ label: 'Ex-fleet', value: yesNo(Boolean(s.exFleet)) });
    subjectRows.push({ label: 'Previous write-off category', value: s.previousWriteOffCategory ? SALVAGE_CATEGORY_LABELS[s.previousWriteOffCategory] : 'None recorded' });
    if (s.claimantPostcode) subjectRows.push({ label: 'Search centred on', value: s.claimantPostcode });
    subjectRows.push({
      label: 'Claimant VAT status',
      value: s.vatRegisteredClaimant ? 'VAT registered' : 'Not VAT registered — retail prices, including VAT, are the measure of replacement cost'
    });

    const method = numberedList([
      `Measure: the cost of buying a replacement of similar make, model, age, mileage, condition and specification in the retail market.`,
      `Comparables: retail adverts for the same model and generation, year ±${formatNumber(d.criteria.yearTolerance)}, mileage within ±${formatPercent(
        d.criteria.mileageTolerancePct / 100
      )} of the subject’s odometer, same fuel and transmission, within ${formatMiles(d.criteria.radiusMiles)} of the claimant’s postcode${
        d.criteria.radiusWidenedToMiles !== undefined ? `, widened to ${formatMiles(d.criteria.radiusWidenedToMiles)} to reach the minimum` : ''
      }. Minimum ${formatNumber(d.criteria.minimumComparables)} adverts. Each advert was viewed and saved manually (PDF or screenshot with its URL, capture time and SHA-256); nothing was scraped.`,
      `Normalisation: each advert price is adjusted to the subject’s mileage at ${formatPencePerMile(d.perMilePence)} (${
        d.perMileSource === 'regression' ? 'derived from the comparables’ own price-to-mileage regression' : 'fallback band by price range — flagged as an assumption'
      }${d.perMileNote ? `; ${d.perMileNote}` : ''}), then for options, then by the condition adjustment of ${formatSignedPercent(s.conditionAdjustmentPct)}.`,
      'Exclusions: adverts more than 1.5 × IQR from the median after normalisation; Category S or N vehicles; ex-fleet vehicles unless the subject is ex-fleet; adverts priced on application. Each exclusion and its reason is shown in the table.',
      'Output: the median of the normalised, included comparables is the pre-accident value; the interquartile range is the confidence band; the trade guide figure is shown alongside for comparison.'
    ]);

    const resultRows: FigureRow[] = [
      { label: 'Pre-accident value', valuePence: d.pavPence, emphasis: true },
      { label: 'Median of normalised comparables', valuePence: d.medianPence },
      { label: 'Interquartile range', text: `${formatGBP(d.iqrLowPence)} to ${formatGBP(d.iqrHighPence)}` },
      { label: 'Comparables included', text: formatNumber(included.length) },
      { label: 'Comparables excluded', text: formatNumber(excluded.length) }
    ];
    if (d.tradeGuidePence !== undefined) resultRows.push({ label: 'Trade guide figure (alongside)', note: d.tradeGuideSource, valuePence: d.tradeGuidePence });

    const auditRows = d.auditTrail.map((a) => [formatDateTime(a.at), a.action, a.by ?? '', a.detail ?? '']);

    const body = `
${subjectBlock(d.claim, { claimantLabel: 'Claimant' })}
${callout(
  `<p>Pre-accident value of ${escapeHtml(vehicleName)}, ${escapeHtml(formatRegistration(s.registration))}, at ${escapeHtml(formatMiles(s.odometerAtLoss))} on ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )}: <strong>${escapeHtml(formatGBP(d.pavPence))}</strong>. Interquartile range ${escapeHtml(formatGBP(d.iqrLowPence))} to ${escapeHtml(formatGBP(d.iqrHighPence))} from ${escapeHtml(
    plural(included.length, 'included comparable')
  )}.${d.tradeGuidePence !== undefined ? ` Trade guide figure alongside: ${escapeHtml(formatGBP(d.tradeGuidePence))}.` : ''}</p>`,
  'Summary'
)}
<h2>1. Subject vehicle</h2>
${keyValueTable(subjectRows)}
<h2>2. Method</h2>
${method}
<h2>3. Comparables</h2>
${comparablesTable(d.comparables)}
<p class="small">Each advert is held in the evidence store as a PDF or screenshot with its URL, capture time and SHA-256. Normalised prices are at the subject’s mileage and condition. Excluded adverts are shown so the selection can be checked; they do not enter the median.</p>
<h2>4. Result</h2>
${figuresTable(resultRows)}
<p>${
      d.overrideReason
        ? `The value asserted differs from the median for this reason: ${escapeHtml(d.overrideReason)}`
        : 'The value asserted is the median of the normalised, included comparables; the engineer has not overridden it.'
    }</p>
<h2>5. Reasoning</h2>
${nl2p(d.reasoning)}
<h2>6. Audit trail</h2>
${dataTable(['Date and time', 'Action', 'By', 'Detail'], auditRows, { className: 'audit' })}
<h2>7. Approval</h2>
<p>Approved by ${escapeHtml(d.approver.name)}, ${escapeHtml(d.approver.role)}${d.approver.qualifications ? ` (${escapeHtml(d.approver.qualifications)})` : ''}, on ${escapeHtml(
      formatDateLong(d.approver.approvedAt)
    )}.</p>
${signatureBlock({ name: d.approver.name, role: d.approver.qualifications ? `${d.approver.role} — ${d.approver.qualifications}` : d.approver.role }, d.approver.approvedAt)}`;

    return baseLayout({
      title: 'Pre-accident value report',
      subtitle: `${vehicleName}, ${formatRegistration(s.registration)}`,
      kind: 'report',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      meta: [
        { label: 'Report', value: d.report.reference },
        { label: 'Issued', value: formatDateLong(d.report.issuedAt) }
      ],
      bodyHtml: body,
      extraCss: REPORT_CSS
    });
  }
};

function sampleComparable(overrides: Partial<Comparable> & Pick<Comparable, 'id' | 'pricePence' | 'mileage' | 'capturedAt'>): Comparable {
  return {
    source: 'Example Motors (retail advert)',
    url: `https://adverts.example.test/listing/${overrides.id}`,
    year: 2021,
    make: 'Volkswagen',
    model: 'Golf',
    trim: '1.5 TSI Life',
    fuelType: 'petrol',
    transmission: 'manual',
    seller: 'dealer',
    ...overrides
  };
}

/** A complete, internally consistent fixture: eight adverts, six included, median £16,250. */
export function samplePavReport(overrides: Partial<PavReportData> = {}): PavReportData {
  const comparables: Comparable[] = [
    sampleComparable({ id: 'c1', capturedAt: '2026-08-11T09:12:00+01:00', pricePence: 1549900, mileage: 46200, distanceMiles: 8, normalisedPricePence: 1585000 }),
    sampleComparable({ id: 'c2', capturedAt: '2026-08-11T09:20:00+01:00', pricePence: 1589500, mileage: 43100, distanceMiles: 14, normalisedPricePence: 1598000 }),
    sampleComparable({ id: 'c3', capturedAt: '2026-08-11T09:31:00+01:00', pricePence: 1624900, mileage: 39800, distanceMiles: 22, normalisedPricePence: 1612000 }),
    sampleComparable({ id: 'c4', capturedAt: '2026-08-11T09:45:00+01:00', pricePence: 1649000, mileage: 40300, distanceMiles: 31, normalisedPricePence: 1638000, seller: 'private' }),
    sampleComparable({ id: 'c5', capturedAt: '2026-08-11T10:02:00+01:00', pricePence: 1699000, mileage: 37100, distanceMiles: 40, normalisedPricePence: 1667000 }),
    sampleComparable({ id: 'c6', capturedAt: '2026-08-11T10:15:00+01:00', pricePence: 1739900, mileage: 36400, distanceMiles: 47, normalisedPricePence: 1702000, year: 2022 }),
    sampleComparable({
      id: 'c7',
      capturedAt: '2026-08-11T10:26:00+01:00',
      pricePence: 1399000,
      mileage: 44900,
      distanceMiles: 19,
      normalisedPricePence: 1422000,
      writeOffCategory: 'N',
      excluded: true,
      exclusionReason: 'Category N history; the subject has none'
    }),
    sampleComparable({
      id: 'c8',
      capturedAt: '2026-08-11T10:40:00+01:00',
      pricePence: 1995000,
      mileage: 31900,
      distanceMiles: 36,
      normalisedPricePence: 1925000,
      year: 2022,
      excluded: true,
      exclusionReason: 'More than 1.5 × IQR above the median after normalisation'
    })
  ];
  return {
    ...sampleBaseData({ date: '2026-08-14', recipient: undefined }),
    report: { reference: 'PAV-2026-0042', issuedAt: '2026-08-14' },
    subject: {
      registration: 'AB12CDE',
      vin: 'WVWZZZCDZMW000000',
      firstRegistered: '2021-03-18',
      make: 'Volkswagen',
      model: 'Golf',
      trim: '1.5 TSI Life',
      year: 2021,
      fuelType: 'petrol',
      transmission: 'manual',
      odometerAtLoss: 41660,
      odometerBasis: 'projected_from_mot',
      conditionGrade: 'good',
      conditionAdjustmentPct: 0,
      serviceHistory: 'full',
      exFleet: false,
      claimantPostcode: 'EX1 1AA',
      vatRegisteredClaimant: false
    },
    odometerProjection: { lastMotDate: '2026-03-12', lastMotMiles: 38410, annualMiles: 7900, projectedToDate: '2026-08-09', method: 'average of the last three MOT intervals' },
    criteria: { yearTolerance: 1, mileageTolerancePct: 25, radiusMiles: 50, minimumComparables: 6 },
    comparables,
    perMilePence: 7.2,
    perMileSource: 'regression',
    perMileNote: 'regression over the six included adverts',
    medianPence: 1625000,
    iqrLowPence: 1598000,
    iqrHighPence: 1667000,
    tradeGuidePence: 1540000,
    tradeGuideSource: 'Trade guide retail figure, August 2026, at 41,660 miles',
    pavPence: 1625000,
    reasoning:
      'Eight retail adverts for a 2020–2022 Volkswagen Golf 1.5 TSI Life, petrol, manual, were captured on 11 August 2026 within 50 miles of EX1 1AA. Two were excluded: one carried a Category N history and one sat more than 1.5 × IQR above the median after normalisation. The six included adverts were normalised to the subject’s projected mileage of 41,660 miles at 7.2p per mile, derived from their own price-to-mileage regression, with no options adjustment and a condition adjustment of 0% for a vehicle in good condition with a full service history. The median of the normalised prices is £16,250.00 with an interquartile range of £15,980.00 to £16,670.00. The trade guide retail figure of £15,400.00 sits below the retail evidence, as trade guides commonly do. The pre-accident value is assessed at £16,250.00.',
    auditTrail: [
      { at: '2026-08-11T09:05:00+01:00', action: 'Search opened', by: 'D. Kaleem', detail: 'Golf 1.5 TSI Life, 2020–2022, 31,245–52,075 miles, petrol manual, 50 miles of EX1 1AA' },
      { at: '2026-08-11T10:40:00+01:00', action: 'Eight adverts captured', by: 'D. Kaleem', detail: 'PDF of each advert saved with URL, capture time and SHA-256 (evidence c1–c8)' },
      { at: '2026-08-12T15:10:00+01:00', action: 'Odometer projected', by: 'system', detail: '38,410 miles at MOT 12 March 2026 + 7,900 miles a year to 9 August 2026 = 41,660 miles' },
      { at: '2026-08-12T15:12:00+01:00', action: 'Normalisation applied', by: 'system', detail: 'Per-mile factor 7.2p from regression over six included adverts; condition adjustment 0%' },
      { at: '2026-08-12T15:12:00+01:00', action: 'Exclusions applied', by: 'system', detail: 'c7 excluded (Category N); c8 excluded (outlier > 1.5 × IQR)' },
      { at: '2026-08-14T11:30:00+01:00', action: 'Reasoning reviewed and report approved', by: 'Mr Sam Example', detail: 'Median adopted without override' }
    ],
    approver: { name: 'Mr Sam Example', role: 'Motor engineer', qualifications: 'IMI Accredited Vehicle Damage Assessor', approvedAt: '2026-08-14' },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// schedule.loss
// ---------------------------------------------------------------------------

export const HEAD_OF_LOSS_LABELS: Record<HeadOfLoss, string> = {
  hire: 'Hire charges',
  recovery: 'Recovery',
  storage: 'Storage',
  engineer_fee: 'Engineer’s fee',
  pav: 'Pre-accident value (total loss)',
  repair: 'Repair costs',
  salvage: 'Salvage (credit)',
  excess: 'Policy excess',
  loss_of_use: 'Loss of use',
  diminution: 'Diminution in value',
  personal_effects: 'Personal effects',
  loss_of_earnings: 'Loss of earnings',
  travel: 'Travel',
  misc: 'Miscellaneous',
  interest: 'Interest',
  court_fee: 'Court fee',
  fixed_costs: 'Fixed costs'
};

export interface ScheduleOfLossHead {
  head: HeadOfLoss;
  /** Overrides the standard label for the head. */
  label?: string;
  description: string;
  /** Period, basis or quantity as a second line: "10 August 2026 to 2 September 2026 (24 days) at £49.80 per day". */
  detail?: string;
  quantity?: string;
  ratePence?: Pence;
  netPence: Pence;
  vatPence?: Pence;
  /** The document that proves the line: invoice number, agreement, report, receipt. */
  sourceDocument: string;
  status?: 'claimed' | 'agreed' | 'offered' | 'paid' | 'disputed';
}

export interface ScheduleOfLossData extends BaseDocumentData {
  schedule: {
    /** The date the ledger was read for this schedule. */
    asAt: DateLike;
    /** "Pre-action" or "For service with the claim form". */
    purpose?: string;
  };
  heads: ScheduleOfLossHead[];
  payments?: Array<{ date: DateLike; amountPence: Pence; reference?: string; head?: HeadOfLoss; note?: string }>;
  interest?: {
    /** e.g. "section 69 County Courts Act 1984" */
    basis: string;
    /** Annual simple rate as a fraction, e.g. 0.08. */
    annualRate: number;
    from: DateLike;
    to: DateLike;
    days: number;
    principalPence: Pence;
    amountPence: Pence;
    /** Daily accrual after `to`, from the engine. */
    dailyPence?: Pence;
    continuing?: boolean;
  };
  totals: {
    netPence: Pence;
    vatPence?: Pence;
    grossPence: Pence;
    receivedPence: Pence;
    interestPence: Pence;
    /** gross − received + interest, from the engine. */
    totalPence: Pence;
  };
  /** Adds the claimant's statement of truth (PD 22) for a schedule served in proceedings. The claimant signs. */
  forCourt?: boolean;
}

const SCHEDULE_REQUIRED = [
  'settings.registeredOffice',
  'settings.signatoryName',
  'settings.signatoryRole',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate',
  'schedule.asAt',
  'heads',
  'totals.netPence',
  'totals.grossPence',
  'totals.receivedPence',
  'totals.interestPence',
  'totals.totalPence'
] as const;

const STATUS_LABELS: Record<NonNullable<ScheduleOfLossHead['status']>, string> = {
  claimed: 'Claimed',
  agreed: 'Agreed',
  offered: 'Offer received',
  paid: 'Paid',
  disputed: 'Disputed'
};

export const scheduleOfLossTemplate: Template<ScheduleOfLossData> = {
  id: 'schedule.loss',
  version: '1.0.0',
  kind: 'schedule',
  title: 'Schedule of loss',
  recipientRole: 'at_fault_insurer',
  description: 'Schedule of loss by head, each line with its source document, payments received, interest (basis, rate, period) and totals; claimant’s statement of truth when for court.',
  requiredData: [...SCHEDULE_REQUIRED],
  titleFor: (d) => `Schedule of loss — ${d.claim.claimantName}`,
  sample: () => sampleScheduleOfLoss(),
  render: (d) => {
    const showVat = d.heads.some((h) => h.vatPence !== undefined);
    const showStatus = d.heads.some((h) => h.status);
    const lines: ScheduleLine[] = d.heads.map((h) => ({
      description: h.label ?? HEAD_OF_LOSS_LABELS[h.head],
      detail: [h.description, h.detail, showStatus && h.status ? `Status: ${STATUS_LABELS[h.status]}` : ''].filter(Boolean).join(' · '),
      quantity: h.quantity,
      ratePence: h.ratePence,
      netPence: h.netPence,
      vatPence: showVat ? (h.vatPence ?? 0) : undefined,
      source: h.sourceDocument
    }));
    const totals = showVat
      ? { netPence: d.totals.netPence, vatPence: d.totals.vatPence ?? 0, grossPence: d.totals.grossPence }
      : { netPence: d.totals.netPence, grossPence: d.totals.grossPence };

    const payments =
      d.payments && d.payments.length > 0
        ? dataTable(
            ['Date', 'Amount', 'Reference', 'Applied to'],
            d.payments.map((p) => [formatDateLong(p.date), formatGBP(p.amountPence), p.reference ?? '', [p.head ? HEAD_OF_LOSS_LABELS[p.head] : '', p.note ?? ''].filter(Boolean).join(' — ')]),
            { numeric: [1] }
          )
        : '<p>No payment has been received.</p>';

    const i = d.interest;
    const interest = i
      ? `<p>Interest is claimed under ${escapeHtml(i.basis)} at ${escapeHtml(formatPercent(i.annualRate, Number.isInteger(i.annualRate * 100) ? 0 : 2))} a year, simple, on ${escapeHtml(
          formatGBP(i.principalPence)
        )} from ${escapeHtml(formatDateLong(i.from))} to ${escapeHtml(formatDateLong(i.to))} (${escapeHtml(plural(i.days, 'day'))}): <strong>${escapeHtml(formatGBP(i.amountPence))}</strong>.${
          i.continuing !== false && i.dailyPence !== undefined ? ` Interest continues to accrue at ${escapeHtml(formatRate(i.dailyPence, 'day'))} until payment.` : ''
        } The rate and period are matters for the court if the claim is issued; the figure is shown so the position is clear.</p>`
      : '<p>No interest is claimed in this schedule.</p>';

    const summaryRows: FigureRow[] = [
      { label: showVat ? 'Total of heads of loss (gross)' : 'Total of heads of loss', valuePence: d.totals.grossPence },
      { label: 'Less payments received', valuePence: -d.totals.receivedPence },
      { label: 'Interest', valuePence: d.totals.interestPence },
      { label: 'Total claimed', valuePence: d.totals.totalPence, emphasis: true }
    ];

    const body = `
${subjectBlock(d.claim, { claimantLabel: 'Claimant' })}
<p>This schedule sets out the claimant’s loss arising from the accident on ${escapeHtml(formatDateLong(d.claim.accidentDate))}, taken from the claim ledger as at ${escapeHtml(
      formatDateLong(d.schedule.asAt)
    )}.${d.schedule.purpose ? ` ${escapeHtml(d.schedule.purpose)}` : ''} Each head is supported by the source document shown against it; copies are available on request. If any line is disputed, identify which line and on what basis.</p>
<h2>Heads of loss</h2>
${scheduleTable(lines, { showVat, totals, totalLabel: 'Total' })}
<h2>Payments received</h2>
${payments}
<h2>Interest</h2>
${interest}
<h2>Summary</h2>
${figuresTable(summaryRows)}
${
  d.forCourt
    ? `<p class="small">Prepared from the claim ledger on the claimant’s instructions by ${escapeHtml(brand.company.registeredName)}. The claimant verifies and signs this schedule.</p>${statementOfTruth({
        kind: 'claimant',
        signatoryName: d.claim.claimantName,
        documentNoun: 'schedule of loss'
      })}`
    : ''
}`;

    return baseLayout({
      title: 'Schedule of loss',
      subtitle: `${d.claim.claimantName} — as at ${formatDateLong(d.schedule.asAt)}`,
      kind: 'schedule',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: d.forCourt ? undefined : (d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole }),
      closing: 'Prepared from the claim ledger on the claimant’s instructions by',
      bodyHtml: body,
      extraCss: REPORT_CSS
    });
  }
};

/** Fixture consistent with the invoice and report samples: hire, recovery, storage, fee and repair; £1,112 received; s.69 interest. */
export function sampleScheduleOfLoss(overrides: Partial<ScheduleOfLossData> = {}): ScheduleOfLossData {
  return {
    ...sampleBaseData({ date: '2026-10-04', recipient: sampleRecipient() }),
    schedule: { asAt: '2026-10-04', purpose: 'It is served pre-action so that the position on every head is clear before any claim is issued.' },
    heads: [
      {
        head: 'hire',
        description: 'Volkswagen Golf 1.5 TSI Life, CC26 HIR, GTA group M (industry benchmark), under hire agreement HA-2026-0042',
        detail: `${formatPeriod('2026-08-10', '2026-09-02')} at ${formatRate(4980, 'day')}`,
        quantity: plural(24, 'day'),
        ratePence: 4980,
        netPence: 119520,
        vatPence: 0,
        sourceDocument: 'Hire agreement HA-2026-0042; hire invoice INV-H-0042',
        status: 'disputed'
      },
      {
        head: 'recovery',
        description: 'Recovery from the scene to Example Yard on 9 August 2026: call-out, 31 loaded miles, administration',
        netPence: 20800,
        vatPence: 0,
        sourceDocument: 'Recovery invoice INV-R-0042',
        status: 'claimed'
      },
      {
        head: 'storage',
        description: 'Storage at Example Yard; collect-or-pay notice sent 14 August 2026',
        detail: `${formatPeriod('2026-08-09', '2026-08-16')} at ${formatRate(4500, 'day')}`,
        quantity: plural(8, 'day'),
        ratePence: 4500,
        netPence: 36000,
        vatPence: 0,
        sourceDocument: 'Storage invoice INV-S-0042; notice of 14 August 2026',
        status: 'claimed'
      },
      {
        head: 'engineer_fee',
        description: 'Inspection 12 August 2026 and report ER-2026-0042 issued 14 August 2026',
        netPence: 28500,
        vatPence: 0,
        sourceDocument: 'Fee note INV-E-0042; engineer’s report ER-2026-0042',
        status: 'claimed'
      },
      {
        head: 'repair',
        description: 'Repair of accident damage per the engineer’s estimate; pre-existing items excluded',
        netPence: 197350,
        vatPence: 39470,
        sourceDocument: 'Engineer’s report ER-2026-0042; estimate EST-2026-0042',
        status: 'agreed'
      }
    ],
    payments: [{ date: '2026-09-20', amountPence: 111200, reference: 'EXI/TP/4471920 remittance', head: 'hire', note: 'Interim payment against the hire invoice' }],
    interest: {
      basis: 'section 69 of the County Courts Act 1984',
      annualRate: 0.08,
      from: '2026-09-03',
      to: '2026-10-04',
      days: 32,
      principalPence: 330440,
      amountPence: 2318,
      dailyPence: 72,
      continuing: true
    },
    totals: { netPence: 402170, vatPence: 39470, grossPence: 441640, receivedPence: 111200, interestPence: 2318, totalPence: 332758 },
    forCourt: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTemplate(engineerReportTemplate);
registerTemplate(pavReportTemplate);
registerTemplate(scheduleOfLossTemplate);

/** Every template in this group (for tests and the template picker). */
export const reportTemplates: ReadonlyArray<AnyTemplate> = [engineerReportTemplate, pavReportTemplate, scheduleOfLossTemplate];
