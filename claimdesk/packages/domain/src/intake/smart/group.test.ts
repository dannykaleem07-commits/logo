import { describe, expect, it } from 'vitest';
import { EMPTY_STOP_LIST, keysFromCandidates, personKey, type FileKeys } from './keys.js';
import { groupFiles, nextCaseKey, type ClaimKeyIndex } from './group.js';
import { cand } from './testHelpers.js';

const noIndex: ClaimKeyIndex = { claims: [] };

function fk(fileId: string, position: number, cands: ReturnType<typeof cand>[], extra: Partial<Parameters<typeof keysFromCandidates>[2]> = {}): FileKeys {
  return keysFromCandidates(fileId, cands, { shaOnClaims: [], plates: [], takenAt: null, position, label: fileId, ...extra }, EMPTY_STOP_LIST);
}

// Case A: Jane Doe, KX21 ABC, VIN …001, accident 2026-10-07
const aV5c = () => fk('a-v5c', 1, [cand('client.name', 'Jane Doe', 'a-v5c', 'v5c'), cand('vehicle.registration', 'KX21 ABC', 'a-v5c', 'v5c'), cand('vehicle.vin', 'WVWZZZ1KZAW000001', 'a-v5c', 'v5c'), cand('client.address', '12 High Street, Reading, RG1 1AA', 'a-v5c', 'v5c')]);
const aForm = () =>
  fk('a-form', 2, [
    cand('client.name', 'Jane Doe', 'a-form', 'fnol_form'),
    cand('client.dateOfBirth', '1990-03-12', 'a-form', 'fnol_form'),
    cand('vehicle.registration', 'KX21 ABC', 'a-form', 'fnol_form'),
    cand('tp.registration', 'LM19 XYZ', 'a-form', 'fnol_form'),
    cand('client.address', '12 High Street, Reading, RG1 1AA', 'a-form', 'fnol_form'),
    cand('accident.occurredAt', '2026-10-07T16:45:00.000Z', 'a-form', 'fnol_form'),
  ]);
const aLetter = () => fk('a-letter', 3, [cand('tp.insurerRef', 'TPI/778812', 'a-letter', 'insurer_letter'), cand('vehicle.registration', 'KX21 ABC', 'a-letter', 'insurer_letter'), cand('tp.registration', 'LM19 XYZ', 'a-letter', 'insurer_letter')]);
// Case B: Ali Example, YB68 KDL
const bV5c = () => fk('b-v5c', 4, [cand('client.name', 'Ali Example', 'b-v5c', 'v5c'), cand('vehicle.registration', 'YB68 KDL', 'b-v5c', 'v5c'), cand('vehicle.vin', 'SAJAA01A12B000002', 'b-v5c', 'v5c'), cand('client.address', '3 Elm Road, Leeds, LS1 4AB', 'b-v5c', 'v5c')]);
const bLetter = () => fk('b-letter', 5, [cand('client.name', 'Ali Example', 'b-letter', 'insurer_letter'), cand('vehicle.registration', 'YB68 KDL', 'b-letter', 'insurer_letter'), cand('vehicle.vin', 'SAJAA01A12B000002', 'b-letter', 'insurer_letter')]);

