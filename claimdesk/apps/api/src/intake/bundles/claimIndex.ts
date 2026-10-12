// owned by intake-server
/**
 * The claim key index and the stop list for mixed-upload sorting (docs/SMART-INTAKE.md §4.4, §4.5, §6). Every claim's
 * identifiers (reference, registrations, VIN, the at-fault insurer's reference, the client's licence, name + date of
 * birth, phone, email, postcode, accident day, police reference) are normalised exactly like the files' keys so a file
 * can be matched to an existing claim. The stop list removes identifiers shared by many cases: the company's own
 * office postcode, the mail account address and domain, fleet registrations and fleet policy numbers.
 */
import { normaliseKeyValue, personKey, type ClaimKeyIndex, type KeyKind, type StopList } from '@ccguk/domain';
import type { AppContext } from '../../context.js';

export function buildClaimIndex(ctx: AppContext, opts: { excludeClaimIds?: string[] } = {}): ClaimKeyIndex {
  const skip = new Set(opts.excludeClaimIds ?? []);
  const claims = ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => !skip.has(c.id));
  const out: ClaimKeyIndex['claims'] = [];
  for (const c of claims) {
    const keys: Array<{ kind: KeyKind; value: string }> = [];
    const add = (kind: KeyKind, raw: string | undefined | null) => {
      if (!raw) return;
      const v = normaliseKeyValue(kind, raw);
      if (v && !keys.some((k) => k.kind === kind && k.value === v)) keys.push({ kind, value: v });
    };
    add('ccg_ref', c.reference);
    const claimant = ctx.repos.getParty(ctx.db, c.claimantId);
    const vehicle = c.clientVehicleId ? ctx.repos.getVehicle(ctx.db, c.clientVehicleId) : undefined;
    const tpVehicle = c.thirdPartyVehicleId ? ctx.repos.getVehicle(ctx.db, c.thirdPartyVehicleId) : undefined;
    add('vrm', vehicle?.registration);
    add('vrm', tpVehicle?.registration);
    add('vin', vehicle?.vin);
    add('insurer_ref', c.atFaultInsurerRef);
    add('policy', c.clientPolicyNumber);
    add('licence', claimant?.drivingLicenceNumber);
    if (claimant?.name) {
      add('name', claimant.name);
      const pk = personKey(claimant.name);
      if (pk && claimant.dateOfBirth) keys.push({ kind: 'name_dob', value: `${pk}|${claimant.dateOfBirth.slice(0, 10)}` });
    }
    add('phone', claimant?.phone);
    add('email', claimant?.email);
    add('postcode', claimant?.address?.postcode);
    add('accident_date', c.accident.occurredAt);
    add('police_ref', c.accident.policeReference);
    out.push({ claimId: c.id, reference: c.reference, clientName: claimant?.name ?? null, status: c.status, keys });
  }
  return { claims: out };
}

export function buildStopList(ctx: AppContext): StopList {
  const stop: StopList = { vrms: [], policies: [], phones: [], emails: [], emailDomains: [], postcodes: [], names: [] };
  try {
    const s = ctx.settings();
    if (s.registeredOffice?.postcode) stop.postcodes.push(s.registeredOffice.postcode);
    if (s.companyName) stop.names.push(s.companyName);
  } catch {
    /* settings not readable: no company entries */
  }
  const account = ctx.repos.getDefaultMailAccount(ctx.db);
  if (account?.fromAddress) {
    stop.emails.push(account.fromAddress);
    const domain = account.fromAddress.split('@')[1];
    if (domain) stop.emailDomains.push(domain);
  }
  for (const u of ctx.repos.listFleetUnits(ctx.db)) {
    const v = ctx.repos.getVehicle(ctx.db, u.vehicleId);
    if (v?.registration) stop.vrms.push(v.registration);
  }
  for (const p of ctx.repos.listPolicies(ctx.db)) if (p.policyNumber) stop.policies.push(p.policyNumber);
  return stop;
}
