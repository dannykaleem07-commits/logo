// owned by intake-server
/**
 * Inputs of the owner-only risk signals (docs/SMART-INTAKE.md §4.11, §6, improvement 9), built from the bundle's main
 * group and the existing clash / identity / linkage services: the cross-file registration check (other claims, fleet
 * units), VINs on other vehicles, parties on other claims sharing the client's phone, email, address or bank details
 * (insurers and companies excluded), the same client by licence or name + date of birth, and photos already filed on
 * another claim (same bytes, or a perceptual hash within the near-duplicate distance).
 *
 * Signals are for the owner's eyes only: they are never given to an agent, written to a document, the chronology or an
 * email, and never decline anything.
 */
import { crossFileRegistrationCheck, daysBetween, hamming, normaliseAddressKey, normaliseVin, personMatch, type IntakeSettings, type SignalsInput } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { parseUkAddress } from '../validators.js';
import { platesOf, sceneOf, type FileContext } from './candidates.js';

const CLOSED = new Set(['closed', 'settled', 'declined']);

interface ClaimLite {
  id: string;
  reference: string;
  status: string;
  occurredAt: string;
}

function claimsForParty(ctx: AppContext, partyId: string): ClaimLite[] {
  return ctx.handle.sqlite
    .prepare(
      `SELECT id, reference, status, json_extract(accident, '$.occurredAt') AS occurredAt FROM claims
        WHERE claimant_id = ? OR driver_id = ? OR EXISTS (SELECT 1 FROM json_each(claims.third_party_ids) j WHERE j.value = ?)`,
    )
    .all(partyId, partyId, partyId) as ClaimLite[];
}

export interface SignalsContext {
  main: FileContext[];
  values: Record<string, string | null>;
  acks: SignalsInput['acks'];
  settings: IntakeSettings;
  bankKey: string | null;
  bundleInjection: boolean;
  /** The claim this bundle registered or attached to (never a signal about itself). */
  excludeClaimId?: string | null;
}

/** Photo pHashes of files already filed on claims (bundle files filed by intake, and claim-linked intake items). */
function claimPhotoHashes(ctx: AppContext): Array<{ claimId: string; phash: string; evidenceId: string | null }> {
  const filed = ctx.handle.sqlite.prepare(`SELECT filed_claim_id AS claimId, phash, filed_evidence_id AS evidenceId FROM intake_bundle_files WHERE filed_claim_id IS NOT NULL AND phash IS NOT NULL`).all() as Array<{ claimId: string; phash: string; evidenceId: string | null }>;
  const items = ctx.handle.sqlite.prepare(`SELECT claim_id AS claimId, json_extract(normalised, '$.phash') AS phash, evidence_id AS evidenceId FROM intake_items WHERE claim_id IS NOT NULL AND json_extract(normalised, '$.phash') IS NOT NULL`).all() as Array<{ claimId: string; phash: string; evidenceId: string | null }>;
  return [...filed, ...items];
}

