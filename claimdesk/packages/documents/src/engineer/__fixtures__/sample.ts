/**
 * A realistic (fictitious) CarFlex engineer report: front offside impact on a 2019 Ford Focus, nine repair lines from
 * an Audatex estimate export, the owner's library, the engineer and two AI suggestions still to confirm, plus two
 * synthetic photographs (photo 2 is stored sideways with EXIF orientation 6).
 */
import { readFileSync } from 'node:fs';
import type { EngineerReportData } from '../carflexReport.js';

export function samplePhotos(): Array<{ bytes: Uint8Array; description: string }> {
  const read = (f: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./${f}`, import.meta.url)));
  return [
    { bytes: read('photo-1-front-offside.jpg'), description: 'Front offside: bumper cover split at the wing joint, wing creased above the wheel arch.' },
    { bytes: read('photo-2-rear-nearside-exif6.jpg'), description: 'Rear nearside quarter: no accident damage; general condition for valuation.' }
  ];
}

export function sampleEngineerReport(): EngineerReportData {
  return {
    reference: 'CFX-ENG-2026-0142',
    version: 'v1',
    status: 'Draft — awaiting engineer review and signature',
    reportDate: '2026-10-07',
    instruction: {
      claimantOwner: 'Mr Daniel Ashworth',
      ownInsurer: 'Admiral Insurance',
      ownInsurerReference: 'ADM-77310452',
      thirdPartyInsurer: 'Aviva Insurance Ltd',
      thirdPartyReference: 'AVI/MTR/5520193',
      dateOfLoss: '2026-09-28',
      locationOfLoss: 'A30 Staines Road, Bedfont, TW14',
      thirdPartyVehicle: 'Vauxhall Corsa 1.2 SE',
      thirdPartyRegistration: 'YF68KLM',
      dateInstructed: '2026-09-30',
      instructionReference: 'CCG-2026-00412',
      purpose: 'Inspect the vehicle, assess accident damage and repair costs, state roadworthiness and give a pre-accident value.'
    },
    vehicle: {
      registration: 'LD19XKP',
      vin: 'wf0nxxgchnkj12345',
      make: 'Ford',
      model: 'Focus',
      derivative: 'ST-Line 1.0 EcoBoost 125',
      mileage: 41286,
      bodyType: 'Hatchback',
      doors: 5,
      fuelType: 'Petrol',
      transmission: 'Manual, 6-speed',
      engineSizeCc: 999,
      engineCode: 'M1DA',
      colour: 'Magnetic Grey',
      paintCode: 'JAYC',
      firstRegistered: '2019-03-14'
    },
    inspection: {
      date: '2026-10-02',
      time: '10:30',
      type: 'Physical inspection',
      condition: 'Stationary, unrepaired, clean',
      dismantling: 'No — front bumper fixings inspected in situ',
      photographsSource: 'Engineer (12 photographs)',
      diagnosticTool: 'Autel MaxiSys MS906',
      scanReference: 'SCAN-0142-01',
      warningLamps: 'Parking aid fault lamp on',
      roadTest: 'Not completed — parking aid fault and damaged headlamp'
    },
    circumstances: {
      accountSource: 'Claimant, by telephone on 30/09/2026; CCGUK first notification of loss',
      reported: 'The claimant reports that he was stationary in a queue when the third-party vehicle, pulling out of a side road, struck the front offside corner of his vehicle at low speed.',
      impactType: 'Angled, low speed',
      primaryImpact: 'Front offside corner',
      secondaryContact: 'None reported',
      contactDirection: 'Offside to nearside, front',
      postImpactSymptoms: 'Parking sensor warning; offside headlamp loose'
    },
    assessment: {
      structural: 'No structural damage seen. Front offside crash can and bumper reinforcement visibly straight; measurement not required on the evidence available.',
      mechanical: 'No mechanical damage seen at inspection. Steering central; no fluid leaks.',
      wheelsTyres: 'Front offside alloy wheel scuffed on the outer rim (pre-existing kerbing). Tyres legal.',
      wheelGeometry: 'Four-wheel alignment check recommended after repair (included in the estimate).',
      diagnostics: 'Front offside parking sensor circuit fault stored (B1A2B-13). No airbag or ADAS faults stored.',
      roadworthiness: 'Not roadworthy until the offside headlamp is replaced and aimed (insecure lamp, beam pattern affected).'
    },
    valuation: {
      date: '2026-10-05',
      mileage: 41286,
      costNewPence: 2_249_500,
      preAccidentCondition: 'Above average for age and mileage',
      evidence: [
        { source: 'glass', date: '2026-10-05', valuePence: 1_345_000 },
        { source: 'cap_hpi', date: '2026-10-05', valuePence: 1_320_000 },
        { source: 'autotrader', reference: 'advert AT-202610-55821', date: '2026-10-04', valuePence: 1_399_500 },
        { source: 'percayso', date: '2026-10-05', valuePence: 1_360_000 }
      ],
      assessedValuePence: 1_365_000,
      salvageCategory: 'Not applicable — economic repair',
      economicAssessment: 'Economic repair',
      comments: 'Trade guides adjusted for mileage and condition; retail advert evidence supports the upper end of the range.'
    },
    repair: {
      lines: [
        { partNumber: '2215537', description: 'Front bumper cover (primed)', zoneId: 'front_bumper', operation: 'replace', labourCategory: 'body', labourHours: 1.2, partPricePence: 28_640, paintMaterialsPence: 0, source: 'audatex_estimate', verified: true },
        { description: 'Front bumper cover — refinish', zoneId: 'front_bumper', operation: 'paint', labourCategory: 'paint', labourHours: 2.4, partPricePence: 0, paintMaterialsPence: 9_850, source: 'audatex_estimate', verified: true },
        { description: 'Offside front wing — repair crease', zoneId: 'front_wing_os', operation: 'repair', labourCategory: 'body', labourHours: 2.0, partPricePence: 0, paintMaterialsPence: 0, source: 'manual', verified: true },
        { description: 'Offside front wing — refinish and blend into door', zoneId: 'front_wing_os', operation: 'paint', labourCategory: 'paint', labourHours: 1.8, partPricePence: 0, paintMaterialsPence: 6_420, source: 'audatex_estimate', verified: true },
        { partNumber: '2442360', description: 'Offside headlamp unit, LED', zoneId: 'headlamp_os', operation: 'replace', labourCategory: 'auxiliary', labourHours: 0.6, partPricePence: 64_512, paintMaterialsPence: 0, source: 'owner_library', verified: true },
        { description: 'Headlamp aim check', zoneId: 'headlamp_os', operation: 'check', labourCategory: 'mechanical', labourHours: 0.3, partPricePence: 0, paintMaterialsPence: 0, source: 'manual', verified: true },
        { partNumber: '2236119', description: 'Front bumper bracket, offside', zoneId: 'front_bumper', operation: 'replace', labourCategory: 'body', labourHours: 0.3, partPricePence: 1_845, paintMaterialsPence: 0, source: 'ai_estimate', verified: false },
        { partNumber: '2196884', description: 'Front parking sensor, offside outer', zoneId: 'parking_sensor_front_os', operation: 'replace', labourCategory: 'auxiliary', labourHours: 0.4, partPricePence: 4_210, paintMaterialsPence: 0, source: 'ai_estimate', verified: false },
        { description: 'Four-wheel alignment check', zoneId: 'wheel_front_os', operation: 'check', labourCategory: 'mechanical', labourHours: 0.8, partPricePence: 0, paintMaterialsPence: 0, source: 'manual', verified: true }
      ],
      otherItems: [
        { description: 'Front radar / camera calibration (sublet)', amountPence: 14_500, source: 'ai_estimate', verified: false },
        { description: 'Consumables and sundries', amountPence: 1_850, source: 'manual', verified: true }
      ],
      notes: 'Parts prices from the Audatex estimate export of 02/10/2026 and the CarFlex parts library.'
    },
    opinion:
      'The damage is consistent with the reported low-speed angled impact to the front offside corner. Repair is economic: the bumper cover, bracket, headlamp and parking sensor are replaced, the wing is repaired, and both panels are refinished. The vehicle is not roadworthy until the headlamp is replaced and aimed. ADAS calibration is recommended after the bumper repair.',
    photos: undefined,
    photoSourceAndDate: 'Photographs taken by the engineer at CarFlex Secure Storage on 02/10/2026.',
    customer: {
      fullName: 'Mr Daniel Ashworth',
      relationship: 'Registered keeper and owner',
      address: '14 Willow Court',
      town: 'Ashford, Surrey',
      postcodeCountry: 'TW15 2LP, United Kingdom',
      telephone: '01784 220 118',
      mobile: '07700 900 412',
      email: 'd.ashworth@example.co.uk',
      vatStatus: 'Not VAT registered',
      notes: 'Private use; prefers contact by mobile.'
    },
    assessor: { name: 'J. Patel IEng MIMI', role: 'Vehicle Damage Assessor' }
  };
}