describe('keysFromCandidates', () => {
  it('maps readings to keys with strengths and roles', () => {
    const k = aForm().keys;
    expect(k.find((x) => x.kind === 'vrm' && x.value === 'KX21ABC')).toMatchObject({ strength: 'medium', role: 'client' });
    expect(k.find((x) => x.kind === 'vrm' && x.value === 'LM19XYZ')).toMatchObject({ role: 'third_party' });
    expect(k.find((x) => x.kind === 'name_dob')).toMatchObject({ value: 'doe|j|1990-03-12', strength: 'strong' });
    expect(k.find((x) => x.kind === 'postcode')?.value).toBe('RG11AA');
    expect(k.find((x) => x.kind === 'accident_date')?.value).toBe('2026-10-07');
  });

  it('the stop list removes company and fleet identifiers', () => {
    const k = keysFromCandidates('f', [cand('client.phone', '0118 496 0999', 'f', 'fnol_form'), cand('vehicle.registration', 'FL22 EET', 'f', 'fnol_form'), cand('client.email', 'claims@ccguk.example.test', 'f', 'fnol_form')], { shaOnClaims: [], plates: [], takenAt: null }, { ...EMPTY_STOP_LIST, phones: ['01184960999'], vrms: ['FL22EET'], emailDomains: ['ccguk.example.test'] });
    expect(k.keys).toEqual([]);
  });

  it('phones on letters with no party role are weak (letterhead)', () => {
    const k = keysFromCandidates('f', [], { shaOnClaims: [], plates: [], takenAt: null, otherKeys: [{ kind: 'phone', value: '0118 496 0000' }] }, EMPTY_STOP_LIST);
    expect(k.keys[0]).toMatchObject({ kind: 'phone', strength: 'weak' });
  });

  it('personKey tolerates middle names and titles', () => {
    expect(personKey('Mrs Jane Mary Doe')).toBe('doe|j');
    expect(personKey('J Doe')).toBe('doe|j');
  });
});

