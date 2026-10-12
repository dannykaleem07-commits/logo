// owned by intake-server
/**
 * The smart-intake scenario (docs/SMART-INTAKE.md §16.3, §16.6): every document generated at test time with invented
 * people, vehicles and references. The `SMART-…` markers in the file names are what the FakeDriver fixtures
 * (apps/api/src/ai/fixtures/intake/smart-extract.json, bundle-reason.json) match on.
 *
 *  Case A — Jane Doe, Vauxhall Corsa KX21 ABC, hit from behind by LM19 XYZ (Tom Other, Example Mutual Insurance) at
 *           08:35 on 1 October 2026 (police) / 08:40 (claim form).
 *  Case B — Ali Example, YB68 KDL (a different accident in August).
 *  Claim  — a letter quoting CCG-2026-00001 (seeded claim: Sam Sample, GH70 KLM).
 *  Clean  — "Clean Case": Pat Clean, CL19 EAN v RS20 ABC — consistent documents for automatic registration.
 */
import type { AppContext } from '../../../context.js';
import type { TestApp } from '../../helpers.js';
import { FNOL } from '../../helpers.js';
import { drainIntake as drainIntakeBase } from '../intake/helpers.js';
import { blankPdf, editedPdf, makeEml, pngPhoto, textPdf, zipOf } from './files.js';
import { startWorker } from '../../../agent/worker.js';
import { openGates } from '../../../agent/queue.js';
import { AGENT_NAMES } from '@ccguk/domain';
import { intakeJobHandlers } from '../../../agent/handlers/intake.js';

export const NOW = '2026-10-05T09:00:00.000Z';
export const BUNDLE_A = 'Jane Doe – Corsa crash';

export interface TestFile {
  filename: string;
  mime: string;
  content: Buffer;
}

const pdf = (filename: string, content: Buffer): TestFile => ({ filename, mime: 'application/pdf', content });
const png = (filename: string, content: Buffer): TestFile => ({ filename, mime: 'image/png', content });

// ---------------------------------------------------------------------------
// Case A
// ---------------------------------------------------------------------------

export const A = {
  name: 'Jane Doe',
  phone: '07700 900456',
  email: 'jane.doe@example.test',
  vrm: 'KX21 ABC',
  vin: 'WVWZZZ1JZXW000123',
  estimateVin: 'WVWZZZ1JZXW000128',
  tpVrm: 'LM19 XYZ',
  tpName: 'Tom Other',
  tpInsurer: 'Example Mutual Insurance',
  tpRef: 'TPI/778812',
  tpPolicy: 'EMI-55501234',
  licence: 'DOE99853148J99AB',
  location: 'Junction of Example Road and Sample Lane, Testville AB1 2CD',
  circumstances: 'I was waiting at the give way line on Sample Lane when the other car drove into the back of my car.',
};

export async function v5cA(): Promise<TestFile> {
  return pdf('SMART-A-V5C.pdf', await textPdf([[
    'DVLA V5C Registration Certificate',
    'Registration number: KX21 ABC',
    'Date of first registration: 15/03/2021',
    'Make: VAUXHALL',
    'Model: CORSA',
    'Colour: BLUE',
    'VIN: WVWZZZ1JZXW000123',
    'Registered keeper: Jane Doe',
    'Address: 12 Example Road',
    'Testville',
    'AB1 2CD',
    'Date of acquisition: 20/04/2021',
  ]]));
}

export async function claimFormA(): Promise<TestFile> {
  return pdf('SMART-A-CLAIM-FORM.pdf', await textPdf([[
    'Accident Report - Claim Form',
    'Your details',
    'Full name: Jane Doe',
    'Date of birth: 14/08/1988',
    'Address: 12 Example Road, Testville AB1 2CD',
    'Mobile: 07700 900456',
    'Email: jane.doe@example.test',
    'Licence number: DOE99853148J99AB',
    'Your vehicle',
    'Registration: KX21 ABC',
    'Accident details',
    'Date of accident: 01/10/2026',
    'Time: 08:40',
    'Location: Junction of Example Road and Sample Lane, Testville AB1 2CD',
    'Describe what happened: I was waiting at the give way line on Sample Lane when the other car',
    'drove into the back of my car.',
    'Police attended: Yes',
    'Witnesses: none',
    'Injuries: No',
    'Vehicle driveable: No',
    'Replacement car needed: Yes',
    'Other driver',
    'Name: Tom Other',
    'Registration: LM19 XYZ',
    'Insurer: Example Mutual Insurance',
    'Signature of claimant: Jane Doe',
  ]]));
}

