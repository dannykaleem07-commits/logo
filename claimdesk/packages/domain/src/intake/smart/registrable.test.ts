import { describe, expect, it } from 'vitest';
import { registrable, type RegistrableInput } from './registrable.js';
import { caseSummaryTemplate, verifySummary } from './briefText.js';
import { BANNED_INTAKE_WORDS } from './types.js';

const clean: RegistrableInput = {
  filesInProgress: 0, conflictsOpen: 0, missingKey: [], lowKey: [], contactMissing: false, fnolErrors: [], fnolWarnings: ['Confirm the call-recording disclosure was read'],
  mainMatchesClaim: null, confirmedNew: false, signalsWarn: 0, signalsOpen: 0, unsureFiles: 0, otherGroups: 0, reasoningDone: true, injection: false,
  duplicateOpenClaim: false, settingOn: true, minConfidence: 0.9, policy: { outcome: 'auto', reasons: [] },
};
const codes = (i: RegistrableInput) => registrable(i).blockers.map((b) => b.code);

describe('registrable', () => {
  it('a clean bundle can be registered and is auto-eligible (FNOL warnings never block)', () => {
    expect(registrable(clean)).toEqual({ canRegister: true, autoEligible: true, blockers: [] });
  });
  it('every owner blocker', () => {
    const r = registrable({ ...clean, filesInProgress: 2, conflictsOpen: 1, missingKey: ['client.name'], fnolErrors: ['Accident location is mandatory'], mainMatchesClaim: { reference: 'CCG-2026-00001' } });
    expect(r.canRegister).toBe(false);
    expect(r.autoEligible).toBe(false);
    expect(r.blockers.filter((b) => b.for === 'owner').map((b) => b.code)).toEqual(['FILES_IN_PROGRESS', 'OPEN_CONFLICTS', 'MISSING_REQUIRED', 'FNOL_INCOMPLETE', 'MATCHES_EXISTING_CLAIM']);
    expect(codes({ ...clean, mainMatchesClaim: { reference: 'CCG-2026-00001' }, confirmedNew: true })).toEqual([]);
    expect(codes({ ...clean, circumstancesUnconfirmed: true })).toEqual(['MISSING_REQUIRED']);
    expect(codes({ ...clean, witnessesWithoutRelationship: 1 })).toEqual(['MISSING_REQUIRED']);
  });
  it('every auto blocker (the owner can still register)', () => {
    const r = registrable({ ...clean, settingOn: false, reasoningDone: false, lowKey: ['vehicle.registration'], contactMissing: true, signalsOpen: 1, unsureFiles: 1, otherGroups: 1, injection: true, duplicateOpenClaim: true, policy: { outcome: 'ask', reasons: ['shadow mode'] } });
    expect(r.canRegister).toBe(true);
    expect(r.autoEligible).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(['SETTING_OFF', 'AI_REASONING_NOT_DONE', 'LOW_CONFIDENCE', 'SIGNALS_PRESENT', 'UNSURE_FILES', 'OTHER_GROUPS_PRESENT', 'INSTRUCTIONS_IN_DOCUMENT', 'DUPLICATE_OPEN_CLAIM', 'POLICY_ASKS']);
    expect(r.blockers.every((b) => b.for === 'auto')).toBe(true);
    for (const b of r.blockers) expect(BANNED_INTAKE_WORDS.test(b.text)).toBe(false);
  });
});

describe('case summary', () => {
  const values = {
    'client.name': 'Jane Doe',
    'vehicle.colour': 'Blue',
    'vehicle.make': 'Vauxhall',
    'vehicle.model': 'Corsa',
    'vehicle.registration': 'KX21 ABC',
    'tp.registration': 'LM19 XYZ',
    'accident.location': 'London Road, Reading',
    'accident.occurredAt': '2026-10-07T16:45:00.000Z',
    'tp.insurerName': 'Example Mutual Insurance',
    'tp.insurerRef': 'TPI/778812',
    'accident.driveable': 'no',
    'hire.needed': 'yes',
    'accident.policeReference': 'INC-2026-0042',
  };
  it('the template says it in plain sentences', () => {
    const s = caseSummaryTemplate({ values, missingDocs: 2 });
    expect(s).toBe(
      "Jane Doe's blue Vauxhall Corsa (KX21 ABC) was hit by LM19 XYZ at London Road, Reading on 7 October 2026 at 17:45. The other driver is insured by Example Mutual Insurance; their reference is TPI/778812. The car is not driveable and Jane needs a replacement car. Police attended (ref INC-2026-0042). 2 documents are still needed.",
    );
  });
  it('verifySummary accepts facts from the draft and rejects an invented plate, date, figure or reference', () => {
    expect(verifySummary('Jane Doe’s car KX21 ABC was hit by LM19 XYZ on 7 October 2026; ref TPI/778812.', values)).toBe(true);
    expect(verifySummary('Jane Doe’s car KX21 ABD was hit.', values)).toBe(false);
    expect(verifySummary('The accident was on 9 October 2026.', values)).toBe(false);
    expect(verifySummary('The repair costs £2,400.', values)).toBe(false);
    expect(verifySummary('Their reference is ZZ/999.', values)).toBe(false);
    expect(verifySummary('This looks staged.', values)).toBe(false);
    expect(verifySummary('', values)).toBe(false);
  });
});