describe('groupFiles', () => {
  it('two cases mixed in one upload → main (by name hint) and case:B, with reasons', () => {
    const r = groupFiles({ files: [aV5c(), aForm(), aLetter(), bV5c(), bLetter()], index: noIndex, nameHint: 'Jane Doe – Corsa crash', pins: {}, excluded: [] });
    const main = r.groups.find((g) => g.key === 'main')!;
    const b = r.groups.find((g) => g.key === 'case:B')!;
    expect(main.fileIds).toEqual(['a-v5c', 'a-form', 'a-letter']);
    expect(b.fileIds).toEqual(['b-v5c', 'b-letter']);
    expect(b.label).toBe('New case B — Ali Example');
    expect(b.suggestedName).toBe('Ali Example — YB68 KDL');
    expect(b.defaultAction).toBe('split_off');
    expect(main.reasons.some((x) => x.code === 'name_hint')).toBe(true);
    expect(b.reasons.some((x) => x.code === 'shared_vin')).toBe(true);
  });

  it('the name hint decides which case is main', () => {
    const r = groupFiles({ files: [aV5c(), aForm(), bV5c(), bLetter()], index: noIndex, nameHint: 'Ali Example', pins: {}, excluded: [] });
    expect(r.groups.find((g) => g.key === 'main')!.fileIds).toEqual(['b-v5c', 'b-letter']);
  });

  it('an insurer letter quoting a CCG reference goes to that claim', () => {
    const letter = fk('x-letter', 6, [cand('vehicle.registration', 'DK18 WRE', 'x-letter', 'insurer_letter')], { otherKeys: [{ kind: 'ccg_ref', value: 'CCG-2026-00001' }] });
    const index: ClaimKeyIndex = { claims: [{ claimId: 'c1', reference: 'CCG-2026-00001', clientName: 'Pat Sample', status: 'fnol', keys: [{ kind: 'ccg_ref', value: 'CCG202600001' }, { kind: 'vrm', value: 'DK18WRE' }] }] };
    const r = groupFiles({ files: [aV5c(), aForm(), letter], index, nameHint: 'Jane Doe', pins: {}, excluded: [] });
    const g = r.groups.find((x) => x.key === 'claim:c1')!;
    expect(g.kind).toBe('existing_claim');
    expect(g.fileIds).toEqual(['x-letter']);
    expect(g.label).toBe('CCG-2026-00001 — Pat Sample');
    expect(g.reasons[0]!.code).toBe('matches_claim');
    expect(g.defaultAction).toBe('attach');
  });

  it('a possible match (score 5–9) stays a new case with a reason naming the claim', () => {
    const f = fk('p', 1, [cand('vehicle.registration', 'KX21 ABC', 'p', 'v5c'), cand('client.name', 'Jane Doe', 'p', 'v5c')]);
    const index: ClaimKeyIndex = { claims: [{ claimId: 'c9', reference: 'CCG-2026-00009', clientName: null, status: 'closed', keys: [{ kind: 'vrm', value: 'KX21ABC' }, { kind: 'name', value: 'doe|j' }] }] };
    const r = groupFiles({ files: [f], index, nameHint: '', pins: {}, excluded: [] });
    expect(r.groups[0]!.key).toBe('main');
    expect(r.groups[0]!.reasons.some((x) => x.code === 'possible_claim_match' && x.text.includes('CCG-2026-00009'))).toBe(true);
  });

  it('unkeyed photos: only case → join; two cases → by photo date near the accident; else unsure', () => {
    const photo = (id: string, pos: number, takenAt: string | null) => fk(id, pos, [], { isPhoto: true, takenAt });
    let r = groupFiles({ files: [aV5c(), aForm(), photo('p1', 9, null)], index: noIndex, nameHint: '', pins: {}, excluded: [] });
    expect(r.fileGroup.p1).toBe('main');
    expect(r.groups[0]!.reasons.some((x) => x.code === 'only_case_in_upload')).toBe(true);
    r = groupFiles({ files: [aV5c(), aForm(), bV5c(), photo('p2', 9, '2026-10-07T17:05:00Z'), photo('p3', 10, '2026-09-01T10:00:00Z'), photo('p4', 11, null)], index: noIndex, nameHint: 'Jane Doe', pins: {}, excluded: [] });
    expect(r.fileGroup.p2).toBe('main');
    expect(r.fileGroup.p3).toBe('unsure');
    expect(r.fileGroup.p4).toBe('unsure');
    expect(r.groups.find((g) => g.key === 'unsure')!.reasons[0]!.code).toBe('no_identifiers');
  });

  it('a photo whose plate matches the client registration joins its case', () => {
    const p = fk('ph', 9, [], { isPhoto: true, plates: ['KX21 ABC'] });
    const r = groupFiles({ files: [aV5c(), bV5c(), bLetter(), p], index: noIndex, nameHint: 'Ali Example', pins: {}, excluded: [] });
    expect(r.fileGroup.ph).toBe(r.fileGroup['a-v5c']);
    expect(r.groups.find((g) => g.fileIds.includes('ph'))!.reasons.some((x) => x.code === 'plate_in_photo')).toBe(true);
  });

  it('owner pins and exclusions win; duplicates follow their primary', () => {
    const r = groupFiles({ files: [aV5c(), aForm(), aLetter(), bV5c(), bLetter()], index: noIndex, nameHint: 'Jane Doe', pins: { 'a-letter': 'case:B', 'b-letter': 'unsure' }, excluded: ['a-form'], duplicateOf: {} });
    expect(r.fileGroup['a-letter']).toBe('case:B');
    expect(r.fileGroup['b-letter']).toBe('unsure');
    expect(r.fileGroup['a-form']).toBe('excluded');
    expect(r.groups.find((g) => g.key === 'case:B')!.reasons.some((x) => x.code === 'moved_by_owner')).toBe(true);
    const d = groupFiles({ files: [aV5c(), aForm(), fk('dup', 7, [])], index: noIndex, nameHint: '', pins: {}, excluded: [], duplicateOf: { dup: 'a-v5c' } });
    expect(d.fileGroup.dup).toBe('main');
  });

  it('children follow their parent unless an attachment contradicts it', () => {
    const eml = fk('eml', 1, [cand('vehicle.vin', 'WVWZZZ1KZAW000001', 'eml', 'correspondence')], { role: 'email' });
    const att = fk('att', 2, [cand('vehicle.vin', 'SAJAA01A12B000002', 'att', 'v5c')], { role: 'attachment', parentFileId: 'eml' });
    const seg = fk('seg', 3, [], { role: 'segment', parentFileId: 'eml' });
    const r = groupFiles({ files: [eml, att, seg, aV5c()], index: noIndex, nameHint: '', pins: {}, excluded: [] });
    expect(r.fileGroup.seg).toBe(r.fileGroup.eml);
    expect(r.fileGroup.att).not.toBe(r.fileGroup.eml);
  });

  it('warns when one cluster shows two client VINs (not auto-split)', () => {
    const x = fk('x', 1, [cand('vehicle.registration', 'KX21 ABC', 'x', 'v5c'), cand('client.phone', '07700900123', 'x', 'v5c'), cand('vehicle.vin', 'WVWZZZ1KZAW000001', 'x', 'v5c')]);
    const y = fk('y', 2, [cand('vehicle.registration', 'KX21 ABC', 'y', 'bodyshop_estimate'), cand('client.phone', '07700900123', 'y', 'bodyshop_estimate'), cand('vehicle.vin', 'WVWZZZ1KZAW000007', 'y', 'bodyshop_estimate')]);
    const r = groupFiles({ files: [x, y], index: noIndex, nameHint: '', pins: {}, excluded: [] });
    expect(r.groups[0]!.fileIds).toEqual(['x', 'y']);
    expect(r.warnings[0]).toMatch(/may be two cases/);
  });

  it('is deterministic regardless of input order', () => {
    const a = groupFiles({ files: [aV5c(), aForm(), aLetter(), bV5c(), bLetter()], index: noIndex, nameHint: 'Jane', pins: {}, excluded: [] });
    const b = groupFiles({ files: [bLetter(), aLetter(), bV5c(), aForm(), aV5c()], index: noIndex, nameHint: 'Jane', pins: {}, excluded: [] });
    expect(b).toEqual(a);
  });

  it('nextCaseKey skips used letters', () => {
    expect(nextCaseKey([])).toBe('case:B');
    expect(nextCaseKey(['case:B', 'case:C'])).toBe('case:D');
  });

  it('an empty bundle still has a main group', () => {
    expect(groupFiles({ files: [], index: noIndex, nameHint: 'x', pins: {}, excluded: [] }).groups.map((g) => g.key)).toEqual(['main']);
  });
});

