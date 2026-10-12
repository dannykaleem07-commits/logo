/**
 * Can the bundle be registered — by the owner, and automatically? (docs/SMART-INTAKE.md §4.16). The owner can register
 * once nothing is still being read, no conflict is open, every key detail is there and valid, the FNOL checks pass and
 * (when the main group looks like an existing claim) the owner confirmed it is new. Automatic registration needs the
 * setting on, the AI check done, every key detail confident, no signal of any severity unacknowledged, no unsure files
 * or other cases, no instructions in a document, no open duplicate claim and the autonomy policy's `auto`.
 * FNOL warnings (account taken cold, recording disclosure) are never blockers: they become the call to make.
 */
import { BUNDLE_FIELD_META, type Blocker, type BundleFieldKey } from './types.js';

export interface RegistrableInput {
  filesInProgress: number;
  conflictsOpen: number;
  missingKey: BundleFieldKey[];
  lowKey: BundleFieldKey[];
  contactMissing: boolean;
  fnolErrors: string[];
  fnolWarnings: string[];
  mainMatchesClaim: { reference: string } | null;
  confirmedNew: boolean;
  signalsWarn: number;
  signalsOpen: number;
  unsureFiles: number;
  otherGroups: number;
  reasoningDone: boolean;
  injection: boolean;
  duplicateOpenClaim: boolean;
  settingOn: boolean;
  minConfidence: number;
  policy: { outcome: 'auto' | 'auto_held' | 'ask' | 'deny'; reasons: string[] };
  /** The account of what happened is not the client's own and the owner has not confirmed it. */
  circumstancesUnconfirmed?: boolean;
  /** Witnesses listed with no relationship to the client. */
  witnessesWithoutRelationship?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const labels = (keys: BundleFieldKey[]) => keys.map((k) => BUNDLE_FIELD_META[k].label.toLowerCase()).join(', ');

export function registrable(i: RegistrableInput): { canRegister: boolean; autoEligible: boolean; blockers: Blocker[] } {
  const blockers: Blocker[] = [];
  const owner = (code: string, text: string) => blockers.push({ code, text, for: 'owner' });
  const auto = (code: string, text: string) => blockers.push({ code, text, for: 'auto' });

  if (i.filesInProgress > 0) owner('FILES_IN_PROGRESS', `${plural(i.filesInProgress, 'file')} still being read`);
  if (i.conflictsOpen > 0) owner('OPEN_CONFLICTS', `${plural(i.conflictsOpen, 'detail')} disagree between documents — choose the right value`);
  const missingParts: string[] = [];
  if (i.missingKey.length) missingParts.push(`missing: ${labels(i.missingKey)}`);
  if (i.circumstancesUnconfirmed) missingParts.push('the account of what happened is not the client’s own — confirm or write it');
  if (i.witnessesWithoutRelationship) missingParts.push(`${plural(i.witnessesWithoutRelationship, 'witness', 'witnesses')} with no relationship to the client recorded`);
  if (missingParts.length) owner('MISSING_REQUIRED', `Still needed: ${missingParts.join('; ')}`);
  if (i.fnolErrors.length) owner('FNOL_INCOMPLETE', `The claim form checks say: ${i.fnolErrors.join(' | ')}`);
  if (i.mainMatchesClaim && !i.confirmedNew) owner('MATCHES_EXISTING_CLAIM', `This looks like ${i.mainMatchesClaim.reference} — attach to it, or confirm it is a new claim`);
  const canRegister = blockers.length === 0;

  if (!i.settingOn) auto('SETTING_OFF', 'Automatic registration is off (Settings > Intake)');
  if (!i.reasoningDone) auto('AI_REASONING_NOT_DONE', 'The AI has not checked the bundle yet');
  if (i.lowKey.length || i.contactMissing) auto('LOW_CONFIDENCE', `Not confident enough (below ${Math.round(i.minConfidence * 100)}%): ${[labels(i.lowKey), i.contactMissing ? 'client phone or email' : ''].filter(Boolean).join(', ')}`);
  if (i.signalsOpen > 0) auto('SIGNALS_PRESENT', `${plural(i.signalsOpen, 'thing')} worth a look first`);
  if (i.unsureFiles > 0) auto('UNSURE_FILES', `${plural(i.unsureFiles, 'file')} not yet placed in a case`);
  if (i.otherGroups > 0) auto('OTHER_GROUPS_PRESENT', `The upload holds ${plural(i.otherGroups, 'other case or claim', 'other cases or claims')}`);
  if (i.injection) auto('INSTRUCTIONS_IN_DOCUMENT', 'A document contains text aimed at an AI');
  if (i.duplicateOpenClaim) auto('DUPLICATE_OPEN_CLAIM', 'The client or car is on another open claim');
  if (i.policy.outcome !== 'auto') auto('POLICY_ASKS', `The autonomy policy asks you first${i.policy.reasons.length ? `: ${i.policy.reasons.join('; ')}` : ''}`);
  const autoEligible = canRegister && blockers.length === 0;
  return { canRegister, autoEligible, blockers };
}