/** Police report (p1), bodyshop estimate (p2–3, VIN one character different) and MOT certificate (p4) in one PDF. */
export async function textPackA(): Promise<TestFile> {
  return pdf('SMART-A-PACK.pdf', await textPdf([
    [
      'Collision Report - Example Constabulary',
      'Page 1 of 1',
      'Police reference: EXC/4512/26',
      'Date of incident: 01/10/2026',
      'Time: 08:35',
      'Location: Junction of Example Road and Sample Lane, Testville AB1 2CD',
      'Vehicle 1 details',
      'Registration: KX21 ABC',
      'Name: Jane Doe',
      'Vehicle 2 details',
      'Registration: LM19 XYZ',
      'Name: Tom Other',
      'Officer notes - vehicle 2 struck the rear of vehicle 1, which was stationary.',
    ],
    [
      'Example Bodyshop Ltd - Repair Estimate',
      'Page 1 of 2',
      'Estimate date: 03/10/2026',
      'Registration: KX21 ABC',
      'VIN: WVWZZZ1JZXW000128',
      'Make and model: Vauxhall Corsa',
      'Repairer: Example Bodyshop Ltd',
      'Labour and parts',
      'Rear bumper cover - replace',
      'Tailgate - repair',
    ],
    [
      'Example Bodyshop Ltd - Repair Estimate',
      'Page 2 of 2',
      'Paint and materials',
      'Total including VAT 1,234.00',
    ],
    [
      'MOT test certificate VT20',
      'Page 1 of 1',
      'Registration: KX21 ABC',
      'Make: VAUXHALL',
      'Expiry date: 10/03/2027',
      'Odometer reading 31,200 miles',
    ],
  ]));
}

/** A supplementary estimate saved by an online editor, modified 30 days after creation, with an incremental save. */
export async function editedEstimateA(): Promise<TestFile> {
  return pdf('SMART-A-ESTIMATE-EDITED.pdf', await editedPdf([[
    'Example Bodyshop Ltd - Supplementary Repair Estimate',
    'Estimate date: 04/10/2026',
    'Registration: KX21 ABC',
    'Rear bumper reinforcement - replace',
    'Total including VAT 310.00',
  ]], new Date('2026-08-20T10:00:00Z')));
}

export async function tpLetterA(): Promise<TestFile> {
  return pdf('SMART-A-TP-LETTER.pdf', await textPdf([[
    'Example Mutual Insurance',
    'Claims Department, 1 Insurance Way, Exampleton EX1 1AA',
    '03/10/2026',
    'Our ref: TPI/778812',
    'Dear Sirs',
    'Insurer: Example Mutual Insurance',
    'Policyholder: Tom Other',
    'Policy number: EMI-55501234',
    'Our insured vehicle LM19 XYZ',
    'Your client: Jane Doe, vehicle KX21 ABC',
    'We acknowledge your notification of this accident on 01/10/2026. Liability is under investigation.',
  ]]));
}

export async function emlA(): Promise<TestFile> {
  const letter = await tpLetterA();
  return {
    filename: 'SMART-A-EMAIL.eml',
    mime: 'message/rfc822',
    content: makeEml({
      from: 'claims@tp-insurer.example.test',
      to: 'claims@ccguk.example.test',
      subject: 'Your client Jane Doe - our ref TPI/778812',
      date: 'Sat, 03 Oct 2026 10:00:00 +0100',
      body: 'Please find our acknowledgement attached.\r\nOur ref: TPI/778812\r\nExample Mutual Insurance claims team',
      attachments: [{ filename: letter.filename, mime: letter.mime, content: letter.content }],
    }),
  };
}

const GPS = { lat: 51.5, lon: -0.12 };
/** Damage photo 20 minutes after the accident (camera clock, wall time). */
export const photo2041 = (): TestFile => png('SMART-A-PHOTO-2041.png', pngPhoto(320, 240, 4, { taken: '2026:10:01 09:05:00', gps: GPS }));
/** The same photo resized and re-encoded (near duplicate). */
export const photo2041Copy = (): TestFile => png('SMART-A-PHOTO-2041 (1).png', pngPhoto(160, 120, 4, { taken: '2026:10:01 09:05:00', gps: GPS }));
/** Taken three days before the accident (signal: photo before the accident). */
export const photo1999 = (): TestFile => png('SMART-A-PHOTO-1999.png', pngPhoto(320, 240, 11, { taken: '2026:09:28 15:00:00', gps: { lat: 51.5005, lon: -0.1205 } }));
export const photo2050 = (): TestFile => png('SMART-A-PHOTO-2050.png', pngPhoto(320, 240, 7, { taken: '2026:10:01 09:07:00', gps: GPS }));
/** A phone photo of the licence (no EXIF; the AI reads it). */
export const licencePhotoA = (): TestFile => png('SMART-A-LICENCE-FRONT.png', pngPhoto(300, 190, 20, {}));

