/**
 * THE PATTERN TO COPY. A complete letter template using the shared layout and partials.
 *
 * It is deliberately NOT imported by ./index.ts (so it never appears in the API's template list); tests register
 * it explicitly. When you write a real template: copy this file's shape into the right templates/*.ts file,
 * change the id/version/title/data, and make sure the file is imported by ./index.ts.
 *
 * Rules every template follows:
 *   1. Pure function of `data` → HTML. No Date.now(), no Math.random(), no I/O.
 *   2. Every figure and date comes from `data` and is printed with format.ts helpers (formatGBP, formatDateLong…).
 *      Never type an amount, a rate or a deadline into the template text.
 *   3. Escape everything (`escapeHtml`, `nl2p`, or a partial that escapes).
 *   4. Voice: short sentences, numbered requirements, a dated deadline with a consequence (voice.md).
 *   5. Perimeter: "we are instructed to correspond on behalf of"; never imply regulated status; GTA is an
 *      "industry benchmark" for a non-subscriber; no FOS threat to the at-fault insurer (perimeter.md).
 *   6. `requiredData` lists every key the render reads; `sample()` returns data that renders cleanly.
 */
import type { ISODate, Pence } from '@ccguk/domain';
import { type BaseDocumentData, sampleBaseData } from '../common.js';
import { escapeHtml, formatDateLong, formatDateWithDay, formatGBP, formatPeriod, numberedList } from '../format.js';
import { baseLayout, callout, chronologyTable, type ChronologyEvent, figuresTable, standardOpener, subjectBlock } from '../layout.js';
import { registerTemplate, type Template } from '../registry.js';

export interface ExampleLetterData extends BaseDocumentData {
  hire: { startAt: ISODate; endAt: ISODate; days: number; dailyRatePence: Pence; totalPence: Pence };
  /** Dated events, from the claim's event log. */
  chronology: ChronologyEvent[];
  /** From the ledger: what has been received against the hire invoice. */
  paidPence: Pence;
  outstandingPence: Pence;
  /** Computed by the API from the clocks engine, never by the template. */
  responseDeadline: ISODate;
}

export const exampleLetterTemplate: Template<ExampleLetterData> = {
  id: 'letter.example',
  version: '1.0.0',
  kind: 'letter',
  title: 'Example letter (pattern)',
  recipientRole: 'at_fault_insurer',
  description: 'Reference implementation of the template pattern. Not registered in production.',
  requiredData: [
    'settings.registeredOffice',
    'date',
    'claim.ourReference',
    'claim.claimantName',
    'claim.vehicleRegistration',
    'claim.accidentDate',
    'recipient.name',
    'hire.startAt',
    'hire.endAt',
    'hire.days',
    'hire.dailyRatePence',
    'hire.totalPence',
    'paidPence',
    'outstandingPence',
    'responseDeadline',
    'chronology'
  ],
  sample: () => ({
    ...sampleBaseData(),
    hire: { startAt: '2026-08-10', endAt: '2026-09-02', days: 24, dailyRatePence: 4980, totalPence: 119520 },
    chronology: [
      { date: '2026-08-09', description: 'Accident. Vehicle unroadworthy; recovered to storage.', attributableTo: 'none' },
      { date: '2026-08-10', description: 'Hire commenced. New Claim Advice Form sent to you.', attributableTo: 'CCGUK' },
      { date: '2026-08-14', description: 'Your engineer inspected the vehicle.', attributableTo: 'insurer' },
      { date: '2026-08-28', description: 'Repair authorised by you (10 working days after inspection).', attributableTo: 'insurer' },
      { date: '2026-09-02', description: 'Repair completed; hire ended the same day.', attributableTo: 'repairer' }
    ],
    paidPence: 0,
    outstandingPence: 119520,
    responseDeadline: '2026-10-18'
  }),
  render: (d) => {
    const body = `
${subjectBlock(d.claim)}
<p>Dear Sirs,</p>
${standardOpener(d.claim)}
<h2>Hire period</h2>
<p>Hire ran from ${escapeHtml(formatPeriod(d.hire.startAt, d.hire.endAt))} at ${escapeHtml(formatGBP(d.hire.dailyRatePence))} per day. The chronology is as follows.</p>
${chronologyTable(d.chronology)}
<p>Of the ${d.hire.days} days of hire, the period between inspection and authorisation is attributable to your own process. We do not accept that any part of it is challengeable.</p>
<h2>Position</h2>
${figuresTable([
  { label: `Hire charges, ${d.hire.days} days`, valuePence: d.hire.totalPence },
  { label: 'Received to date', valuePence: -d.paidPence },
  { label: 'Outstanding', valuePence: d.outstandingPence, emphasis: true }
])}
<h2>What we require</h2>
${numberedList([
  `Payment of ${formatGBP(d.outstandingPence)} to the account details previously supplied.`,
  'If any line is disputed, identify which line and on what basis, with the document you rely on.'
])}
${callout(
  `<p>We require your substantive response by 5pm on ${escapeHtml(formatDateWithDay(d.responseDeadline))}. In the absence of a response by that time, the matter will proceed to the next step in our escalation process, as set out in our letter of ${escapeHtml(formatDateLong(d.date))}, without further notice.</p>`,
  'Deadline'
)}`;
    return baseLayout({
      title: 'Example letter (pattern)',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole },
      bodyHtml: body
    });
  }
};

/** Register on demand (tests, samples). Production templates call registerTemplate at module load instead. */
export function registerExampleTemplate(): Template<ExampleLetterData> {
  return registerTemplate(exampleLetterTemplate);
}
