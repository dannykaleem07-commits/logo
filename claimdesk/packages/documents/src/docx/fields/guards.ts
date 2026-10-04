/**
 * Template guards (design doc §B.7). Pure checks over the scan, the merge source and the values that will print.
 */
import type { MergeSource } from './source.js';
import type { FieldValue, GuardContext, GuardId, GuardResult } from './types.js';

export const PRINTED_RATES = { recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0 } as const;
export const PRINTED_ACCOUNT_NAME = 'COURTESY CARS GROUP UK LTD';
export const PRINTED_SIGNATORY = { name: 'Shahzaib Ahmed Bari', role: 'Director' } as const;
export const PRINTED_LETTER_ROLE = 'Claims Manager';
/** The 03 drafting instruction printed after the rate-position blank. */
export const RATE_POSITION_INSTRUCTION = 'State here how that compares';

function normaliseName(s: string): string {
  return s
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\bLIMITED\b/g, 'LTD')
    .replace(/\s+/g, ' ')
    .trim();
}

function present(v: FieldValue | undefined): boolean {
  if (!v) return false;
  if (v.t === 'text') return v.v.trim() !== '';
  if (v.t === 'list' || v.t === 'rows' || v.t === 'choice') return v.v.length > 0;
  return true;
}

function ratesDiffer(src: MergeSource): string[] {
  const out: string[] = [];
  for (const r of src.recovery) {
    if (r.calloutPence !== PRINTED_RATES.recoveryCalloutPence) out.push(`recovery call-out ${r.calloutPence}p`);
    if (r.perLoadedMilePence !== PRINTED_RATES.perMilePence) out.push(`recovery per loaded mile ${r.perLoadedMilePence}p`);
    if (r.adminPence !== PRINTED_RATES.adminPence) out.push(`recovery admin ${r.adminPence}p`);
    if (r.vatRate > 0) out.push('VAT charged on recovery');
  }
  for (const s of src.storage) {
    if (s.dailyRatePence !== PRINTED_RATES.storageDailyPence) out.push(`storage ${s.dailyRatePence}p a day`);
    if (s.vatRate > 0) out.push('VAT charged on storage');
  }
  if (src.report && src.report.feePence !== PRINTED_RATES.engineerFeePence) out.push(`engineer fee ${src.report.feePence}p`);
  if (src.company.rateCard.vatRate > 0) out.push('rate card VAT above 0');
  return out;
}

export function runTemplateGuards(ids: GuardId[], ctx: GuardContext): GuardResult[] {
  const out: GuardResult[] = [];
  const { source: src, values } = ctx;
  for (const id of ids) {
    switch (id) {
      case 'bankRequired': {
        const b = src.company.bank;
        if (!b || !b.sortCode?.trim() || !b.accountNumber?.trim()) out.push({ code: 'BANK_DETAILS_REQUIRED', severity: 'block', message: 'Bank details are not set in Settings. This form cannot be generated without the sort code and account number.' });
        break;
      }
      case 'bankAccountName': {
        const b = src.company.bank;
        if (b && normaliseName(b.accountName ?? '') !== PRINTED_ACCOUNT_NAME) out.push({ code: 'BANK_ACCOUNT_NAME_MISMATCH', severity: 'block', message: `The account name in Settings ("${b.accountName}") is not the printed account name "Courtesy Cars Group UK Ltd".` });
        break;
      }
      case 'printedRates': {
        const diffs = ratesDiffer(src);
        if (diffs.length) {
          const block = ctx.variant === 'submission';
          out.push({ code: 'PRINTED_RATES_DIFFER', severity: block ? 'block' : 'warn', message: `The records use rates that differ from the printed contract (${diffs.join('; ')}).` });
        }
        break;
      }
      case 'signatoryDirector': {
        const d = src.company.director;
        if (d.name.trim() !== PRINTED_SIGNATORY.name || d.role.trim() !== PRINTED_SIGNATORY.role) out.push({ code: 'SIGNATORY_DIFFERS', severity: 'warn', message: `The template prints "${PRINTED_SIGNATORY.name} — ${PRINTED_SIGNATORY.role}" as the signatory; Settings has "${d.name} — ${d.role}".` });
        break;
      }
      case 'signatoryRole': {
        if (src.user.roleLabel.trim() !== PRINTED_LETTER_ROLE) out.push({ code: 'SIGNATORY_ROLE', severity: 'warn', message: `The letter prints "${PRINTED_LETTER_ROLE}" under your name.` });
        break;
      }
      case 'openRecordsNoNow': {
        const storageOpen = src.storage.length > 0 && src.storage.some((s) => !s.endAt);
        const hire = src.hire?.agreement ?? src.hires[src.hires.length - 1];
        const hireOpen = !!hire && !hire.endAt;
        const leaks: string[] = [];
        if (storageOpen) for (const k of ['storage.endDate', 'storage.releasedAt', 'storage.days', 'storage.netPence']) if (present(values.get(k)) && !ctx.handlerKeys?.has(k)) leaks.push(k);
        if (hireOpen) for (const k of ['hire.endDate', 'hire.returnedAt']) if (present(values.get(k)) && !ctx.handlerKeys?.has(k)) leaks.push(k);
        if (leaks.length) out.push({ code: 'OPEN_RECORD_END', severity: 'block', message: `An open record would print an end date, day count or total (${leaks.join(', ')}).` });
        break;
      }
      case 'hireReference': {
        for (const [k, v] of values) {
          if (v?.t === 'text' && /CCG-(?:HIRE-)?CCG-|CCG-HIRE-CCG/i.test(v.v)) out.push({ code: 'REFERENCE_DOUBLED', severity: 'block', message: `${k} would print a doubled reference prefix ("${v.v}").` });
        }
        break;
      }
      case 'witnessRelationship': {
        if (!present(values.get('witness.relationshipToClaimant'))) out.push({ code: 'WITNESS_RELATIONSHIP_REQUIRED', severity: 'block', message: "Enter the witness's relationship to the claimant (none, family, friend, passenger …)." });
        break;
      }
      case 'ratePositionInstruction': {
        if (ctx.scan.text.includes(RATE_POSITION_INSTRUCTION)) out.push({ code: 'RATE_POSITION_INSTRUCTION', severity: 'warn', message: 'The rate-position drafting sentence ("State here how that compares …") is printed text; edit it in Word before sending if needed.' });
        break;
      }
    }
  }
  return out;
}
