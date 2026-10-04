/**
 * Intake script and script guard (BLUEPRINT §3.1; lesson m "client told to ignore courtesy-car offer").
 *
 * The script opens with the call-recording disclosure, asks open questions and takes the account cold
 * (perimeter.md Part 1: never build the client's account). It contains the mandatory guard question
 * "Has anyone offered you a vehicle? What exactly, by whom, when?" whose answer goes to the intervention
 * register, and it never contains advice to ignore or decline an insurer's offer. `assertScriptGuard`
 * is run over every script version and over handler notes before they are saved.
 */

export const recordingDisclosureText =
  'Before we start: this call is recorded. We keep the recording as part of your claim file and may rely on it as evidence. ' +
  'I am calling from Courtesy Cars Group UK Ltd. We provide accident management and credit hire services; we are not a firm of solicitors and we are not regulated by the Solicitors Regulation Authority. ' +
  'Are you happy to continue on that basis?';

export const GUARD_QUESTION = 'Has anyone offered you a vehicle? What exactly, by whom, when?';

export interface ScriptStep {
  step: number;
  /** What the handler says, verbatim. */
  say: string;
  /** FnolInput field(s) the answer is captured into. */
  capture: string[];
  /** Handler-facing rule for this step (never read to the client). */
  guard?: string;
}

export function intakeScript(): ScriptStep[] {
  return [
    {
      step: 1,
      say: recordingDisclosureText,
      capture: ['recordingDisclosureGiven'],
      guard: 'Must be read first, every call. If the client does not consent, stop recording and note it; do not proceed with the recorded line.',
    },
    {
      step: 2,
      say: 'Can I take your full name, date of birth, address, the best phone number and email for you, and the registration of your vehicle?',
      capture: ['claimant.name', 'claimant.dateOfBirth', 'claimant.address', 'claimant.phone', 'claimant.email', 'clientVehicle.registration'],
      guard: 'Identity and signed authority before any third party is contacted (perimeter.md Part 2).',
    },
    {
      step: 3,
      say: 'Tell me what happened, in your own words, from the beginning. Take your time.',
      capture: ['accident.circumstances'],
      guard: 'Open question only. Do not suggest, prompt or fill gaps. Record the account verbatim and attribute it to the client. Follow-ups are "what happened next?" and "what did you see?" — nothing that supplies a fact (perimeter.md Part 1).',
    },
    {
      step: 4,
      say: 'When did it happen — the date and the time as best you can — and where exactly? A road name, a junction or a postcode helps.',
      capture: ['accident.occurredAt', 'accident.location', 'accident.postcode'],
    },
    {
      step: 5,
      say: 'What can you tell me about the other vehicle: its registration, make and colour, the driver’s name if you have it, and whether they gave you insurance details?',
      capture: ['thirdParty.registration', 'thirdParty.name', 'thirdParty.insurer'],
      guard: 'Registration is mandatory. If the other driver left without stopping, record "unknown" with the circumstances: that is an MIB Untraced Drivers route, not a reason to guess a plate.',
    },
    {
      step: 6,
      say: 'Was anyone else there who saw what happened? For each person: their name, how to contact them, and how you know them — if at all.',
      capture: ['witnesses'],
      guard: 'The relationship question is mandatory for every witness (lesson g: connected witnesses). An empty list is a valid answer; an unasked question is not.',
    },
    {
      step: 7,
      say: 'Was anyone hurt, in your vehicle or the other one — even something that seemed minor at the time?',
      capture: ['accident.injuries'],
      guard: 'If yes: raise the personal-injury referral task (no referral fee, LASPO 2012 ss.56–60) and say only that a specialist solicitor will be in touch. Give no view on the injury claim (FCA claims-management perimeter).',
    },
    {
      step: 8,
      say: 'Is your vehicle driveable and safe to use now? Where is it at the moment?',
      capture: ['accident.roadworthyAfter', 'accident.driveable', 'vehicleLocation'],
      guard: 'Roadworthiness decides the hire period argument; record the client’s answer and the engineer confirms it.',
    },
    {
      step: 9,
      say: 'Did the police attend or have you reported it? Do you have a dashcam, and did you notice any cameras nearby — shops, buses, traffic cameras?',
      capture: ['accident.policeAttended', 'accident.policeReference', 'accident.dashcamAvailable', 'accident.cctvAvailable'],
      guard: 'Any yes on cameras starts the 7-day preservation request (BLUEPRINT §7.2).',
    },
    {
      step: 10,
      say: 'Who are you insured with, and do you have your policy number to hand?',
      capture: ['clientInsurer', 'clientPolicyNumber'],
    },
    {
      step: 11,
      say: GUARD_QUESTION,
      capture: ['offerDisclosed', 'offerDetails.what', 'offerDetails.byWhom', 'offerDetails.when'],
      guard:
        'Mandatory, every call, including calls after sign-up. Record the answer in the intervention register with what was offered, by whom and when. The client makes the decision on any offer with the facts in front of them; CCGUK replies to the offeror in writing within 1 working day. Give no instruction to the client about accepting or rejecting an offer (lesson m).',
    },
    {
      step: 12,
      say: 'So we can show why you need a replacement vehicle: what do you do for work, what journeys do you make in a normal week, who depends on you for lifts, and is there any other vehicle in your household you could use?',
      capture: ['need.occupation', 'need.journeys', 'need.dependants', 'need.otherVehicles'],
      guard: 'Need is proved by a week of actual journeys, not by "he needed a car" (playbooks.md §3).',
    },
    {
      step: 13,
      say: 'To protect the hire charges we will ask you for three months of bank statements for every account, a short statement of your income and outgoings, and proof of income. Can you get those to us before the hire starts?',
      capture: ['means.bankStatementsPromisedBy', 'means.incomeEvidence'],
      guard: 'Impecuniosity is collected at sign-up, not after a defence arrives (Diriye v Bojaj; BLUEPRINT §2 finding 5).',
    },
    {
      step: 14,
      say: 'Thank you. Here is what happens next: we will send you a summary of what you have told me to check and sign, the hire agreement with its cancellation information for you to read before anything starts, and an engineer will be in touch about inspecting your vehicle. If anyone contacts you about this accident, let us know the same day.',
      capture: ['nextStepsConfirmed'],
      guard: 'Confirm every material conversation in writing the same day (voice.md).',
    },
  ];
}

