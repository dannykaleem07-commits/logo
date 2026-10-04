import { describe, it, expect } from 'vitest';
import { validateFnol, routeInjury, intakeScript, assertScriptGuard, scriptText, recordingDisclosureText, GUARD_QUESTION, isValidRegistrationLocal, INJURY_REFERRAL_TITLE, type FnolInput } from './index.js';
import { isValidUkRegistration } from '../vehicle/index.js';

function goodFnol(): FnolInput {
  return {
    recordingDisclosureGiven: true,
    claimant: { name: 'Amir Hussain', phone: '07700 900123' },
    clientVehicle: { registration: 'AB12 CDE' },
    accident: {
      occurredAt: '2026-09-21T09:00:00+01:00',
      location: 'A13 Newham Way, London',
      postcode: 'E6 5LF',
      circumstances: 'I was stationary in lane 1 in slow traffic. The other car moved across from lane 2 without indicating and hit the back corner of my car.',
      takenCold: true,
      injuries: false,
      roadworthyAfter: false,
      driveable: false,
      policeAttended: false,
      cctvAvailable: false,
      dashcamAvailable: false,
    },
    thirdParty: { registration: 'XY19 ZZZ', name: 'Unknown', insurer: 'esure' },
    witnesses: [],
    clientInsurer: 'Admiral',
    clientPolicyNumber: 'ADM-123456',
    offerDisclosed: false,
  };
}

