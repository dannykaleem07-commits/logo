// owned by claimai-server
/**
 * Synthetic catch-up files (docs/CLAIM-AI-INPUT.md §16.4), generated at test time. Every person, company other than
 * Courtesy Cars Group UK Ltd, address and reference is invented; the `CATCHUP-…` names make the plan easy to read.
 */
import { makeEml, pngPhoto, textPdf } from '../smartIntake/files.js';
import type { TestFile } from '../smartIntake/scenario.js';
import { CLIENT, INSURER, INSURER_EMAIL } from './scenario.js';

const pdf = (filename: string, content: Buffer): TestFile => ({ filename, mime: 'application/pdf', content });
export const OUR_POSTCODE = 'TW7 5NQ';

/** Our New Claim Advice Form to the insurer, 2 October → out, ncaf, 2 Oct. */
export async function ncafSent(reference: string): Promise<TestFile> {
  return pdf('CATCHUP-NCAF-SENT.pdf', await textPdf([[
    'Courtesy Cars Group UK Ltd',
    `44 Syon Lane, Isleworth, London ${OUR_POSTCODE}`,
    `Our ref: ${reference}`,
    '2 October 2026',
    INSURER,
    'Claims Department, 1 Mutual Way, Sampleton SA1 1MP',
    'Dear Sirs,',
    'New Claim Advice Form',
    `Our client: ${CLIENT.name}. Vehicle: ${CLIENT.vrm}. Accident date: 1 October 2026.`,
    'Please accept this notification of our client\'s claim and confirm your handling office and claim reference.',
    'Yours faithfully,',
    'Claims Team, Courtesy Cars Group UK Ltd',
  ]]));
}

/** The insurer's acknowledgement, 6 October, quoting their new reference → in, letter_in + handling_ref_received. */
export async function insurerAck(reference: string): Promise<TestFile> {
  return pdf('CATCHUP-INSURER-ACK.pdf', await textPdf([[
    INSURER,
    'Claims Department, 1 Mutual Way, Sampleton SA1 1MP',
    'Our ref: TPI/778812',
    `Your ref: ${reference}`,
    '6 October 2026',
    'Courtesy Cars Group UK Ltd',
    `44 Syon Lane, Isleworth, London ${OUR_POSTCODE}`,
    'Dear Sirs,',
    `Your client: ${CLIENT.name} — vehicle ${CLIENT.vrm}`,
    'We acknowledge receipt of your New Claim Advice Form. This claim is being handled by our Sampleton office under our reference TPI/778812.',
    'Yours faithfully,',
    `Third Party Claims, ${INSURER}`,
  ]]));
}

/** Our email asking for the handling office and reference, Fri 9 October (header date) → out, handling_ref_request. */
export function handlingRefRequest(reference: string, ourMailbox: string): TestFile {
  return {
    filename: 'CATCHUP-HANDLING-REF-REQUEST.eml',
    mime: 'message/rfc822',
    content: makeEml({
      from: `Claims Team <${ourMailbox}>`,
      to: INSURER_EMAIL,
      subject: `Request for handling office and claim reference — ${reference}`,
      date: 'Fri, 09 Oct 2026 11:05:00 +0100',
      body: `Dear Sirs,\n\nWe sent you our New Claim Advice Form for our client ${CLIENT.name} (${CLIENT.vrm}) on 2 October. Please confirm your handling office and claim reference.\n\nKind regards,\nClaims Team, Courtesy Cars Group UK Ltd`,
    }),
  };
}

/** The client's email, 8 October → in, email_in. */
export function clientEmail(reference: string, ourMailbox: string): TestFile {
  return {
    filename: 'CATCHUP-CLIENT-EMAIL.eml',
    mime: 'message/rfc822',
    content: makeEml({
      from: `${CLIENT.name} <${CLIENT.email}>`,
      to: ourMailbox,
      subject: `My claim ${reference}`,
      date: 'Thu, 08 Oct 2026 16:20:00 +0100',
      body: `Hello,\n\nJust to let you know the car is still at the garage.\n\nThanks,\n${CLIENT.name}`,
    }),
  };
}

/** A photo taken on 1 October → photo, filed only. */
export const photo = (): TestFile => ({ filename: 'CATCHUP-PHOTO.png', mime: 'image/png', content: pngPhoto(320, 240, 31, { taken: '2026:10:01 09:10:00' }) });

/** The V5C already on the claim (the same bytes) → already on file. */
export async function v5cBytes(): Promise<Buffer> {
  return textPdf([[
    'DVLA V5C Registration Certificate',
    `Registration number: ${CLIENT.vrm}`,
    'Date of first registration: 15/03/2021',
    'Make: VAUXHALL',
    'Model: CORSA',
    `Registered keeper: ${CLIENT.name}`,
  ]]);
}
export const v5cCopy = (bytes: Buffer): TestFile => pdf('CATCHUP-V5C-COPY.pdf', bytes);

/** A letter with no letterhead and no sign-off clues → "Who sent it?". */
export async function plainLetter(reference: string): Promise<TestFile> {
  return pdf('CATCHUP-PLAIN-LETTER.pdf', await textPdf([[
    '5 October 2026',
    `Re: ${CLIENT.vrm} — ${reference}`,
    'Further to the recent telephone conversation, the vehicle remains at the repairer and the repair is expected to take two weeks.',
  ]]));
}

/** An insurer letter about the other claim (its reference and registration) → belongs to that claim. */
export async function otherClaimLetter(otherReference: string, otherVrm: string, otherName: string): Promise<TestFile> {
  return pdf('CATCHUP-OTHER-CLAIM.pdf', await textPdf([[
    'Other Example Insurance plc',
    'Claims, 9 Policy Street, Otherton OT1 1PL',
    'Our ref: OEI/55120',
    `Your ref: ${otherReference}`,
    '7 October 2026',
    'Courtesy Cars Group UK Ltd',
    'Dear Sirs,',
    `Your client: ${otherName} — vehicle ${otherVrm}`,
    'We acknowledge your notification and will revert once our insured has reported the accident.',
    'Yours faithfully,',
    'Other Example Insurance plc',
  ]]));
}

/** A three-page pack: police report, repair estimate, MOT certificate → split into three, filed by kind. */
export async function pack(reference: string): Promise<TestFile> {
  return pdf('CATCHUP-PACK.pdf', await textPdf([
    ['POLICE REPORT', 'Incident reference: TV-26-104411', 'Date of incident: 01/10/2026 08:35', `Vehicle 1: ${CLIENT.vrm}`, 'Vehicle 2: LM19 XYZ', 'Location: Example Road, Testville', `Claim: ${reference}`],
    ['REPAIR ESTIMATE', 'Sample Bodyshop Ltd', 'Estimate date: 04/10/2026', `Vehicle: ${CLIENT.vrm}`, 'Parts: £1,240.00', 'Labour: £860.00', 'Total inc VAT: £2,520.00'],
    ['MOT TEST CERTIFICATE', `Registration: ${CLIENT.vrm}`, 'Test date: 12/03/2026', 'Expiry date: 11/03/2027', 'Result: PASS'],
  ]));
}
