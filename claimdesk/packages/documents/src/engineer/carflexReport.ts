/**
 * CarFlex Engineering & Accident Damage Report — the engineer report template (owner's Word file, 13 sections).
 *
 *   const template = loadCarflexTemplate();
 *   const { docx, sha256, schedule, missing } = renderCarflexReport(template, data, { now });
 *
 * Built on the DOCX engine: `buildCarflexFillInstructions()` maps an EngineerReportData onto the template's real slot
 * ids (from `pnpm --filter @ccguk/documents docx:scan assets/engineer/CarFlex-…docx`) and `fillDocx()` fills them.
 * A short post-pass then handles what the scanner cannot address cleanly in this particular file:
 *   - money / value content controls that hold only spaces (08 values, 09 summary amounts, 07 evidence values and the
 *     assessed value) are written inside the control, in the control's own Arial run;
 *   - "Mileage at inspection / units" (no control in the template) and the CAP HPI value cell;
 *   - printed sample figures ("£12345678" highest valuation) and printed rates that differ from the inputs
 *     (labour rate £72.50, "Overall Discount (0.00%)", "VAT (20.00%)");
 *   - photographs into the IMAGE 01–06 boxes (extra photos add rows), unused photo rows removed;
 *   - the itemised repair schedule appended as Appendix A (landscape), reconciled with sections 08 and 09.
 *
 * The assessor's signature and date signed are NEVER filled (the engine refuses signature slots as well): the report
 * leaves ClaimDesk unsigned and is issued only after a person signs it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Document, Element } from '@xmldom/xmldom';
import { formatDateLong, formatDateShort, formatNumber, formatRegistration } from '../format.js';
import { sha256Hex } from '../hash.js';
import { fillDocx } from '../docx/fill.js';
import { DocxImageSession, findImagePlaceholders, type DocxImageLimits } from '../docx/images.js';
import { normaliseText, paragraphText } from '../docx/text.js';
import type { FillInstruction, FillReport } from '../docx/types.js';
import { openDocx, writeDocx } from '../docx/zip.js';
import { childElements, closestW, createT, createW, isW, markDirty, NS, partDom, removeNode, wAttr, wChild, wChildren, wDescendants } from '../docx/xml.js';
import {
  appendScheduleAppendix,
  computeSchedule,
  discountMoney,
  ESTIMATE_MARK,
  hoursText,
  money,
  percentText,
  DEFAULT_LABOUR_RATE_PENCE,
  DEFAULT_VAT_RATE_PERCENT,
  type ComputedSchedule,
  type LabourCategory,
  type OtherItem,
  type ScheduleLine
} from './itemisedSchedule.js';

export const CARFLEX_TEMPLATE_FILE = 'CarFlex-Engineering-and-Accident-Damage-Report.docx';
export const CARFLEX_TEMPLATE_URL = new URL(`../../assets/engineer/${CARFLEX_TEMPLATE_FILE}`, import.meta.url);

export function carflexTemplatePath(): string {
  return fileURLToPath(CARFLEX_TEMPLATE_URL);
}

export function loadCarflexTemplate(): Uint8Array {
  return new Uint8Array(readFileSync(CARFLEX_TEMPLATE_URL));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** ISO date `YYYY-MM-DD` (or a full ISO date-time). */
type ISO = string;

export type ValuationSourceKey = 'glass' | 'cap_hpi' | 'autotrader' | 'percayso';

export const VALUATION_SOURCE_LABEL: Record<ValuationSourceKey, string> = {
  glass: 'Glass’s Guide',
  cap_hpi: 'CAP HPI',
  autotrader: 'AutoTrader',
  percayso: 'Percayso Vehicle Intelligence'
};

export interface ValuationEvidence {
  source: ValuationSourceKey;
  /** Printed after the source name (e.g. a valuation id or advert reference). */
  reference?: string;
  date?: ISO;
  valuePence: number;
}

export interface ReportPhoto {
  /** JPEG or PNG bytes (EXIF orientation respected). */
  bytes: Uint8Array;
  /** Printed under the photo ("01  …") and used as alt text. */
  description: string;
}

