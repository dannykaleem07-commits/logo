import { describe, expect, it } from 'vitest';
import { scanDocx } from '../scan.js';
import { builtinAssetBytes } from './builtin/index.js';
import { FIELD_DEFS, getFieldDef, listFieldGroups } from './dictionary.js';

const CCTV = ['client_dashcam', 'tp_dashcam', 'council', 'bus_operator', 'shops', 'petrol_station', 'doorbell', 'other'];
const MEANS_INCOME = ['employedNetPay', 'selfEmployedDrawings', 'universalCredit', 'pipDla', 'childBenefit', 'housingBenefit', 'pension', 'other'];
const MEANS_OUT = ['rentMortgage', 'councilTax', 'utilities', 'foodHousehold', 'telecoms', 'vehicleInsurance', 'fuelTravel', 'loans', 'cardRepayments', 'childcare', 'other'];

/** Every key named in design doc Appendix 1 (A1.1–A1.7), with the bracketed families expanded. */
const APPENDIX_1_KEYS: string[] = [
  // A1.1
  'company.registeredName', 'company.tradingName', 'company.number', 'company.registeredOffice', 'company.caseHandlerPhone', 'company.officePhone',
  'company.email', 'company.website', 'company.director', 'company.vatNumber', 'company.icoRegistration', 'company.bank.accountName',
  'company.bank.bankName', 'company.bank.sortCode', 'company.bank.accountNumber',
  'doc.date', 'doc.dateLong', 'doc.agreementRef', 'doc.subject', 'doc.body.paragraphs', 'doc.replyByDate', 'doc.valediction', 'doc.enclosures', 'doc.cc',
  'doc.signedDate', 'doc.copyToClientAt', 'doc.copyToClientMethod', 'doc.sentToTpInsurerAt', 'doc.sentToOwnInsurerAt', 'doc.insurerAcknowledgedAt',
  'doc.reviewedBy', 'doc.reviewedOn', 'handler.name', 'handler.position', 'handler.caseHandler', 'handler.contact',
  // A1.2
  'claim.reference', 'claim.openedAt', 'claim.firstInstructedAt', 'claim.retrospectiveAppointment', 'claim.liability', 'claim.liabilityDate',
  'claim.settlementAuthority', 'claim.agreementMadeAt', 'claim.clientAuthoritySigned', 'claim.clientAuthoritySignedOn', 'claim.ledgerOpened',
  'claimant.name', 'claimant.initialsSurname', 'claimant.dateOfBirth', 'claimant.address', 'claimant.addressNoPostcode', 'claimant.postcode', 'claimant.phone',
  'claimant.email', 'claimant.drivingLicenceNumber', 'claimant.licenceType', 'claimant.licenceHeldYears', 'claimant.licenceHeldSince', 'claimant.occupation',
  'claimant.isPcoDriver', 'claimant.pcoBadgeNumber', 'claimant.idSeen', 'claimant.photoIdVerified', 'claimant.consentDisputeReferral',
  // A1.3
  'vehicle.registration', 'vehicle.make', 'vehicle.model', 'vehicle.makeModel', 'vehicle.makeModelReg', 'vehicle.vin', 'vehicle.colour', 'vehicle.fuelType',
  'vehicle.transmission', 'vehicle.engineFuel', 'vehicle.firstRegistered', 'vehicle.yearOfManufacture', 'vehicle.mileageAtAccident', 'vehicle.yearMileage',
  'vehicle.gtaGroup', 'vehicle.classDescription', 'vehicle.registeredKeeper', 'vehicle.registeredKeeperName', 'vehicle.keeperNameRelationship',
  'vehicle.financeOrLease', 'vehicle.financeLender', 'vehicle.financeOutstandingPence', 'vehicle.ownerIfDifferent', 'vehicle.preExistingDamage', 'vehicle.panelsDamaged',
  // A1.4
  'accident.date', 'accident.time', 'accident.dateTime', 'accident.dateLong', 'accident.dateTimeApprox', 'accident.location', 'accident.postcode',
  'accident.townPostcode', 'accident.circumstances', 'accident.policeAttended', 'accident.policeReference', 'accident.driveable', 'accident.airbagsDeployed',
  'accident.injuries', 'accident.witnesses', 'accident.accountTakenBy', 'accident.accountTakenAt',
  ...CCTV.flatMap((s) => [`accident.cctv.${s}.requestSentOn`, `accident.cctv.${s}.contact`, `accident.cctv.${s}.overwriteDate`]),
  ...['directionOfTravel', 'weather', 'light', 'roadSurface', 'speedLimitMph', 'numberOfLanes', 'clientLane', 'busLanePresent', 'busLaneHours', 'laneMarkings',
    'clientSpeedMph', 'otherVehicleSpeedMph', 'clientVehicleOccupied', 'clientPassengers', 'sceneStatements', 'pointOfFirstImpact', 'directionOfForce',
    'policeForceStation', 'reportedToPoliceWithin24h', 'breathTest', 'breathTestResult', 'reportedForOffence', 'injuryAdviceGivenOn', 'injuryAdviceChannel',
    'injuryAdviceConfirmedInWriting'].map((k) => `accident.${k}`),
  'tp.driverName', 'tp.driverAddress', 'tp.driverPhone', 'tp.vehicleRegistration', 'tp.vehicleDescription', 'tp.vehicleMakeModelReg', 'tp.vehicleMakeModelColour',
  'tp.policyNumber', 'tp.detailsSource', 'tp.askMidCheckedOn', 'tp.askMidResult', 'tp.vehicleDamage', 'tp.passengers',
  'tpInsurer.name', 'tpInsurer.claimRef', 'tpInsurer.firstContactedOn', 'ownInsurer.name', 'ownInsurer.policyNumber', 'ownInsurer.namePolicy', 'ownInsurer.claimRef',
  'ownInsurer.cover', 'ownInsurer.excessPence', 'ownInsurer.reportedOn',
  // A1.5
  'hire.agreementNumber', 'hire.startAt', 'hire.endDate', 'hire.dailyRatePence', 'hire.gtaGroup', 'hire.excessPence', 'hire.odometerOut', 'hire.odometerIn',
  'hire.milesCovered', 'hire.releasedAt', 'hire.releaseDate', 'hire.returnedAt', 'hire.hirerName', 'hire.cancellationInfoGiven', 'hire.cancellationInfoDate',
  'hire.gta.ownClassGroup', 'hire.gta.ownClassRatePence', 'hire.gta.replacementClassGroup', 'hire.gta.replacementClassRatePence', 'hire.insuranceBasis',
  'hire.collectionMethod', 'hire.deliveryAddress', 'hire.releasedBy', 'hire.required', 'hire.conditionReportRef',
  'hire.deliveryChargePence', 'hire.adminFeePence', 'hire.driverDecl.moreThan3Accidents3y', 'hire.driverDecl.disqualified3y', 'hire.driverDecl.majorConviction',
  'hire.driverDecl.fullValidLicence', 'hire.contractChannel', 'hire.signedPlace', 'hire.cancellationInfoMedium', 'hire.substitutionReason', 'hire.selectionReason',
  'hire.ratePositionStatement', 'hire.fuelOutPercent', 'hire.chargeOutPercent', 'hire.keysSupplied', 'hire.gta.ownClassAutoGroup', 'hire.gta.ownClassAutoRatePence',
  'hire.enfCheck.checkedBy', 'hire.enfCheck.checkedDate', 'hire.enfCheck.defects', 'hire.releaseDamage', 'hire.returnDamage', 'hire.receivedBy', 'hire.returnedBy',
  'hire.returnLocation', 'hire.fuelOut', 'hire.fuelIn', 'hire.batteryOutPercent', 'hire.batteryInPercent', 'hire.return.newDamage', 'hire.return.damageNotifiedDate',
  'hire.return.fuelShortfall', 'hire.return.fuelChargePence', 'hire.return.cleaningRequired', 'hire.return.cleaningChargePence',
  'hire.release.photoCount', 'hire.return.photoCount', 'hire.release.photoStore', 'hire.return.photoStore',
  'hireVehicle.registration', 'hireVehicle.makeModel', 'hireVehicle.makeModelReg', 'hireVehicle.colour', 'hireVehicle.vin', 'hireVehicle.engineFuel',
  'hireVehicle.transmission', 'hireVehicle.insurerName', 'hireVehicle.policyNumber',
  // A1.6
  'storage.currentLocation', 'storage.facility', 'storage.enteredAt', 'storage.startDate', 'storage.releasedAt', 'storage.endDate', 'storage.days',
  'storage.dailyRatePence', 'storage.netPence', 'storage.instructedDate', 'storage.odometerOnEntry', 'storage.required', 'storage.carriedOut', 'storage.log',
  'storage.invoiceRef', 'storage.part3SignedOn', 'storage.conditionOnEntry', 'storage.keys', 'storage.personalItems', 'storage.releasedTo', 'storage.releaseCapacity',
  'storage.releaseIdChecked', 'storage.releaseAuthority',
  'recovery.date', 'recovery.fromLocation', 'recovery.toLocation', 'recovery.loadedMiles', 'recovery.mileagePence', 'recovery.netPence', 'recovery.basisText',
  'recovery.instructedDate', 'recovery.outcome', 'recovery.carriedOut', 'recovery.required', 'recovery.notCharged', 'recovery.agentName', 'recovery.invoiceRef',
  'recovery.part2SignedOn', 'recovery.provider', 'recovery.deliveredAt', 'recovery.jobRef',
  'engineer.instructedDate', 'engineer.inspectionAt', 'engineer.inspectionBasis', 'engineer.inspectionPlace', 'engineer.name', 'engineer.reportRef',
  'engineer.issuedDate', 'engineer.roadworthy', 'engineer.odometerMiles', 'engineer.repairCostPence', 'engineer.repairCostVatBasis', 'engineer.pavPence',
  'engineer.decision', 'engineer.salvageCategory', 'engineer.salvageValuePence', 'engineer.feePence', 'engineer.feeCharged', 'engineer.reportSentToClientDate',
  'engineer.reportSentToInsurerDate', 'engineer.outcome', 'engineer.carriedOut', 'engineer.required', 'engineer.part4SignedOn', 'engineer.invoiceRef',
  'payment.reference', ...['hire', 'recovery', 'storage', 'engineering', 'repair', 'pav', 'excess', 'other'].map((h) => `payment.directs.${h}`),
  'payment.totalPence', 'payment.additionalDescription', 'payment.additionalInvoiceRef', 'payment.additionalPence',
  'services.recovery', 'services.storage', 'services.engineering', 'services.creditHire', 'services.diagnostics', 'services.repairCoordination',
  // A1.7
  'witness.fullName', 'witness.initialsSurname', 'witness.dateOfBirth', 'witness.address', 'witness.phone', 'witness.email', 'witness.onBehalfOf',
  'witness.statementNumber', 'witness.exhibitRefsList', 'witness.exhibits', 'witness.relationshipToClaimant', 'witness.paragraphs',
  'intervention.offerMade', 'intervention.noOfferMade', 'intervention.receivedAt', 'intervention.channel', 'intervention.offerorName', 'intervention.offerorOrganisation',
  'intervention.madeTo', 'intervention.writtenOfferLocation', 'intervention.vehicleClassOffered', 'intervention.suitable', 'intervention.terms.excessPence',
  'intervention.terms.mileageLimit', 'intervention.terms.durationStated', 'intervention.terms.otherTerms', 'intervention.clientDecision', 'intervention.replySentAt',
  'intervention.clientReasons', 'intervention.chronology',
  ...['writtenTermsReceived', 'vehicleOffered', 'transmissionOffered', 'matchesClientVehicle', 'fuelTypeOffered', 'terms.depositPence', 'terms.depositNone',
    'terms.excessNotStated', 'permittedDrivers', 'minimumDriverAge', 'excessMileageCharge', 'onExpiry', 'deliveryAt', 'deliveryAddress', 'repairOffered',
    'repairerOffered', 'courtesyCarForFullRepair', 'costToClient', 'termsPutToClientAt', 'termsPutToClientBy', 'confirmedToClientOn', 'hireEndedAsResult',
    'daysSaved', 'valueOfDaysSaved', 'calculatedBy'].map((k) => `intervention.${k}`),
  'means.employmentStatus', 'means.dependants', 'means.householdAdults',
  ...MEANS_INCOME.flatMap((l) => [`means.income.${l}.amount`, `means.income.${l}.frequency`]), 'means.income.totalMonthly',
  ...MEANS_OUT.flatMap((l) => [`means.outgoings.${l}.amount`, `means.outgoings.${l}.frequency`]), 'means.outgoings.totalMonthly',
  'means.currentAccountBalance', 'means.savingsTotal', 'means.overdraftLimit', 'means.overdraftUsed',
  ...[0, 1].flatMap((i) => [`means.creditCards[${i}].provider`, `means.creditCards[${i}].limitBalance`]),
  'means.otherCredit', 'means.couldPay500Upfront', 'means.sacrificesNarrative', 'means.otherVehicleInHousehold', 'means.otherVehicleDetails',
  'means.otherVehicleAvailable', 'means.otherVehicleExplanation', 'means.publicTransportSuitable', 'means.publicTransportExplanation', 'means.docsReceivedOn',
  'means.docsReceivedBy', 'means.docsOutstanding', 'means.docsChasedOn', 'means.completedWithClientBy', 'means.completedWithClientOn', 'means.figuresCrossChecked',
  'means.checkedBy', 'means.discrepancies', 'means.impecuniosityReliedOn', 'means.decisionBy', 'means.statementCompletedOn',
  ...['bankStatements', 'payslips', 'benefitLetters', 'creditCardStatements', 'overdraftEvidence', 'rentCouncilTaxEvidence'].map((k) => `means.docs.${k}`),
  'evidence.photosTaken', 'evidence.photoCount', 'evidence.photosStoredAt',
  ...['signedPack', 'recoveryJobSheet', 'storageLog', 'photos', 'engineerReport', 'insurerCorrespondence', 'invoices', 'remittance'].map((k) => `evidence.${k}`),
  'clocks.cctvPreservation.startDate', 'clocks.cctvPreservation.followUpDate', 'clocks.chaser1.dueDate', 'clocks.chaser2.dueDate', 'clocks.icobs3Months.dueDate',
  'clocks.limitation.dueDate', 'hire.agreementSignedOn',
  'recipient.name', 'recipient.attentionName', 'recipient.department', 'recipient.addressLines', 'recipient.townPostcode', 'recipient.email',
  'recipient.theirReference', 'recipient.salutation'
];