export function zipA(): TestFile {
  const p2041 = photo2041();
  const p2050 = photo2050();
  return {
    filename: 'SMART-A-PHOTOS.zip',
    mime: 'application/zip',
    content: zipOf({
      [p2041.filename]: p2041.content,
      [p2050.filename]: p2050.content,
      [`__MACOSX/._${p2050.filename}`]: Buffer.from('mac resource fork'),
      'SMART-A-NOTES.txt': Buffer.from('Notes from Jane: call me on 07700 900456 after 5pm.\n', 'utf8'),
    }),
  };
}

/** A blank 3-page "scanned" pack (no text layer): the AI proposes licence back (p1) + insurance certificate (p2–3). */
export async function scannedPackA(): Promise<TestFile> {
  return pdf('SMART-A-SCANNED.pdf', await blankPdf(3));
}

/** A letter rendered by Chromium (a real producer string) — falls back to pdf-lib when no Chromium is available. */
export async function liabilityLetterA(render?: (html: string) => Promise<Buffer>): Promise<TestFile> {
  const lines = [
    'Example Mutual Insurance',
    '04/10/2026',
    'Our ref: TPI/778812',
    'Dear Sirs',
    'Your client: Jane Doe, vehicle KX21 ABC',
    'Following our enquiries we accept liability for this accident on behalf of our policyholder.',
  ];
  if (render) {
    const html = `<!doctype html><html><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`;
    return pdf('SMART-A-LIABILITY-LETTER.pdf', await render(html));
  }
  return pdf('SMART-A-LIABILITY-LETTER.pdf', await textPdf([lines]));
}

// ---------------------------------------------------------------------------
// Case B, the existing claim's letter, the clean case
// ---------------------------------------------------------------------------

export async function v5cB(): Promise<TestFile> {
  return pdf('SMART-B-V5C.pdf', await textPdf([[
    'DVLA V5C Registration Certificate',
    'Registration number: YB68 KDL',
    'Date of first registration: 10/09/2018',
    'Make: SKODA',
    'Model: OCTAVIA',
    'VIN: TMBJJ7NE0J0000456',
    'Registered keeper: Ali Example',
    'Address: 5 Sample Close',
    'Otherton',
    'XY9 8ZZ',
  ]]));
}

export async function letterB(): Promise<TestFile> {
  return pdf('SMART-B-LETTER.pdf', await textPdf([[
    'Northern Example Insurance',
    '20/08/2026',
    'Our ref: NEI/55120',
    'Dear Sirs',
    "Client's name: Ali Example",
    "Client's address: 5 Sample Close, Otherton XY9 8ZZ",
    "Client's vehicle registration: YB68 KDL",
    'Date of accident: 15/08/2026',
    'We write regarding the accident. Liability is under investigation.',
  ]]));
}

export async function letterForClaim1(): Promise<TestFile> {
  return pdf('SMART-C-LETTER.pdf', await textPdf([[
    'Southern Example Assurance',
    '02/10/2026',
    'Our ref: SEA/90011',
    'Your ref: CCG-2026-00001',
    'Dear Sirs',
    "Your client's vehicle registration: GH70 KLM",
    'We confirm receipt of your letter and will respond within 21 days.',
  ]]));
}

export const CLEAN = 'Clean Case';
export async function cleanCaseFiles(): Promise<TestFile[]> {
  const form = pdf('SMART-CLEAN-CLAIM-FORM.pdf', await textPdf([[
    'Accident Report - Claim Form',
    'Your details',
    'Full name: Pat Clean',
    'Address: 9 Tidy Street, Neatville CD3 4EF',
    'Mobile: 07700 900888',
    'Email: pat.clean@example.test',
    'Your vehicle',
    'Registration: CL19 EAN',
    'Accident details',
    'Date of accident: 02/10/2026',
    'Time: 17:15',
    'Location: Tidy Street car park entrance, Neatville CD3 4EF',
    'Describe what happened: I was parked and empty when the other vehicle reversed into the front of my car',
    'while I was walking back to it.',
    'Police attended: No',
    'Witnesses: none',
    'Injuries: No',
    'Vehicle driveable: Yes',
    'Replacement car needed: No',
    'Other driver',
    'Name: Robin Driver',
    'Registration: RS20 ABC',
    'Insurer: Example Mutual Insurance',
    'Signature of claimant: Pat Clean',
  ]]));
  const v5c = pdf('SMART-CLEAN-V5C.pdf', await textPdf([[
    'DVLA V5C Registration Certificate',
    'Registration number: CL19 EAN',
    'Date of first registration: 01/06/2024',
    'Make: KIA',
    'Model: PICANTO',
    'VIN: KNAB2512ABC000777',
    'Registered keeper: Pat Clean',
    'Address: 9 Tidy Street',
    'Neatville',
    'CD3 4EF',
  ]]));
  return [form, v5c];
}

// ---------------------------------------------------------------------------
// Test driving helpers
// ---------------------------------------------------------------------------