describe('groupFiles — weak identifiers only', () => {
  it('a file with only a weak identifier joins the one case sharing it, never a case of its own', () => {
    const notes = fk('notes', 9, [], { otherKeys: [{ kind: 'phone', value: '07700 900456' }] });
    const form = fk('a-form2', 2, [cand('client.name', 'Jane Doe', 'a-form2', 'fnol_form'), cand('client.phone', '07700 900456', 'a-form2', 'fnol_form'), cand('vehicle.registration', 'KX21 ABC', 'a-form2', 'fnol_form'), cand('vehicle.vin', 'WVWZZZ1KZAW000001', 'a-form2', 'fnol_form')]);
    const r = groupFiles({ files: [aV5c(), form, notes, bV5c(), bLetter()], index: noIndex, nameHint: 'Jane Doe', pins: {}, excluded: [] });
    expect(r.fileGroup.notes).toBe('main');
    expect(r.groups.find((g) => g.key === 'main')!.reasons.some((x) => /weak link/.test(x.text))).toBe(true);
    expect(r.groups.filter((g) => g.kind === 'new_case')).toHaveLength(1);
  });
  it('a weak identifier shared with two cases leaves the file to the unkeyed rules', () => {
    const notes = fk('notes', 9, [], { otherKeys: [{ kind: 'postcode', value: 'RG1 1AA' }, { kind: 'postcode', value: 'LS1 4AB' }] });
    const r = groupFiles({ files: [aV5c(), notes, bV5c(), bLetter()], index: noIndex, nameHint: 'Jane Doe', pins: {}, excluded: [] });
    expect(r.fileGroup.notes).toBe('unsure');
  });
});
