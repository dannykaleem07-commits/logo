import { describe, expect, it } from 'vitest';
import { riskSignals, SIGNAL_TEXT, signalId, type SignalsInput } from './signals.js';
import { BANNED_INTAKE_WORDS, RISK_SIGNAL_CODES } from './types.js';

const empty: SignalsInput = {
  accidentAt: '2026-10-07T16:45:00.000Z',
  accidentDay: '2026-10-07',
  photos: [],
  documents: [],
  clientVrm: 'KX21ABC',
  tpVrm: 'LM19XYZ',
  otherClaims: { vehicle: [], fleetUnit: false, contacts: [], claimant: [] },
  settings: { beforeAccidentToleranceHours: 2, gpsOutlierKm: 2 },
  acks: {},
};
const photo = (fileId: string, over: Partial<SignalsInput['photos'][number]> = {}): SignalsInput['photos'][number] => ({ fileId, takenAt: null, gps: null, software: null, plates: [], scene: 'damage', onOtherClaims: [], ...over });
const doc = (fileId: string, over: Partial<SignalsInput['documents'][number]> = {}): SignalsInput['documents'][number] => ({ fileId, docType: 'insurer_letter', documentDate: null, extensionMatches: true, injection: false, ...over });
const codes = (i: SignalsInput) => riskSignals(i).map((s) => s.code);