export function buildSignalsInput(ctx: AppContext, s: SignalsContext): SignalsInput {
  const v = s.values;
  const accidentAt = v['accident.occurredAt'] ?? null;
  const accidentDay = accidentAt ? accidentAt.slice(0, 10) : null;
  const claims = ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => c.id !== s.excludeClaimId);
  const refOf = new Map(claims.map((c) => [c.id, c]));

  // ----- photos
  const hashes = claimPhotoHashes(ctx);
  const photos: SignalsInput['photos'] = s.main
    .filter((fc) => fc.isPhoto)
    .map((fc) => {
      const on = new Map<string, { claimId: string; reference: string; how: 'same_file' | 'near_same_photo' }>();
      for (const e of ctx.repos.findEvidenceBySha256(ctx.db, fc.evidence.sha256)) {
        if (e.claimId && refOf.has(e.claimId)) on.set(e.claimId, { claimId: e.claimId, reference: refOf.get(e.claimId)!.reference, how: 'same_file' });
      }
      const ph = fc.file.phash ?? fc.doc?.phash;
      if (ph) {
        for (const h of hashes) {
          if (on.has(h.claimId) || !refOf.has(h.claimId)) continue;
          if (hamming(ph, h.phash) <= s.settings.duplicates.nearPhotoMaxDistance) on.set(h.claimId, { claimId: h.claimId, reference: refOf.get(h.claimId)!.reference, how: 'near_same_photo' });
        }
      }
      const exif = fc.evidence.exif;
      return {
        fileId: fc.file.id,
        takenAt: exif?.dateTimeOriginal ?? fc.evidence.capturedAt ?? null,
        gps: exif?.gps ? { lat: exif.gps.lat, lon: exif.gps.lon } : (fc.doc?.gps ?? null),
        software: exif?.software ?? null,
        plates: platesOf(fc).map((p) => p.text),
        scene: sceneOf(fc),
        onOtherClaims: [...on.values()],
      };
    });

  // ----- documents
  const documents: SignalsInput['documents'] = s.main
    .filter((fc) => !fc.isPhoto)
    .map((fc) => {
      const facts = factsOf(fc);
      return {
        fileId: fc.file.id,
        docType: fc.docType,
        documentDate: fc.documentDate,
        ...(facts.validFrom ? { validFrom: facts.validFrom } : {}),
        ...(fc.docType === 'driving_licence' && facts.licenceValidTo ? { validTo: facts.licenceValidTo } : fc.docType === 'mot_certificate' && facts.motExpiry ? { validTo: facts.motExpiry } : facts.validTo ? { validTo: facts.validTo } : {}),
        ...(facts.keeperSince ? { keeperSince: facts.keeperSince } : {}),
        pdfMeta: fc.doc?.pdfMeta ?? null,
        extensionMatches: fc.doc?.extensionMatches ?? true,
        injection: Boolean(fc.doc?.injectionFlags?.length),
        ext: fc.evidence.filename.includes('.') ? fc.evidence.filename.split('.').pop()!.toLowerCase() : null,
        kind: fc.doc?.sniffed ? `${fc.doc.sniffed.toUpperCase()} file` : null,
      };
    });

  // ----- other claims: vehicle
  const vehicleHits: SignalsInput['otherClaims']['vehicle'] = [];
  let fleetUnit = false;
  const clientVrm = v['vehicle.registration'] ?? null;
  if (clientVrm) {
    const cross = crossFileRegistrationCheck(clientVrm, claims, ctx.repos.listVehicles(ctx.db, { limit: 100_000 }), ctx.repos.listFleetUnits(ctx.db));
    fleetUnit = cross.isFleetUnit;
    for (const id of cross.duplicateClaimIds) {
      const c = refOf.get(id);
      if (c) vehicleHits.push({ claimId: c.id, reference: c.reference, how: 'registration', open: !CLOSED.has(c.status), status: c.status });
    }
  }
  const vin = v['vehicle.vin'] ? normaliseVin(v['vehicle.vin']) : null;
  if (vin && vin.length >= 11) {
    const rows = ctx.handle.sqlite.prepare(`SELECT c.id AS id FROM vehicles ve JOIN claims c ON (c.client_vehicle_id = ve.id OR c.third_party_vehicle_id = ve.id) WHERE upper(replace(coalesce(ve.vin, ''), ' ', '')) = ?`).all(vin) as Array<{ id: string }>;
    for (const r of rows) {
      const c = refOf.get(r.id);
      if (c && !vehicleHits.some((h) => h.claimId === c.id)) vehicleHits.push({ claimId: c.id, reference: c.reference, how: 'vin', open: !CLOSED.has(c.status), status: c.status });
    }
  }

  // ----- other claims: contacts (individuals only)
  const contacts: SignalsInput['otherClaims']['contacts'] = [];
  const addressKey = (() => {
    const a = v['client.address'] ? parseUkAddress(v['client.address']) : null;
    return a?.ok && a.value ? normaliseAddressKey({ line1: a.value.line1, town: a.value.town, postcode: a.value.postcode } as never) : undefined;
  })();
  const seen = new Set<string>();
  const candidates = ctx.repos.findConnections(ctx.db, {
    ...(v['client.phone'] ? { phone: v['client.phone'] } : {}),
    ...(v['client.email'] ? { email: v['client.email'] } : {}),
    ...(addressKey ? { postcode: v['client.address']!.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i)?.[0] } : {}),
  } as never);
  for (const c of candidates) {
    if (c.party.kind !== 'individual' || c.party.roles.some((r) => r === 'insurer' || r === 'broker' || r === 'solicitor')) continue;
    const fields: Array<'phone' | 'email' | 'address' | 'bank'> = [];
    if (c.matchedOn.includes('phone')) fields.push('phone');
    if (c.matchedOn.includes('email')) fields.push('email');
    if (c.matchedOn.includes('postcode') && addressKey && normaliseAddressKey(c.party.address) === addressKey) fields.push('address');
    if (!fields.length) continue;
    for (const cl of claimsForParty(ctx, c.party.id).filter((x) => x.id !== s.excludeClaimId)) {
      for (const field of fields) {
        const k = `${cl.id}|${field}`;
        if (seen.has(k)) continue;
        seen.add(k);
        contacts.push({ claimId: cl.id, reference: cl.reference, field, open: !CLOSED.has(cl.status) });
      }
    }
  }
  if (s.bankKey) {
    const rows = ctx.handle.sqlite.prepare(`SELECT id FROM parties WHERE bank_key = ?`).all(s.bankKey) as Array<{ id: string }>;
    for (const r of rows) for (const cl of claimsForParty(ctx, r.id).filter((x) => x.id !== s.excludeClaimId)) if (!seen.has(`${cl.id}|bank`)) {
      seen.add(`${cl.id}|bank`);
      contacts.push({ claimId: cl.id, reference: cl.reference, field: 'bank', open: !CLOSED.has(cl.status) });
    }
  }

  // ----- other claims: the same client
  const claimant: SignalsInput['otherClaims']['claimant'] = [];
  const name = v['client.name'];
  if (name) {
    const me = { id: '', name, dateOfBirth: v['client.dateOfBirth'] ?? undefined, drivingLicenceNumber: v['client.drivingLicenceNumber'] ?? undefined };
    for (const c of claims) {
      const p = ctx.repos.getParty(ctx.db, c.claimantId);
      if (!p) continue;
      const how = personMatch(me, { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, drivingLicenceNumber: p.drivingLicenceNumber });
      if (how !== 'licence' && how !== 'name_dob') continue;
      claimant.push({ claimId: c.id, reference: c.reference, how, open: !CLOSED.has(c.status), daysApart: accidentAt ? daysBetween(c.accident.occurredAt, accidentAt) : null, status: c.status });
    }
  }

  // ----- the car's age
  const first = v['vehicle.firstRegistered'];
  const vehicleAgeYears = first && accidentDay ? (daysBetween(`${first.slice(0, 7)}-01`, accidentDay) ?? 0) / 365.25 : null;
  const newestUploadAt = s.main.map((fc) => fc.evidence.uploadedAt).sort().at(-1) ?? null;

  return {
    accidentAt: accidentAt && /T\d{2}:\d{2}/.test(accidentAt) ? accidentAt : accidentDay ? `${accidentDay}T12:00:00.000Z` : null,
    accidentDay,
    photos,
    documents,
    clientVrm,
    tpVrm: v['tp.registration'] ?? null,
    otherClaims: { vehicle: vehicleHits, fleetUnit, contacts, claimant },
    settings: { beforeAccidentToleranceHours: s.settings.photos.beforeAccidentToleranceHours, gpsOutlierKm: s.settings.photos.gpsOutlierKm },
    acks: s.acks,
    newestUploadAt,
    vehicleAgeYears,
    bundleInjection: s.bundleInjection,
  };
}

