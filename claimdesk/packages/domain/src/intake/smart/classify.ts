/**
 * Deterministic document classifier (docs/SMART-INTAKE.md §4.2): a weighted phrase / pattern table per document type.
 * Used for the rules reading of every file (works with the AI paused) and per page for scanned-pack splitting. Rules
 * confidence never reaches the 0.9 auto-apply line on its own (capped at 0.85).
 */
import type { DocType } from '../../agents/types.js';

interface Rule {
  re: RegExp;
  w: number;
}

const phrase = (p: string, w: number): Rule => ({ re: new RegExp(`(?<![A-Za-z0-9])(?:${p})(?![A-Za-z0-9])`, 'i'), w });

/** DVLA licence number (uppercase, surname padded with 9s). */
export const DVLA_LICENCE_RE = /\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/;

const TABLE: Readonly<Partial<Record<DocType, Rule[]>>> = {
  v5c: [phrase('V5C', 5), phrase('registration certificate', 4), phrase('registered keeper', 3), phrase('DVLA', 1), phrase('date of acquisition|date of first registration', 2)],
  driving_licence: [{ re: DVLA_LICENCE_RE, w: 5 }, phrase('DRIVING LICENCE', 4), phrase('licence (?:number|no)', 1), phrase('4a\\.|4b\\.|4c\\.', 2)],
  insurance_certificate: [phrase('certificate of motor insurance', 5), phrase('persons or classes of persons entitled to drive', 4), phrase('effective date of the commencement of insurance|period of insurance', 2), phrase('limitations as to use', 2)],
  police_report: [phrase('collision report|incident report', 3), phrase('police', 2), phrase('crime reference|incident number|CAD', 3), phrase('officer|constable|PC \\d+', 1)],
  fnol_form: [phrase('accident report|claim form|details of the accident|accident details', 4), phrase('describe what happened|circumstances of the accident', 2), phrase('signature of (?:the )?(?:claimant|client|policyholder)', 1)],
  insurer_letter: [phrase('our ref|your ref', 2), phrase('dear', 1), phrase('liability', 2), phrase('policyholder|our insured', 1), phrase('without prejudice', 1)],
  engineer_report: [phrase("engineer'?s report|assessment report|pre-accident value|repair method", 4), phrase('inspected|inspection', 1)],
  bodyshop_estimate: [phrase('estimate|labour|paint (?:&|and) materials|parts', 3), phrase('VAT|total', 1), phrase('bodyshop|body shop|repair estimate', 2)],
  audatex_estimate: [phrase('audatex|audaenterprise', 5)],
  invoice: [phrase('invoice (?:no|number)|amount due', 4), phrase('invoice', 1)],
  bank_statement: [phrase('sort code', 3), phrase('balance', 2), phrase('statement', 1)],
  payslip: [phrase('payslip|gross pay|NI number', 4), phrase('net pay|tax code', 2)],
  mot_certificate: [phrase('MOT test certificate|VT20', 5), phrase('MOT', 1), phrase('odometer reading|test station', 1)],
  witness_statement: [phrase('witness statement|statement of truth', 4), phrase('I believe that the facts stated', 2)],
  proof_of_address: [phrase('council tax|utility bill|electricity|gas bill', 3), phrase('account holder|billing address|bill date', 1)],
  correspondence: [],
};

const FILENAME_HINTS: ReadonlyArray<{ re: RegExp; type: DocType }> = [
  { re: /v5c|logbook|log book/i, type: 'v5c' },
  { re: /licen[cs]e/i, type: 'driving_licence' },
  { re: /insurance[-_ ]?cert|certificate[-_ ]of[-_ ]insurance|cert[-_ ]?of[-_ ]?ins/i, type: 'insurance_certificate' },
  { re: /police/i, type: 'police_report' },
  { re: /claim[-_ ]?form|accident[-_ ]?report|fnol/i, type: 'fnol_form' },
  { re: /estimate|quote/i, type: 'bodyshop_estimate' },
  { re: /engineer|assessment/i, type: 'engineer_report' },
  { re: /invoice/i, type: 'invoice' },
  { re: /\bmot\b|mot[-_ ]?cert/i, type: 'mot_certificate' },
  { re: /witness/i, type: 'witness_statement' },
  { re: /bank[-_ ]?statement/i, type: 'bank_statement' },
  { re: /payslip/i, type: 'payslip' },
];

export interface ClassifyOptions {
  filename: string;
  fingerprintTemplateId: string | null;
  isEmail: boolean;
  isImage: boolean;
  insurerNames: string[];
}

export interface ClassifyResult {
  docType: DocType;
  confidence: number;
  scores: Partial<Record<DocType, number>>;
}

/** Maximum confidence of a rules classification. */
export const RULES_MAX_CONFIDENCE = 0.85;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Raw weighted scores for the text (exported for page-level splitting). */
export function scoreText(text: string, opts: Pick<ClassifyOptions, 'insurerNames' | 'fingerprintTemplateId'> & { filename?: string }): Partial<Record<DocType, number>> {
  const scores: Partial<Record<DocType, number>> = {};
  const add = (t: DocType, w: number) => {
    scores[t] = (scores[t] ?? 0) + w;
  };
  for (const [type, rules] of Object.entries(TABLE) as Array<[DocType, Rule[]]>) {
    for (const r of rules) if (r.re.test(text)) add(type, r.w);
  }
  const lower = text.toLowerCase();
  for (const name of opts.insurerNames) {
    const n = name.trim();
    if (n.length < 3) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(n.toLowerCase())}(?![A-Za-z0-9])`).test(lower)) {
      add('insurer_letter', 3);
      break;
    }
  }
  if (opts.fingerprintTemplateId) add('signed_ccguk_form', 6);
  if (opts.filename) {
    for (const h of FILENAME_HINTS) if (h.re.test(opts.filename)) add(h.type, 2);
  }
  for (const k of Object.keys(scores) as DocType[]) if (!scores[k]) delete scores[k];
  return scores;
}

function ranked(scores: Partial<Record<DocType, number>>): Array<[DocType, number]> {
  return (Object.entries(scores) as Array<[DocType, number]>).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Classify a document's text. */
export function classifyText(text: string, opts: ClassifyOptions): ClassifyResult {
  const t = text ?? '';
  if (opts.isImage && t.trim().length < 20) return { docType: 'vehicle_photo_other', confidence: 0.3, scores: {} };
  const scores = scoreText(t, opts);
  const order = ranked(scores);
  const top = order[0];
  const second = order[1]?.[1] ?? 0;
  if (opts.isEmail) {
    if (!top || top[1] < 6) return { docType: 'correspondence', confidence: 0.6, scores };
  }
  if (!top) return { docType: 'other', confidence: t.trim() ? 0.2 : 0, scores };
  const confidence = Math.min(RULES_MAX_CONFIDENCE, Math.round((top[1] / (top[1] + second + 2)) * 100) / 100);
  return { docType: top[0], confidence, scores };
}

/** Top type and its margin over the second (for page splitting). */
export function topTypeOf(scores: Partial<Record<DocType, number>>): { type: DocType | null; top: number; second: number } {
  const order = ranked(scores);
  return { type: order[0]?.[0] ?? null, top: order[0]?.[1] ?? 0, second: order[1]?.[1] ?? 0 };
}