describe('riskSignals', () => {
  it('no facts → no signals', () => {
    expect(riskSignals(empty)).toEqual([]);
  });

  it('photo before the accident, with the tolerance boundary', () => {
    expect(codes({ ...empty, photos: [photo('p', { takenAt: '2026-10-04T10:00:00.000Z' })] })).toEqual(['PHOTO_BEFORE_ACCIDENT']);
    expect(codes({ ...empty, photos: [photo('p', { takenAt: '2026-10-07T15:00:00.000Z' })] })).toEqual([]); // 1h45 before: inside 2 h
    expect(codes({ ...empty, photos: [photo('p', { takenAt: '2026-10-07T14:44:00.000Z' })] })).toEqual(['PHOTO_BEFORE_ACCIDENT']);
    expect(codes({ ...empty, photos: [photo('p', { takenAt: '2026-10-04T10:00:00.000Z', scene: 'document' })] })).toEqual([]);
  });

  it('photo long after, edited software, on another claim, plate not on the case', () => {
    expect(codes({ ...empty, photos: [photo('p', { takenAt: '2026-11-30T10:00:00.000Z' })] })).toEqual(['PHOTO_LONG_AFTER']);
    expect(codes({ ...empty, photos: [photo('p', { software: 'Adobe Photoshop 25.0' })] })).toEqual(['PHOTO_EDITED_SOFTWARE']);
    expect(codes({ ...empty, photos: [photo('p', { software: 'iOS 17.2' })] })).toEqual([]);
    expect(riskSignals({ ...empty, photos: [photo('p', { onOtherClaims: [{ claimId: 'c1', reference: 'CCG-2026-00001', how: 'same_file' }] })] })[0]).toMatchObject({ code: 'PHOTO_ON_OTHER_CLAIM', claims: [{ id: 'c1', reference: 'CCG-2026-00001' }] });
    expect(codes({ ...empty, photos: [photo('p', { plates: ['KX21 ABC', 'LM19 XYZ'] })] })).toEqual([]);
    expect(riskSignals({ ...empty, photos: [photo('p', { plates: ['AB12 CDE'] })] })[0]).toMatchObject({ code: 'PLATE_NOT_ON_CASE', message: 'Plate AB12 CDE in this photo is not a registration on this case.' });
  });

  it('GPS outlier with three located photos', () => {
    const near = { lat: 51.4545, lon: -0.9781 };
    const s = riskSignals({ ...empty, photos: [photo('a', { gps: near }), photo('b', { gps: { lat: 51.455, lon: -0.978 } }), photo('c', { gps: { lat: 51.4548, lon: -0.9779 } }), photo('far', { gps: { lat: 52.2, lon: 0.12 } })] });
    expect(s.map((x) => x.code)).toEqual(['PHOTO_GPS_OUTLIER']);
    expect(s[0]!.fileIds).toEqual(['far']);
    expect(codes({ ...empty, photos: [photo('a', { gps: near }), photo('far', { gps: { lat: 52.2, lon: 0.12 } })] })).toEqual([]);
  });

  it('documents: dated before, keeper after, insurance, licence, MOT, PDF hints, type mismatch, instructions', () => {
    expect(codes({ ...empty, documents: [doc('l', { documentDate: '2026-10-01' })] })).toEqual(['DOC_DATED_BEFORE_ACCIDENT']);
    expect(codes({ ...empty, documents: [doc('l', { documentDate: '2026-10-06' })] })).toEqual([]);
    expect(codes({ ...empty, documents: [doc('v', { docType: 'v5c', keeperSince: '2026-10-08' })] })).toEqual(['KEEPER_AFTER_ACCIDENT']);
    expect(codes({ ...empty, documents: [doc('i', { docType: 'insurance_certificate', validFrom: '2026-10-10', validTo: '2027-10-09' })] })).toEqual(['INSURANCE_NOT_IN_FORCE']);
    expect(codes({ ...empty, documents: [doc('i', { docType: 'insurance_certificate', validFrom: '2026-01-10', validTo: '2027-01-09' })] })).toEqual([]);
    expect(codes({ ...empty, documents: [doc('d', { docType: 'driving_licence', validTo: '2026-01-01' })] })).toEqual(['LICENCE_EXPIRED']);
    expect(codes({ ...empty, documents: [doc('m', { docType: 'mot_certificate', validTo: '2026-05-01' })] })).toEqual(['MOT_EXPIRED']);
    expect(codes({ ...empty, vehicleAgeYears: 2, documents: [doc('m', { docType: 'mot_certificate', validTo: '2026-05-01' })] })).toEqual([]);
    expect(codes({ ...empty, documents: [doc('p', { pdfMeta: { producer: 'iLovePDF', creator: null, createdAt: '2026-09-01T00:00:00Z', modifiedAt: '2026-10-01T00:00:00Z', incrementalUpdates: 2 } })] })).toEqual(['PDF_EDITED_AFTER_CREATION', 'PDF_EDITOR_PRODUCER', 'PDF_INCREMENTAL_UPDATES']);
    expect(codes({ ...empty, documents: [doc('p', { pdfMeta: { producer: 'Skia/PDF m120', creator: 'Chromium', createdAt: '2026-09-01T00:00:00Z', modifiedAt: '2026-09-01T00:00:00Z', incrementalUpdates: 0 } })] })).toEqual([]);
    const saves = (n: number) => riskSignals({ ...empty, documents: [doc('p', { pdfMeta: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: n } })] }).find((s) => s.code === 'PDF_INCREMENTAL_UPDATES')!.message;
    expect([saves(1), saves(2), saves(5)]).toEqual(['Saved again once after it was first made.', 'Saved again twice after it was first made.', 'Saved again 5 times after it was first made.']);
    expect(riskSignals({ ...empty, documents: [doc('x', { extensionMatches: false, ext: 'pdf', kind: 'JPEG photo' })] })[0]!.message).toBe('Named .pdf but is a JPEG photo.');
    expect(codes({ ...empty, documents: [doc('x', { injection: true })] })).toEqual(['INSTRUCTIONS_IN_DOCUMENT']);
  });

  it('accident after the newest upload', () => {
    expect(codes({ ...empty, newestUploadAt: '2026-10-01T00:00:00Z' })).toEqual(['ACCIDENT_IN_FUTURE']);
  });

  it('other claims: vehicle, fleet, contact, duplicate claimant (warn when open, info when closed)', () => {
    const s = riskSignals({
      ...empty,
      otherClaims: {
        vehicle: [{ claimId: 'c1', reference: 'CCG-2026-00001', how: 'registration', open: true, status: 'hire_active' }],
        fleetUnit: true,
        contacts: [{ claimId: 'c2', reference: 'CCG-2026-00002', field: 'phone', open: false }],
        claimant: [{ claimId: 'c3', reference: 'CCG-2026-00003', how: 'licence', open: true, daysApart: 10 }],
      },
    });
    expect(s.map((x) => [x.code, x.severity])).toEqual([
      ['VEHICLE_ON_OTHER_CLAIM', 'warn'],
      ['FLEET_VEHICLE_AS_CLIENT', 'warn'],
      ['CONTACT_ON_OTHER_CLAIM', 'info'],
      ['DUPLICATE_CLAIMANT', 'warn'],
    ]);
    expect(s[0]!.message).toBe('This car is also on CCG-2026-00001 (hire_active).');
    expect(s[2]!.message).toBe('Same phone number as a party on CCG-2026-00002.');
  });

  it('acknowledgements stay listed with the note; ids are stable', () => {
    const id = signalId('PHOTO_EDITED_SOFTWARE', ['p'], '');
    const s = riskSignals({ ...empty, photos: [photo('p', { software: 'Snapseed' })], acks: { [id]: { by: 'owner-1', note: 'resized', at: '2026-10-08T10:00:00Z' } } });
    expect(s[0]).toMatchObject({ id, acknowledged: { by: 'owner-1', note: 'resized' } });
  });

  it('no title, template or message uses accusing words', () => {
    for (const c of RISK_SIGNAL_CODES) {
      expect(BANNED_INTAKE_WORDS.test(SIGNAL_TEXT[c].title), c).toBe(false);
      expect(BANNED_INTAKE_WORDS.test(SIGNAL_TEXT[c].template), c).toBe(false);
    }
  });
});