export interface EngineerReportData {
  /** Report reference (cover, header, section 13). */
  reference: string;
  /** Default 'v1'. */
  version?: string;
  /** Default 'Draft — awaiting engineer review and signature'. */
  status?: string;
  reportDate: ISO;
  instruction: {
    /** Default 'Courtesy Cars Group UK Limited'. */
    instructingParty?: string;
    claimantOwner?: string;
    ownInsurer?: string;
    ownInsurerReference?: string;
    thirdPartyInsurer?: string;
    thirdPartyReference?: string;
    dateOfLoss?: ISO;
    locationOfLoss?: string;
    thirdPartyVehicle?: string;
    thirdPartyRegistration?: string;
    dateInstructed?: ISO;
    instructionReference?: string;
    purpose?: string;
  };
  vehicle: {
    registration: string;
    vin?: string;
    make?: string;
    model?: string;
    derivative?: string;
    mileage?: number;
    /** Default 'miles'. */
    mileageUnit?: 'miles' | 'km';
    bodyType?: string;
    doors?: number;
    fuelType?: string;
    transmission?: string;
    engineSizeCc?: number;
    engineCode?: string;
    colour?: string;
    paintCode?: string;
    firstRegistered?: ISO;
  };
  inspection: {
    date?: ISO;
    /** `HH:MM`. */
    time?: string;
    /** Default: the template's printed CarFlex Secure Storage address. */
    location?: string;
    type?: string;
    condition?: string;
    dismantling?: string;
    photographsSource?: string;
    diagnosticTool?: string;
    scanReference?: string;
    warningLamps?: string;
    roadTest?: string;
  };
  circumstances: {
    accountSource?: string;
    reported?: string;
    impactType?: string;
    primaryImpact?: string;
    secondaryContact?: string;
    contactDirection?: string;
    postImpactSymptoms?: string;
  };
  assessment: {
    structural?: string;
    mechanical?: string;
    wheelsTyres?: string;
    wheelGeometry?: string;
    diagnostics?: string;
    roadworthiness?: string;
  };
  valuation?: {
    date?: ISO;
    mileage?: number;
    costNewPence?: number;
    preAccidentCondition?: string;
    evidence?: ValuationEvidence[];
    assessedValuePence?: number;
    salvageValuePence?: number;
    salvageCategory?: string;
    economicAssessment?: string;
    comments?: string;
  };
  repair: {
    lines: ScheduleLine[];
    otherItems?: OtherItem[];
    /** Default £72.50 (7250). */
    labourRatePence?: number;
    /** Default 20. */
    vatRatePercent?: number;
    discountPercent?: number;
    /** Section 08 estimate notes (the estimate status line is added automatically). */
    notes?: string;
  };
  /** Section 10. */
  opinion?: string;
  /** IMAGE 01–06 boxes; more add rows to the photo grid. */
  photos?: ReportPhoto[];
  /** Section 11 "Image source / date". */
  photoSourceAndDate?: string;
  customer?: {
    fullName?: string;
    company?: string;
    representative?: string;
    relationship?: string;
    address?: string;
    town?: string;
    postcodeCountry?: string;
    telephone?: string;
    mobile?: string;
    email?: string;
    vatStatus?: string;
    notes?: string;
  };
  /** Name and role only — signature and date signed are always left blank. */
  assessor?: { name?: string; role?: string };
}

export interface CarflexRenderOptions {
  now: Date;
  imageLimits?: Partial<DocxImageLimits>;
  /** Default true: rows of photo boxes with no photo are removed. */
  removeUnusedPhotoRows?: boolean;
}