/** multipart/form-data body for app.inject. */
export function multipart(files: TestFile[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----smart-intake-boundary';
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function uploadToBundle(t: TestApp, bundleId: string, files: TestFile[]): Promise<{ status: number; body: { files: Array<{ fileId: string; itemId: string; filename: string; outcome: string }>; bundle: Record<string, unknown> } & Record<string, unknown> }> {
  const m = multipart(files);
  const res = await t.app.inject({ method: 'POST', url: `/api/intake/bundles/${bundleId}/files`, payload: m.payload, headers: m.headers });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** Seed the existing claim CCG-2026-00001 (Sam Sample, GH70 KLM) and a claim whose claimant has Jane's phone. */
export async function seedClaims(t: TestApp): Promise<{ claim1: { id: string; reference: string }; claim2: { id: string; reference: string } }> {
  const one = await t.api<{ id: string; reference: string }>('POST', '/claims', {
    ...FNOL,
    claimant: { kind: 'individual', name: 'Sam Sample', phone: '07700 900777', email: 'sam.sample@example.test', address: { line1: '1 Other Road', town: 'Elsewhere', postcode: 'EL1 1SE' }, roles: ['claimant', 'driver'] },
    vehicle: { registration: 'GH70 KLM', make: 'Ford', model: 'Focus', ownership: 'client' },
    thirdPartyVehicle: { registration: 'PD18 RST', make: 'BMW', model: '3 Series', ownership: 'third_party' },
  });
  if (one.status !== 201) throw new Error(`seed claim 1: ${one.status} ${JSON.stringify(one.body)}`);
  const two = await t.api<{ id: string; reference: string }>('POST', '/claims', {
    ...FNOL,
    claimant: { kind: 'individual', name: 'Chris Contact', phone: A.phone, email: 'chris.contact@example.test', address: { line1: '3 Far Lane', town: 'Distant', postcode: 'DI5 7NT' }, roles: ['claimant', 'driver'] },
    vehicle: { registration: 'JK66 MNO', make: 'Fiat', model: '500', ownership: 'client' },
    thirdPartyVehicle: { registration: 'RS17 TUV', make: 'Audi', model: 'A3', ownership: 'third_party' },
  });
  if (two.status !== 201) throw new Error(`seed claim 2: ${two.status} ${JSON.stringify(two.body)}`);
  return { claim1: { id: one.body.id, reference: one.body.reference }, claim2: { id: two.body.id, reference: two.body.reference } };
}

/** Agents on / off (Settings > AI). */
export function setAgents(ctx: AppContext, enabled: boolean): void {
  const s = ctx.repos.getAgentSettings(ctx.db);
  ctx.repos.patchAgentSettings(ctx.db, { agents: { ...s.agents, enabled } } as never, { userId: 'test' }, ctx.now());
}

/**
 * Drain the intake jobs (cpu/io; the AI lane only when agents are on) at a clock past the quiet period. Every other
 * agent is paused. Returns the settled jobs.
 */
export async function drain(t: TestApp, opts: { ai?: boolean; rounds?: number; at?: string } = {}): Promise<Array<{ type: string; outcome: string }>> {
  const at = opts.at ?? new Date(Date.parse(t.ctx.now()) + 10 * 60_000).toISOString();
  t.setNow(at);
  const w = startWorker(t.ctx, { owner: 'smart-intake-test', handlers: intakeJobHandlers });
  const gates = { ...openGates(), pausedAgents: [...AGENT_NAMES.filter((a) => a !== 'intake'), 'system'] };
  // the AI lane follows Settings (agents off / kill switch) unless the caller says otherwise
  const settings = t.ctx.repos.getAgentSettings(t.ctx.db);
  const aiOpen = opts.ai ?? (settings.agents.enabled && !settings.autonomy.killSwitch);
  if (!aiOpen) Object.assign(gates.lanes.ai, { open: false, maxPriority: -1, reason: settings.autonomy.killSwitch ? 'kill_switch' : 'agents_off' });
  const all: Array<{ type: string; outcome: string }> = [];
  for (let i = 0; i < (opts.rounds ?? 300); i += 1) {
    const settled = await w.tick(t.ctx.now(), gates);
    if (!settled.length) {
      // debounced reconciles wait for the quiet period: move the clock on once and look again
      const pending = t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM agent_jobs WHERE status = 'queued' AND type LIKE 'intake.%' AND run_after > ?`).get(t.ctx.now()) as { n: number };
      if (!pending.n) break;
      t.setNow(new Date(Date.parse(t.ctx.now()) + 60_000).toISOString());
      continue;
    }
    all.push(...settled.map((s) => ({ type: s.type, outcome: s.outcome })));
  }
  await w.stop(100);
  return all;
}

export { drainIntakeBase };