describe('validateFnol', () => {
  it('a complete FNOL passes with no errors or warnings', () => {
    const r = validateFnol(goodFnol());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('every mandatory field is reported when missing', () => {
    const r = validateFnol({ accident: {}, thirdParty: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual([
      'accident.occurredAt',
      'accident.location',
      'accident.circumstances',
      'thirdParty.registration',
      'witnesses',
      'accident.injuries',
      'accident.roadworthyAfter',
      'clientInsurer',
      'clientPolicyNumber',
      'offerDisclosed',
    ]);
    expect(r.warnings.map((w) => w.field)).toContain('recordingDisclosureGiven');
    expect(r.warnings.map((w) => w.field)).toContain('accident.takenCold');
  });

  it('circumstances must be at least 40 characters and taken cold; the disclosure must be read', () => {
    const f = goodFnol();
    f.accident.circumstances = 'He hit me.';
    f.accident.takenCold = false;
    f.recordingDisclosureGiven = false;
    const r = validateFnol(f);
    expect(r.errors.find((e) => e.field === 'accident.circumstances')!.message).toContain('at least 40 characters');
    expect(r.errors.find((e) => e.field === 'accident.takenCold')!.message).toContain('taken cold');
    expect(r.errors.find((e) => e.field === 'recordingDisclosureGiven')).toBeDefined();
    f.accident.occurredAt = '21/09/2026 9am';
    expect(validateFnol(f).errors.find((e) => e.field === 'accident.occurredAt')!.message).toContain('ISO 8601');
  });

  it('third-party registration must be a valid UK format, or marked unknown (MIB untraced route)', () => {
    const f = goodFnol();
    f.thirdParty.registration = 'NOT-A-PLATE-1';
    expect(validateFnol(f).errors.find((e) => e.field === 'thirdParty.registration')!.message).toContain('not a valid UK registration');
    f.thirdParty = { registrationUnknown: true };
    const r = validateFnol(f);
    expect(r.ok).toBe(true);
    expect(r.warnings.find((w) => w.field === 'thirdParty.registration')!.message).toContain('MIB Untraced Drivers Agreement 2017');
    for (const reg of ['AB12 CDE', 'A123 BCD', 'ABC 123D', 'AIZ 1234', 'ABC 1234', '1 A']) expect(isValidRegistrationLocal(reg), reg).toBe(true);
    for (const reg of ['', 'IB12 CDE', 'AB12 CDEF', '12345678']) expect(isValidRegistrationLocal(reg), reg).toBe(false);
  });

  it('witnesses: an empty list is an answer; each witness needs a name and a relationship; a connected witness is a warning', () => {
    const f = goodFnol();
    f.witnesses = [{ name: 'Sara Hussain', relationship: 'sister' }, { name: '', relationship: '' }];
    const r = validateFnol(f);
    expect(r.errors.map((e) => e.field)).toEqual(['witnesses[1].name', 'witnesses[1].relationship']);
    expect(r.warnings.find((w) => w.field === 'witnesses[0].relationship')!.message).toContain('connected to the client');
    f.witnesses = [{ name: 'Passer-by', relationship: 'none' }];
    expect(validateFnol(f).warnings).toEqual([]);
  });

  it('the intervention guard question: must be answered; a disclosed offer needs what / by whom / when and triggers the register warning', () => {
    const f = goodFnol();
    f.offerDisclosed = true;
    const r = validateFnol(f);
    expect(r.errors.map((e) => e.field)).toEqual(['offerDetails.what', 'offerDetails.byWhom', 'offerDetails.when']);
    f.offerDetails = { what: 'small hatchback at £20.37/day', byWhom: 'esure', when: '2026-09-23 11:00' };
    const ok = validateFnol(f);
    expect(ok.ok).toBe(true);
    expect(ok.warnings.find((w) => w.field === 'offerDisclosed')!.message).toContain('intervention register');
    expect(ok.warnings.find((w) => w.field === 'offerDisclosed')!.message).toContain('1 working day');
  });

  it('injuries yes is valid but warns to refer out; police attended without a reference warns; unanswered camera questions warn', () => {
    const f = goodFnol();
    f.accident.injuries = true;
    f.accident.policeAttended = true;
    delete f.accident.cctvAvailable;
    delete f.accident.dashcamAvailable;
    const r = validateFnol(f);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.field)).toEqual(['accident.injuries', 'accident.policeReference', 'accident.cctvAvailable']);
    expect(r.warnings[0]!.message).toContain('LASPO 2012 ss.56–60');
  });
});

describe('routeInjury', () => {
  it('no injury: no referral, damage-only continues', () => {
    expect(routeInjury(goodFnol())).toEqual({ refer: false, continueDamageOnly: true });
    expect(routeInjury({ injuries: false })).toEqual({ refer: false, continueDamageOnly: true });
  });

  it('injury: referral task with the exact title, no fee, LASPO basis; damage-only continues', () => {
    const f = goodFnol();
    f.accident.injuries = true;
    const r = routeInjury(f);
    expect(r.refer).toBe(true);
    expect(r.continueDamageOnly).toBe(true);
    expect(r.task!.title).toBe('Refer personal injury element to PI solicitor (no referral fee — LASPO 2012 ss.56–60)');
    expect(r.task!.title).toBe(INJURY_REFERRAL_TITLE);
    expect(r.task!.feeTaken).toBe(false);
    expect(r.task!.basis.join(' ')).toContain('Limitation Act 1980 s.11');
    expect(routeInjury({ injuries: true }).task!.feeTaken).toBe(false);
  });
});

describe('intakeScript / assertScriptGuard', () => {
  it('opens with the recording disclosure, asks the account as an open question, and contains the guard question', () => {
    const steps = intakeScript();
    expect(steps[0]!.say).toBe(recordingDisclosureText);
    expect(steps[0]!.capture).toEqual(['recordingDisclosureGiven']);
    expect(recordingDisclosureText).toContain('this call is recorded');
    expect(recordingDisclosureText).toContain('not a firm of solicitors');
    expect(steps[2]!.say).toContain('in your own words');
    expect(steps[2]!.guard).toContain('Do not suggest');
    const guard = steps.find((s) => s.say === GUARD_QUESTION)!;
    expect(guard.say).toBe('Has anyone offered you a vehicle? What exactly, by whom, when?');
    expect(guard.capture).toEqual(['offerDisclosed', 'offerDetails.what', 'offerDetails.byWhom', 'offerDetails.when']);
    expect(guard.guard).toContain('intervention register');
    expect(steps.map((s) => s.step)).toEqual(steps.map((_, i) => i + 1));
    // every mandatory FNOL field is captured somewhere in the script
    const captured = steps.flatMap((s) => s.capture).join(' ');
    for (const field of ['accident.occurredAt', 'accident.location', 'accident.circumstances', 'thirdParty.registration', 'witnesses', 'accident.injuries', 'accident.roadworthyAfter', 'clientInsurer', 'clientPolicyNumber', 'offerDisclosed']) {
      expect(captured, field).toContain(field);
    }
  });

  it('the script itself passes the guard, including its handler notes', () => {
    const r = assertScriptGuard(scriptText());
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.guardQuestionPresent).toBe(true);
  });

  it('catches every banned instruction about an insurer offer (lesson m) and reports the excerpt', () => {
    const banned = [
      'If the insurer calls, just ignore the offer and we will sort the car out.',
      'Ignore their courtesy car offer; ours is better.',
      "Don't accept the replacement vehicle from their insurer.",
      'Do not speak to the insurer about a car.',
      'You should decline the offer and tell them you already have a vehicle.',
      'Refuse any vehicle they offer you.',
      'Tell them you don’t want it.',
      'Just hang up if they ring about a hire car.',
      'Simply refuse anything they send.',
    ];
    for (const text of banned) {
      const r = assertScriptGuard(text);
      expect(r.ok, text).toBe(false);
      expect(r.violations[0]!.excerpt.length).toBeGreaterThan(0);
    }
    const r = assertScriptGuard('Ignore the offer. Decline their offer.');
    expect(r.violations.map((v) => v.pattern)).toEqual(['ignore_offer', 'decline_offer']);
    expect(r.violations[1]!.index).toBe(18);
  });

  it('legitimate wording passes: recording the client decision, replying to the offeror, telling the client to report offers', () => {
    const fine = [
      'The client declined the offer because the vehicle offered was a small hatchback and she needs an estate for work.',
      'We will reply to the insurer in writing within one working day setting out the reasons.',
      'If anyone offers you a vehicle, tell us the same day: what exactly, by whom and when.',
      'Your offer of 22 September 2026 was declined for the reasons stated in the enclosed questionnaire.',
    ];
    for (const text of fine) expect(assertScriptGuard(text).ok, text).toBe(true);
    expect(assertScriptGuard('Has anyone offered you a car? What exactly, by whom, when?').guardQuestionPresent).toBe(true);
    expect(assertScriptGuard('Has anyone offered you a car?').guardQuestionPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial verification — lesson m evasions, legitimate notes, plate-regex parity.
// ---------------------------------------------------------------------------------------------
describe('adversarial: intake', () => {
  it('catches softer instructions to ignore or sit on an insurer’s offer (lesson m)', () => {
    const banned = [
      'There is no need to respond to their offer.',
      "You don't need to speak to the insurer about a car.",
      'Tell them you already have a car.',
      "Don't worry about their offer, we will deal with it.",
      'Leave their offer unanswered until we call you.',
      'You can ignore their letter about the courtesy car.',
      'Put the phone down if they offer you a car.',
      'Tell them you’re sorted.',
    ];
    for (const text of banned) expect(assertScriptGuard(text).ok, text).toBe(false);
  });

  it('legitimate notes about offers still pass (recording a decision is not instructing one)', () => {
    const fine = [
      'The client chose not to accept the offer; reasons recorded in the mitigation questionnaire.',
      'Tell us what exactly was offered, by whom and when.',
      'The insurer’s offer was unsuitable because of the £500 excess; the client declined it.',
      'We replied to the offer in writing within one working day.',
      'Do not proceed with the recorded line if the client does not consent.',
      'Leave the paperwork with us and we will send the summary today.',
    ];
    for (const text of fine) expect(assertScriptGuard(text).ok, text).toBe(true);
    // the script itself, including every handler note, still passes after the pattern changes
    expect(assertScriptGuard(scriptText()).ok).toBe(true);
  });

  it('the local plate regex agrees with the vehicle module, including Q-prefix plates', () => {
    expect(isValidRegistrationLocal('Q123 ABC')).toBe(true);
    for (const reg of ['Q123 ABC', 'AB12 CDE', 'A123 BCD', 'ABC 123D', 'AIZ 1234', 'ABC 1234', '1 A', 'IB12 CDE', 'AB12 CDEF', '12345678', 'QQ12 ABC', 'ZA12 ABC', 'AB12 QQQ', 'LC21GLF']) {
      expect(isValidRegistrationLocal(reg), reg).toBe(isValidUkRegistration(reg));
    }
  });

  it('an offer disclosed as "yes" with details and a witness marked "none" is a clean FNOL — the guard never blocks the truthful answer', () => {
    const f = goodFnol();
    f.offerDisclosed = true;
    f.offerDetails = { what: 'small hatchback, £20.37/day', byWhom: 'esure', when: '2026-09-23 11:00' };
    f.witnesses = [{ name: 'Passer-by', relationship: 'none' }];
    const r = validateFnol(f);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.field)).toEqual(['offerDisclosed']);
  });
});