export interface CarflexReportResult {
  docx: Uint8Array;
  sha256: string;
  fill: FillReport;
  schedule: ComputedSchedule;
  photos: { placed: number; rowsAdded: number; rowsRemoved: number };
  /** Fields the report prints that the data did not supply (the template's prompt is left in place). */
  missing: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Slot ids (scanner v1 on the owner's file — see carflexReport.test.ts, which pins them)
// ---------------------------------------------------------------------------

const S02 = '02-instruction-and-claim-details';
const S03 = '03-vehicle-details';
const S04 = '04-inspection-details';
const S05 = '05-accident-circumstances';
const S06 = '06-structural-mechanical-and-roadworthiness-asse';
const S07 = '07-valuation';
const S08 = '08-repair-estimate';
const S09 = '09-repair-costs-summary';
const S11 = '11-images-photographic-evidence';
const S12 = '12-customer-client-information';
const S13 = '13-assessor-details-and-sign-off';

/** Section 09 cell slots per row: [labour time, labour costs, material costs]. */
const SUMMARY_ROW_SLOTS: Record<LabourCategory, [string, string, string]> = {
  body: [`${S09}/body`, `${S09}/body#2`, `${S09}/body#3`],
  mechanical: [`${S09}/mechanical`, `${S09}/mechanical#2`, `${S09}/mechanical#3`],
  auxiliary: [`${S09}/auxiliary-work`, `${S09}/auxiliary-work#2`, `${S09}/auxiliary-work#3`],
  paint: [`${S09}/painting`, `${S09}/painting#2`, `${S09}/painting#3`]
};

/** Photo caption slots for boxes 1–6 (the template repeats the 03/04 control tags for 05/06). */
const CAPTION_SLOTS = [`${S11}/photo-caption-1`, `${S11}/photo-caption-2`, `${S11}/photo-caption-3`, `${S11}/photo-caption-4`, `${S11}/photo-caption-3#2`, `${S11}/photo-caption-4#2`];

/** Slots that must never receive a value. */
export const CARFLEX_SIGNATURE_SLOTS = [
  `${S13}/assessor-declaration/assessor-signature`,
  `${S13}/assessor-declaration/assessor-signature#2`,
  `${S13}/assessor-declaration/assessor-signed-date`
] as const;

/** Content-control tags written by the post-pass (whitespace-only controls the scanner reads as value cells). */
export const CARFLEX_VALUE_TAGS = {
  repair: ['Repair_Line_1_1', 'Repair_Line_2_1', 'Repair_Line_3_1', 'Repair_Line_4_1', 'Repair_Line_5_1', 'Repair_Line_6_1', 'Repair_Line_7_1', 'Repair_Line_8_1'],
  summary: ['Summary_Amount_parts', 'Summary_Amount_body', 'Summary_Amount_mechanical', 'Summary_Amount_paint_labour', 'Summary_Amount_paint_materials', 'Summary_Amount_diagnostics', 'Summary_Amount_total'],
  valuation: { glass: 'Valuation_Source_1_2', autotrader: 'Valuation_Source_2_2', percayso: 'Valuation_Source_3_2' },
  assessed: 'Valuation_Adjustment_6'
} as const;

const DASH = '—';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function clean(s: string | undefined | null): string {
  return (s ?? '').trim();
}

function shortDate(iso: ISO | undefined): string {
  return iso ? formatDateShort(iso) : '';
}

function longDate(iso: ISO | undefined): string {
  return iso ? formatDateLong(iso) : '';
}

function vehicleTitle(v: EngineerReportData['vehicle']): string {
  return [v.make, v.model, v.derivative].map(clean).filter(Boolean).join(' ');
}

function mileageText(n: number | undefined, unit: 'miles' | 'km' = 'miles'): string {
  return n === undefined || !Number.isFinite(n) ? '' : `${formatNumber(Math.round(n))} ${unit}`;
}

function bodyTypeText(v: EngineerReportData['vehicle']): string {
  const doors = v.doors ? `${v.doors}-door` : '';
  return [clean(v.bodyType), doors].filter(Boolean).join(', ');
}

function colourText(v: EngineerReportData['vehicle']): string {
  const c = clean(v.colour);
  const p = clean(v.paintCode);
  return c && p ? `${c} / ${p}` : c || p;
}

/** Highest of the supplied valuation evidence (first wins a tie, in the template's row order). */
export function highestValuation(evidence: readonly ValuationEvidence[]): ValuationEvidence | undefined {
  const order: ValuationSourceKey[] = ['glass', 'cap_hpi', 'autotrader', 'percayso'];
  return [...evidence].sort((a, b) => b.valuePence - a.valuePence || order.indexOf(a.source) - order.indexOf(b.source))[0];
}

/** Repair cost incl. VAT as a share of the assessed pre-accident value (`38.2%`). */
export function repairValuePercent(totalPence: number, assessedPence: number | undefined): string {
  if (!assessedPence || assessedPence <= 0) return '';
  return `${((totalPence / assessedPence) * 100).toFixed(1)}%`;
}

function estimateNotes(data: EngineerReportData, s: ComputedSchedule): string {
  const lines: string[] = [];
  const n = clean(data.repair.notes);
  if (n) lines.push(n);
  if (s.unverifiedCount > 0) {
    lines.push(`${s.unverifiedCount} ${s.unverifiedCount === 1 ? 'figure' : 'figures'} in the itemised repair schedule (Appendix A) ${s.unverifiedCount === 1 ? 'is an estimate' : 'are estimates'} — needs confirmation before issue.`);
  } else if (s.lines.length > 0) {
    lines.push('All figures in the itemised repair schedule (Appendix A) have been verified.');
  }
  lines.push(`Labour rate ${money(s.labourRatePence)} per hour; total labour time ${hoursText(s.totalHours)} hours.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fill instructions
// ---------------------------------------------------------------------------

/**
 * Fill instructions for the CarFlex template (everything the engine can address by slot id). Empty values are left
 * out so the template's own prompt stays visible where the data has nothing. Signature slots are never included.
 */
export function buildCarflexFillInstructions(data: EngineerReportData, schedule: ComputedSchedule = scheduleOf(data)): FillInstruction[] {
  const out: FillInstruction[] = [];
  const put = (slotId: string, value: string | undefined): void => {
    const text = clean(value);
    if (text) out.push({ slotId, value: { type: 'text', text } });
  };
  const ins = data.instruction;
  const v = data.vehicle;
  const insp = data.inspection;
  const c = data.circumstances;
  const a = data.assessment;
  const val = data.valuation ?? {};
  const cust = data.customer ?? {};
  const reg = formatRegistration(v.registration);
  const instructing = clean(ins.instructingParty) || 'Courtesy Cars Group UK Limited';
  const version = clean(data.version) || 'v1';
  const status = clean(data.status) || 'Draft — awaiting engineer review and signature';

  // cover
  put('title/cover-vehicle', vehicleTitle(v));
  put('title/cover-registration', reg);
  put('title/cover-reference', data.reference);
  put('title/cover-loss-date', longDate(ins.dateOfLoss));
  put('title/cover-report-date', longDate(data.reportDate));
  put('title/cover-status', status);
  put('title/cover-version', version);
  put('title/cover-instructing-party', instructing);
  // header on every page
  for (const sfx of ['', '#2', '#3']) {
    put(`header/header-registration${sfx}`, reg);
    put(`header/header-report-reference${sfx}`, data.reference);
  }
  // 02
  put(`${S02}/instructing-party`, instructing);
  put(`${S02}/claimant-vehicle-owner`, ins.claimantOwner);
  put(`${S02}/own-insurer`, ins.ownInsurer);
  put(`${S02}/own-insurer-reference`, ins.ownInsurerReference);
  put(`${S02}/third-party-insurer`, ins.thirdPartyInsurer);
  put(`${S02}/third-party-reference`, ins.thirdPartyReference);
  put(`${S02}/date-of-loss`, shortDate(ins.dateOfLoss));
  put(`${S02}/location-of-loss`, ins.locationOfLoss);
  put(`${S02}/third-party-vehicle`, ins.thirdPartyVehicle);
  put(`${S02}/third-party-registration`, ins.thirdPartyRegistration ? formatRegistration(ins.thirdPartyRegistration) : '');
  put(`${S02}/date-instructed`, shortDate(ins.dateInstructed));
  put(`${S02}/instruction-reference`, ins.instructionReference);
  put(`${S02}/purpose-of-instruction/purpose-of-instruction`, ins.purpose);
  // 03 (mileage at inspection has no control: post-pass)
  put(`${S03}/registration`, reg);
  put(`${S03}/vin`, clean(v.vin).toUpperCase());
  put(`${S03}/make`, v.make);
  put(`${S03}/model`, [clean(v.model), clean(v.derivative)].filter(Boolean).join(' '));
  put(`${S03}/body-type-doors`, bodyTypeText(v));
  put(`${S03}/fuel-type`, v.fuelType);
  put(`${S03}/transmission`, v.transmission);
  put(`${S03}/engine-size`, v.engineSizeCc ? `${formatNumber(v.engineSizeCc)} cc` : '');
  put(`${S03}/engine-code`, v.engineCode);
  put(`${S03}/colour-paint-code`, colourText(v));
  put(`${S03}/first-registration`, shortDate(v.firstRegistered));
  // 04 (the template prints sample values: 01/01/2026 is always replaced)
  put(`${S04}/inspection-date`, shortDate(insp.date) || DASH);
  put(`${S04}/inspection-time`, insp.time);
  put(`${S04}/inspection-location`, insp.location);
  put(`${S04}/inspection-type`, insp.type);
  put(`${S04}/condition-at-inspection`, insp.condition);
  put(`${S04}/dismantling-carried-out`, insp.dismantling);
  put(`${S04}/photographs-source`, insp.photographsSource);
  put(`${S04}/diagnostic-scan-tool`, insp.diagnosticTool);
  put(`${S04}/scan-report-reference`, insp.scanReference);
  put(`${S04}/warning-lamps`, insp.warningLamps);
  put(`${S04}/road-test`, insp.roadTest);
  // 05
  put(`${S05}/account-provided-by/account-source`, c.accountSource);
  put(`${S05}/circumstances-as-reported/reported-circumstances`, c.reported);
  put(`${S05}/circumstances-as-reported/reported-impact-type`, c.impactType);
  put(`${S05}/circumstances-as-reported/reported-primary-impact`, c.primaryImpact);
  put(`${S05}/circumstances-as-reported/reported-secondary-contact`, c.secondaryContact);
  put(`${S05}/circumstances-as-reported/reported-contact-direction`, c.contactDirection);
  put(`${S05}/circumstances-as-reported/reported-post-impact-symptoms`, c.postImpactSymptoms);
  // 06
  put(`${S06}/structural-assessment/structural-assessment`, a.structural);
  put(`${S06}/mechanical-assessment/mechanical-assessment`, a.mechanical);
  put(`${S06}/wheels-and-tyres/wheels-tyres`, a.wheelsTyres);
  put(`${S06}/wheel-alignment-geometry/wheel-geometry`, a.wheelGeometry);
  put(`${S06}/diagnostics-and-warning-lamps/diagnostics-findings`, a.diagnostics);
  put(`${S06}/roadworthiness/roadworthiness`, a.roadworthiness);
  // 07 (sample values "September 2026", "00000mi", "SATISFACTORY", "DD/MM/YYYY" are always replaced)
  put(`${S07}/valuation-date`, longDate(val.date) || DASH);
  put(`${S07}/valuation-mileage`, mileageText(val.mileage ?? v.mileage, v.mileageUnit) || DASH);
  put(`${S07}/original-new-price`, val.costNewPence !== undefined ? money(val.costNewPence) : '');
  put(`${S07}/@pre-accident-condition/pre-accident-condition`, clean(val.preAccidentCondition) || DASH);
  const ev = new Map((val.evidence ?? []).map((e) => [e.source, e]));
  const withRef = (k: ValuationSourceKey): string => {
    const e = ev.get(k);
    return e?.reference ? `${VALUATION_SOURCE_LABEL[k]} — ${clean(e.reference)}` : '';
  };
  put(`${S07}/valuation-evidence/@source-reference/valuation-source-1-0`, withRef('glass'));
  put(`${S07}/valuation-evidence/@source-reference/valuation-source-2-0`, withRef('autotrader'));
  put(`${S07}/valuation-evidence/@source-reference/valuation-source-3-0`, withRef('percayso'));
  put(`${S07}/valuation-evidence/@date/valuation-source-1-1`, shortDate(ev.get('glass')?.date) || DASH);
  put(`${S07}/valuation-evidence/@date/valuation-source-1-1#2`, shortDate(ev.get('cap_hpi')?.date) || DASH);
  put(`${S07}/valuation-evidence/@date/valuation-source-2-1`, shortDate(ev.get('autotrader')?.date) || DASH);
  put(`${S07}/valuation-evidence/@date/valuation-source-3-1`, shortDate(ev.get('percayso')?.date) || DASH);
  const high = highestValuation(val.evidence ?? []);
  put(`${S07}/valuation-evidence/@date/highest-valuation`, high ? shortDate(high.date) || DASH : DASH);
  put(`${S07}/assessed-value/salvage-value`, val.salvageValuePence !== undefined ? money(val.salvageValuePence) : '');
  put(`${S07}/assessed-value/salvage-category`, val.salvageCategory);
  put(`${S07}/assessed-value/repair-value-percentage`, repairValuePercent(schedule.totals.totalPence, val.assessedValuePence));
  put(`${S07}/assessed-value/economic-assessment`, val.economicAssessment);
  put(`${S07}/valuation-comments/valuation-comments`, val.comments);
  // 08 (values: post-pass), notes
  put(`${S08}/estimate-notes/estimate-notes`, estimateNotes(data, schedule));
  // 09 table
  for (const cat of ['body', 'mechanical', 'auxiliary', 'paint'] as const) {
    const [time, cost, material] = SUMMARY_ROW_SLOTS[cat];
    const t = schedule.categories[cat];
    put(time, `${hoursText(t.hours)} hrs`);
    put(cost, money(t.labourPence));
    put(material, money(t.materialPence));
  }
  put(`${S09}/other-items`, DASH);
  put(`${S09}/other-items#2`, DASH);
  put(`${S09}/other-items#3`, DASH);
  put(`${S09}/other-items#4`, money(schedule.other.materialPence));
  // 10
  put('10-report-comments-engineers-opinion/engineer-opinion', data.opinion);
  // 11 captions
  (data.photos ?? []).slice(0, 6).forEach((p, i) => put(CAPTION_SLOTS[i]!, p.description));
  put(`${S11}/image-source-date/image-source-date`, data.photoSourceAndDate);
  // 12
  put(`${S12}/customer-full-name`, cust.fullName);
  put(`${S12}/customer-company`, cust.company);
  put(`${S12}/customer-representative`, cust.representative);
  put(`${S12}/customer-vehicle-relationship`, cust.relationship);
  put(`${S12}/customer-address`, cust.address);
  put(`${S12}/customer-town-county`, cust.town);
  put(`${S12}/customer-postcode-country`, cust.postcodeCountry);
  put(`${S12}/customer-telephone`, cust.telephone);
  put(`${S12}/customer-mobile`, cust.mobile);
  put(`${S12}/customer-email`, cust.email);
  put(`${S12}/customer-vat-status`, cust.vatStatus);
  put(`${S12}/customer-notes/customer-notes`, cust.notes);
  // 13 — name, role, reference, status; NEVER signature / date signed
  put(`${S13}/assessor-name`, data.assessor?.name);
  put(`${S13}/assessor-role`, data.assessor?.role);
  put(`${S13}/assessor-declaration/assessor-report-reference`, data.reference);
  put(`${S13}/assessor-declaration/assessor-report-status`, `${version} — ${status}`);
  const forbidden = new Set<string>(CARFLEX_SIGNATURE_SLOTS);
  return out.filter((i) => !forbidden.has(i.slotId));
}

export function scheduleOf(data: EngineerReportData): ComputedSchedule {
  return computeSchedule(data.repair.lines, data.repair.otherItems ?? [], {
    labourRatePence: data.repair.labourRatePence ?? DEFAULT_LABOUR_RATE_PENCE,
    vatRatePercent: data.repair.vatRatePercent ?? DEFAULT_VAT_RATE_PERCENT,
    discountPercent: data.repair.discountPercent ?? 0
  });
}

/** Section 08 value per row (Parts, Labour, Paint, Other, Discount, Net, VAT, Total). */
export function section08Values(s: ComputedSchedule): string[] {
  const t = s.totals;
  return [money(t.partsPence), money(t.labourPence), money(t.paintPence), money(t.otherPence), discountMoney(t.discountPence), money(t.netPence), money(t.vatPence), money(t.totalPence)];
}

/** Section 09 summary amounts (Labour, Material, Paint, Overall Discount, Total excl. VAT, VAT, TOTAL incl. VAT). */
export function section09Values(s: ComputedSchedule): string[] {
  const t = s.totals;
  return [money(t.labourPence), money(t.materialPence), money(t.paintPence), discountMoney(t.discountPence), money(t.netPence), money(t.vatPence), money(t.totalPence)];
}

// ---------------------------------------------------------------------------
// Post-pass DOM helpers
// ---------------------------------------------------------------------------

function sdtsByTag(doc: Document, tag: string): Element[] {
  return wDescendants(doc, 'sdt').filter((s) => wAttr(wChild(wChild(s, 'sdtPr'), 'tag')) === tag);
}

function setRunText(run: Element, text: string): void {
  for (const c of childElements(run)) if (isW(c, 't') || isW(c, 'br') || isW(c, 'tab')) removeNode(c);
  const doc = run.ownerDocument!;
  text.split('\n').forEach((line, i) => {
    if (i > 0) run.appendChild(createW(doc, 'br'));
    if (line) run.appendChild(createT(doc, line));
  });
}

/** Put text inside a content control, in its first run's formatting. */
function setSdtText(sdt: Element, text: string): void {
  const sdtPr = wChild(sdt, 'sdtPr');
  const plc = wChild(sdtPr, 'showingPlcHdr');
  if (plc) removeNode(plc);
  const content = wChild(sdt, 'sdtContent');
  if (!content) return;
  const runs = wDescendants(content, 'r');
  let first = runs[0];
  if (!first) {
    first = createW(sdt.ownerDocument!, 'r');
    (wChildren(content, 'p')[0] ?? content).appendChild(first);
  }
  for (const r of runs.slice(1)) removeNode(r);
  setRunText(first, text);
}

/** The first non-empty run properties inside a content control (to style a sibling value the same way). */
function sdtRunProps(sdt: Element | undefined): Element | undefined {
  const r = sdt ? wDescendants(sdt, 'r')[0] : undefined;
  return r ? wChild(r, 'rPr') : undefined;
}

/** Replace the paragraphs' text of a cell with one run (keeps the first paragraph's pPr). */
function setCellText(tc: Element, text: string, rPr: Element | undefined): void {
  const paras = wChildren(tc, 'p');
  const p = paras[0] ?? tc.appendChild(createW(tc.ownerDocument!, 'p'));
  for (const extra of paras.slice(1)) removeNode(extra);
  for (const c of childElements(p as Element)) if (!isW(c, 'pPr')) removeNode(c);
  const r = createW(tc.ownerDocument!, 'r');
  if (rPr) r.appendChild(rPr.cloneNode(true));
  setRunText(r, text);
  (p as Element).appendChild(r);
}

function cellText(tc: Element): string {
  return normaliseText(wChildren(tc, 'p').map((p) => paragraphText(p).text).join(' '));
}

/** Replace a printed text run's exact text inside `scope` (first match per run; returns the count). */
function replacePrinted(scope: Element, from: string, to: string): number {
  let n = 0;
  for (const t of wDescendants(scope, 't')) {
    const s = t.textContent ?? '';
    if (s.includes(from)) {
      while (t.firstChild) t.removeChild(t.firstChild);
      t.appendChild(t.ownerDocument!.createTextNode(s.split(from).join(to)));
      t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
      n++;
    }
  }
  return n;
}

function tableOfCellText(doc: Document, text: string): Element | undefined {
  for (const tc of wDescendants(doc, 'tc')) if (cellText(tc) === text) return closestW(tc, 'tbl');
  return undefined;
}

/** Remove w14 paragraph ids and sdt ids from a cloned subtree (they must stay unique in the document). */
function stripIds(el: Element): void {
  for (const p of [el, ...wDescendants(el, 'p'), ...wDescendants(el, 'tr')]) {
    p.removeAttributeNS(NS.w14, 'paraId');
    p.removeAttributeNS(NS.w14, 'textId');
  }
  for (const sdt of wDescendants(el, 'sdt')) {
    const id = wChild(wChild(sdt, 'sdtPr'), 'id');
    if (id) removeNode(id);
  }
}

/** The template's grey prompt colour (bracket hints such as "[Describe the assessment requested.]"). */
const HINT_COLOURS = new Set(['95A3B1']);

/**
 * A control that now holds a real value no longer prints in the prompt grey: its run colour is dropped so the value
 * takes the paragraph's text colour. Controls still showing a "[…]" prompt keep it.
 */
function restyleFilledControls(doc: Document): number {
  let n = 0;
  for (const sdt of wDescendants(doc, 'sdt')) {
    const content = wChild(sdt, 'sdtContent');
    if (!content) continue;
    const text = normaliseText(wDescendants(content, 't').map((t) => t.textContent ?? '').join(''));
    if (!text || /^\[.*\]$/.test(text)) continue;
    for (const r of wDescendants(content, 'r')) {
      const color = wChild(wChild(r, 'rPr'), 'color');
      if (color && HINT_COLOURS.has((wAttr(color) ?? '').toUpperCase())) {
        removeNode(color);
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Photo grid
// ---------------------------------------------------------------------------

interface PhotoGrid {
  /** Image row and caption row per pair of boxes, in order (pair k = boxes 2k+1, 2k+2). */
  pairs: Array<{ imageRow: Element; captionRow: Element }>;
}

function photoGrid(doc: Document): PhotoGrid {
  const pairs: PhotoGrid['pairs'] = [];
  for (const tr of wDescendants(doc, 'tr')) {
    const first = wChildren(tr, 'tc')[0];
    if (!first || !/^IMAGE\s*\d+/i.test(cellText(first))) continue;
    let next = tr.nextSibling;
    while (next && !(isW(next, 'tr'))) next = next.nextSibling;
    if (next) pairs.push({ imageRow: tr, captionRow: next as Element });
  }
  return { pairs };
}

/** Text of a paragraph's own runs (not those inside content controls): the first run gets `text`, the rest none. */
function setDirectRunsText(p: Element, text: string): void {
  const runs = wChildren(p, 'r').filter((r) => wChildren(r, 't').length > 0);
  runs.forEach((r, i) => {
    for (const t of wChildren(r, 't')) {
      while (t.firstChild) t.removeChild(t.firstChild);
      if (i === 0 && t === wChildren(r, 't')[0]) {
        t.appendChild(t.ownerDocument!.createTextNode(text));
        t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
      }
    }
  });
}

/** Clone the last pair of photo rows for boxes 7, 8, … (labels and caption numbers renumbered). */
function addPhotoRows(grid: PhotoGrid, upTo: number): number {
  const last = grid.pairs[grid.pairs.length - 1];
  if (!last) return 0;
  let added = 0;
  let after: Element = last.captionRow;
  for (let first = grid.pairs.length * 2 + 1; first <= upTo; first += 2) {
    const img = last.imageRow.cloneNode(true) as Element;
    const cap = last.captionRow.cloneNode(true) as Element;
    stripIds(img);
    stripIds(cap);
    const boxes = wChildren(img, 'tc').filter((tc) => /^IMAGE\s*\d+/i.test(cellText(tc)));
    const caps = wChildren(cap, 'tc').filter((tc) => wDescendants(tc, 'sdt').length > 0);
    boxes.forEach((tc, j) => {
      const labelP = wChildren(tc, 'p').find((p) => /^IMAGE\s*\d+/i.test(normaliseText(paragraphText(p).text)));
      if (labelP) setDirectRunsText(labelP, `IMAGE ${String(first + j).padStart(2, '0')}`);
    });
    caps.forEach((tc, j) => {
      const sdt = wDescendants(tc, 'sdt')[0];
      const capP = sdt ? closestW(sdt, 'p') : undefined;
      if (capP) setDirectRunsText(capP, `${String(first + j).padStart(2, '0')}  `);
      if (sdt) setSdtText(sdt, '[Image description]');
    });
    after.parentNode!.insertBefore(img, after.nextSibling);
    img.parentNode!.insertBefore(cap, img.nextSibling);
    after = cap;
    grid.pairs.push({ imageRow: img, captionRow: cap });
    added += 1;
  }
  return added;
}

/** Caption cell of box `n` (1-based) in the grid. */
function captionCell(grid: PhotoGrid, n: number): Element | undefined {
  const pair = grid.pairs[Math.floor((n - 1) / 2)];
  if (!pair) return undefined;
  const caps = wChildren(pair.captionRow, 'tc').filter((tc) => wDescendants(tc, 'sdt').length > 0 || /^\d{2}/.test(cellText(tc)));
  return caps[(n - 1) % 2];
}

/** Empty an unused box and its caption (keeps the cell, its borders and one paragraph). */
function blankCell(tc: Element): void {
  const paras = wChildren(tc, 'p');
  for (const p of paras.slice(1)) removeNode(p);
  const p = paras[0];
  if (p) for (const c of childElements(p)) if (!isW(c, 'pPr')) removeNode(c);
}

/** A table that lost all its rows goes, with the spacer paragraph after it. */
function removeEmptyTable(tbl: Element): void {
  if (wChildren(tbl, 'tr').length > 0) return;
  const next = tbl.nextSibling;
  if (next && isW(next, 'p') && normaliseText(paragraphText(next as Element).text) === '' && !wDescendants(next as Element, 'sectPr').length) removeNode(next);
  removeNode(tbl);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function missingFields(data: EngineerReportData): string[] {
  const m: string[] = [];
  const need = (ok: unknown, label: string): void => {
    if (ok === undefined || ok === null || (typeof ok === 'string' && ok.trim() === '')) m.push(label);
  };
  need(data.vehicle.registration, 'Registration');
  need(data.vehicle.make, 'Make');
  need(data.vehicle.model, 'Model');
  need(data.vehicle.vin, 'VIN');
  need(data.vehicle.mileage, 'Mileage at inspection');
  need(data.instruction.dateOfLoss, 'Date of loss');
  need(data.inspection.date, 'Inspection date');
  need(data.circumstances.reported, 'Circumstances as reported');
  need(data.assessment.structural, 'Structural assessment');
  need(data.assessment.roadworthiness, 'Roadworthiness');
  need(data.valuation?.assessedValuePence, 'Assessed pre-accident value');
  need(data.opinion, "Engineer's opinion");
  need(data.assessor?.name, 'Assessor name');
  if (!data.photos?.length) m.push('Photographs');
  if (!data.repair.lines.length) m.push('Repair lines');
  return m;
}

/**
 * Fill the CarFlex template: engine fill → post-pass (values, photos, schedule appendix) → bytes. Deterministic: the
 * same template, data and `now` always give the same bytes.
 */
export function renderCarflexReport(template: Uint8Array, data: EngineerReportData, opts: CarflexRenderOptions): CarflexReportResult {
  if (!clean(data.reference)) throw new Error('The report reference is required');
  if (!clean(data.vehicle?.registration)) throw new Error('The vehicle registration is required');
  const schedule = scheduleOf(data);
  const warnings: string[] = [];
  const reg = formatRegistration(data.vehicle.registration);
  const title = `Engineering & Accident Damage Report — ${reg} — ${clean(data.reference)}`;
  const instructions = buildCarflexFillInstructions(data, schedule);
  const filled = fillDocx(template, instructions, {
    coreProps: {
      title,
      subject: `Engineer report ${clean(data.reference)}`,
      keywords: ['engineer report', 'CarFlex', reg, clean(data.reference)],
      description: 'Unsigned until the assessor signs section 13.',
      created: opts.now,
      modified: opts.now
    },
    now: opts.now
  });
  for (const s of filled.report.skipped) warnings.push(`Slot not filled: ${s.slotId} (${s.reason})`);

  const pkg = openDocx(filled.docx);
  const doc = partDom(pkg, 'word/document.xml');
  const val = data.valuation ?? {};

  restyleFilledControls(doc);

  // 08 values
  section08Values(schedule).forEach((text, i) => {
    const sdt = sdtsByTag(doc, CARFLEX_VALUE_TAGS.repair[i]!)[0];
    if (sdt) setSdtText(sdt, text);
    else warnings.push(`Section 08 value control ${CARFLEX_VALUE_TAGS.repair[i]} not found`);
  });
  // 09 summary amounts
  section09Values(schedule).forEach((text, i) => {
    const sdt = sdtsByTag(doc, CARFLEX_VALUE_TAGS.summary[i]!)[0];
    if (sdt) setSdtText(sdt, text);
    else warnings.push(`Section 09 amount control ${CARFLEX_VALUE_TAGS.summary[i]} not found`);
  });
  // 09 printed rates that differ from the inputs
  const summaryTable = tableOfCellText(doc, 'Labour rate');
  if (summaryTable && schedule.labourRatePence !== DEFAULT_LABOUR_RATE_PENCE) replacePrinted(summaryTable, money(DEFAULT_LABOUR_RATE_PENCE), money(schedule.labourRatePence));
  const amountsTable = tableOfCellText(doc, 'TOTAL REPAIR COST incl. VAT');
  if (amountsTable) {
    if (schedule.discountPercent !== 0) replacePrinted(amountsTable, 'Overall Discount (0.00%)', `Overall Discount (${percentText(schedule.discountPercent)})`);
    if (schedule.vatRatePercent !== 20) replacePrinted(amountsTable, 'VAT (20.00%)', `VAT (${percentText(schedule.vatRatePercent)})`);
  }
  // 07 evidence values, CAP HPI value cell, highest valuation, assessed value
  const ev = new Map((val.evidence ?? []).map((e) => [e.source, e]));
  const valueText = (k: ValuationSourceKey): string => {
    const e = ev.get(k);
    return e ? money(e.valuePence) : DASH;
  };
  for (const k of ['glass', 'autotrader', 'percayso'] as const) {
    const sdt = sdtsByTag(doc, CARFLEX_VALUE_TAGS.valuation[k])[0];
    if (sdt) setSdtText(sdt, valueText(k));
  }
  const valueRPr = sdtRunProps(sdtsByTag(doc, CARFLEX_VALUE_TAGS.valuation.glass)[0]);
  const evidenceTable = tableOfCellText(doc, 'HIGHEST VALUATION');
  if (evidenceTable) {
    for (const tr of wChildren(evidenceTable, 'tr')) {
      const cells = wChildren(tr, 'tc');
      const label = cells[0] ? cellText(cells[0]) : '';
      const last = cells[cells.length - 1];
      if (!last) continue;
      if (label === 'CAP HPI') setCellText(last, valueText('cap_hpi'), valueRPr);
      if (label === 'HIGHEST VALUATION') {
        const high = highestValuation(val.evidence ?? []);
        const text = high ? money(high.valuePence) : DASH;
        if (!replacePrinted(last, '£12345678', text)) setCellText(last, text, valueRPr);
      }
    }
  }
  const assessed = sdtsByTag(doc, CARFLEX_VALUE_TAGS.assessed)[0];
  if (assessed) setSdtText(assessed, val.assessedValuePence !== undefined ? money(val.assessedValuePence) : DASH);
  // 03 mileage at inspection (the cell has a label and an empty value paragraph, no control)
  const mileage = mileageText(data.vehicle.mileage, data.vehicle.mileageUnit);
  if (mileage) {
    const tc = wDescendants(doc, 'tc').find((c) => cellText(c) === 'Mileage at inspection / units');
    const valueP = tc ? wChildren(tc, 'p')[1] : undefined;
    if (valueP) {
      const r = createW(doc, 'r');
      const rPr = sdtRunProps(sdtsByTag(doc, 'Body_Type_Doors')[0]);
      if (rPr) r.appendChild(rPr.cloneNode(true));
      setRunText(r, mileage);
      valueP.appendChild(r);
    } else warnings.push('Mileage at inspection cell not found');
  }

  // 11 photographs
  const photos = data.photos ?? [];
  const grid = photoGrid(doc);
  let rowsAdded = 0;
  let rowsRemoved = 0;
  if (photos.length > grid.pairs.length * 2) rowsAdded = addPhotoRows(grid, photos.length);
  photos.forEach((p, i) => {
    if (i < 6) return; // 1–6 captions were filled by the engine
    const cap = captionCell(grid, i + 1);
    const sdt = cap ? wDescendants(cap, 'sdt')[0] : undefined;
    if (sdt) setSdtText(sdt, clean(p.description) || DASH);
  });
  const session = new DocxImageSession(pkg, opts.imageLimits ? { limits: opts.imageLimits } : {});
  const boxes = new Map(findImagePlaceholders(pkg).map((ph) => [ph.number, ph.cell]));
  let placed = 0;
  photos.forEach((p, i) => {
    const cell = boxes.get(i + 1);
    if (!cell) {
      warnings.push(`No IMAGE ${String(i + 1).padStart(2, '0')} box for photo ${i + 1}`);
      return;
    }
    session.replacePlaceholderCell(cell, { bytes: p.bytes, description: clean(p.description), name: `Photo ${String(i + 1).padStart(2, '0')}` });
    placed += 1;
  });
  if (opts.removeUnusedPhotoRows !== false && photos.length > 0) {
    grid.pairs.forEach((pair, k) => {
      const firstBox = k * 2 + 1;
      if (firstBox > photos.length) {
        const tbl = closestW(pair.imageRow, 'tbl');
        removeNode(pair.imageRow);
        removeNode(pair.captionRow);
        rowsRemoved += 1;
        if (tbl) removeEmptyTable(tbl);
      } else if (firstBox + 1 > photos.length) {
        // the second box of a half-used pair is emptied
        const box = wChildren(pair.imageRow, 'tc').filter((tc) => !wDescendants(tc, 'drawing').length && /^IMAGE\s*\d+/i.test(cellText(tc)))[0];
        if (box) blankCell(box);
        const cap = captionCell(grid, firstBox + 1);
        if (cap) blankCell(cap);
      }
    });
  }
  markDirty(pkg, 'word/document.xml');

  // Appendix A — itemised repair schedule
  appendScheduleAppendix(pkg, schedule, { reference: clean(data.reference) });
  if (schedule.unverifiedCount > 0) warnings.push(`${schedule.unverifiedCount} schedule figure(s) marked "${ESTIMATE_MARK}"`);

  const docx = writeDocx(pkg, { mtime: opts.now });
  return {
    docx,
    sha256: sha256Hex(docx),
    fill: filled.report,
    schedule,
    photos: { placed, rowsAdded, rowsRemoved },
    missing: missingFields(data),
    warnings
  };
}