const ALIASES: Record<string, string> = {
  'claimant.fullName': 'claimant.name',
  'claimant.addressFull': 'claimant.address',
  'claimant.addressInline': 'claimant.address',
  'vehicle.mileage': 'vehicle.mileageAtAccident',
  'vehicle.odometerAtInstruction': 'vehicle.mileageAtAccident',
  'tp.registration': 'tp.vehicleRegistration',
  'tpInsurer.reference': 'tpInsurer.claimRef',
  'hire.startDate': 'hire.startAt',
  'hire.releaseMethod': 'hire.collectionMethod',
  'recovery.attendedAt': 'recovery.date'
};

describe('FIELD_DEFS', () => {
  it('has unique keys and aliases that do not shadow keys', () => {
    const keys = FIELD_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of FIELD_DEFS) for (const a of d.aliases ?? []) expect(keys).not.toContain(a);
  });

  it('defines every key of Appendix 1', () => {
    const missing = APPENDIX_1_KEYS.filter((k) => !FIELD_DEFS.some((d) => d.key === k));
    expect(missing).toEqual([]);
  });

  it('defines a condition key (out and in) for every panel printed in the 06 matrix', () => {
    const scan = scanDocx(builtinAssetBytes('form.ccguk_06_handover_condition'));
    const panels = scan.slots.filter((s) => s.qualifier === 'out' && s.sectionPath[0] === '03-condition-matrix');
    expect(panels.length).toBe(26);
    for (const s of panels) {
      const camel = s.labelSlug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      expect(getFieldDef(`hire.condition.${camel}.out`), s.label).toBeDefined();
      expect(getFieldDef(`hire.condition.${camel}.in`), s.label).toBeDefined();
    }
  });

  it('gives every non-handler field a resolver and no handler field a resolver', () => {
    for (const d of FIELD_DEFS) {
      if (d.policy === 'handler') expect(d.resolve, d.key).toBeUndefined();
      else expect(typeof d.resolve, d.key).toBe('function');
    }
  });

  it('accepts the Appendix 1 aliases', () => {
    for (const [alias, key] of Object.entries(ALIASES)) expect(getFieldDef(alias)?.key, alias).toBe(key);
    expect(getFieldDef('no.such.key')).toBeUndefined();
  });

  it('bank details are never overridable and GTA rates need confirmation unless verified', () => {
    for (const k of ['company.bank.accountName', 'company.bank.bankName', 'company.bank.sortCode', 'company.bank.accountNumber']) expect(getFieldDef(k)?.overridable).toBe(false);
    expect(getFieldDef('hire.gta.ownClassRatePence')?.requiresConfirmationUnlessVerified).toBe(true);
    expect(getFieldDef('hire.gta.replacementClassRatePence')?.requiresConfirmationUnlessVerified).toBe(true);
  });

  it('exclusive client choices have no resolver (never defaulted)', () => {
    for (const k of ['claim.settlementAuthority', 'claim.agreementMadeAt', 'hire.contractChannel', 'hire.driverDecl.fullValidLicence', 'means.couldPay500Upfront']) {
      expect(getFieldDef(k)?.policy, k).toBe('handler');
      expect(getFieldDef(k)?.resolve, k).toBeUndefined();
    }
  });

  it('lists groups with their fields; every field has a label and its label as a synonym', () => {
    const groups = listFieldGroups();
    expect(groups.reduce((n, g) => n + g.fields.length, 0)).toBe(FIELD_DEFS.length);
    for (const d of FIELD_DEFS) {
      expect(d.label.trim(), d.key).not.toBe('');
      expect(d.synonyms, d.key).toContain(d.label.toLowerCase());
    }
  });

  it('is JSON-serialisable apart from the resolver', () => {
    const plain = FIELD_DEFS.map(({ resolve: _r, ...rest }) => rest);
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
  });
});