/** Facts read from a file (validity dates, keeper since …). */
export function factsOf(fc: FileContext): { keeperSince?: string; validFrom?: string; validTo?: string; licenceValidTo?: string; motExpiry?: string } {
  const out: Record<string, string> = {};
  for (const f of fc.fields) {
    if (f.target || !f.value) continue;
    const key = ({ 'Keeper since': 'keeperSince', 'Valid from': 'validFrom', 'Valid until': 'validTo', 'Licence valid until': 'licenceValidTo', 'MOT expiry': 'motExpiry' } as Record<string, string>)[f.name];
    if (key && /^\d{4}-\d{2}-\d{2}/.test(f.value)) out[key] = f.value.slice(0, 10);
  }
  // the rules reading may carry facts the AI reading left out
  if (fc.rules && fc.rules !== fc.best) {
    for (const f of (Array.isArray(fc.rules.fields) ? fc.rules.fields : []) as Array<{ name: string; target: string | null; value: string | null }>) {
      if (f.target || !f.value) continue;
      const key = ({ 'Keeper since': 'keeperSince', 'Valid from': 'validFrom', 'Valid until': 'validTo', 'Licence valid until': 'licenceValidTo', 'MOT expiry': 'motExpiry' } as Record<string, string>)[f.name];
      if (key && !out[key] && /^\d{4}-\d{2}-\d{2}/.test(f.value)) out[key] = f.value.slice(0, 10);
    }
  }
  return out;
}