/** Instructions to the client about an insurer's offer that must never appear in a script, note or letter. */
export const BANNED_SCRIPT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'ignore_offer', re: /\bignore\b[^.]{0,40}\b(offer|courtesy car|replacement (vehicle|car)|hire car|vehicle they|car they)\b/i },
  { id: 'ignore_insurer', re: /\bignore\b[^.]{0,30}\b(insurer|insurance company|their calls?|the calls?|them)\b/i },
  { id: 'do_not_accept', re: /\b(do not|don['’]?t|never|mustn['’]?t|shouldn['’]?t)\s+(accept|take|take up|agree to|respond to|reply to|engage with|speak to|talk to|call back|ring back)\b[^.]{0,40}\b(offer|courtesy|replacement|insurer|insurance|them|their)\b/i },
  { id: 'decline_offer', re: /\b(decline|refuse|reject|turn down|say no to)\b\s+(the|their|any|that|this|it|any)\b[^.]{0,30}\b(offer|courtesy car|replacement (vehicle|car)|vehicle|car)\b/i },
  { id: 'instruct_decline', re: /\b(you (should|must|need to|have to|ought to)|just|simply)\s+(decline|refuse|reject|ignore|turn down)\b/i },
  { id: 'tell_them_no', re: /\btell them (you (don['’]?t|do not) (want|need)|no|to go away)\b/i },
  { id: 'hang_up', re: /\bhang up\b/i },
];

export interface ScriptGuardViolation {
  pattern: string;
  excerpt: string;
  index: number;
}

export interface ScriptGuardResult {
  ok: boolean;
  violations: ScriptGuardViolation[];
  /** True when the text contains the mandatory intervention question (or its three parts). */
  guardQuestionPresent: boolean;
}

const GUARD_PRESENT = /has anyone offered you a (vehicle|car)[^?]*\?/i;
const GUARD_PARTS = [/\bwhat exactly\b/i, /\bby whom\b/i, /\bwhen\b/i];

export function assertScriptGuard(scriptText: string): ScriptGuardResult {
  const violations: ScriptGuardViolation[] = [];
  for (const { id, re } of BANNED_SCRIPT_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = global.exec(scriptText)) !== null) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(scriptText.length, m.index + m[0].length + 30);
      violations.push({ pattern: id, excerpt: scriptText.slice(start, end).replace(/\s+/g, ' ').trim(), index: m.index });
      if (m[0].length === 0) global.lastIndex += 1;
    }
  }
  const guardQuestionPresent = GUARD_PRESENT.test(scriptText) && GUARD_PARTS.every((p) => p.test(scriptText));
  return { ok: violations.length === 0, violations, guardQuestionPresent };
}

/** The whole script as one text, for the guard check and for printing. */
export function scriptText(steps: ScriptStep[] = intakeScript()): string {
  return steps.map((s) => `${s.step}. ${s.say}${s.guard ? `\n   [handler: ${s.guard}]` : ''}`).join('\n');
}
