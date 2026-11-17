/* Sample job built from the structure of a real engineering report, with personal details anonymised. */
(function () {
  'use strict';
  function sampleJob() {
    const C = window.Core;
    const j = C.newJob();
    j.report = {
      ref: 'CF-AB14CDE-060926', date: '2026-09-06', version: '1.2',
      status: 'Final Engineering Assessment — Total Loss / Beyond Economical Repair — Category N Recommended.',
      headline: '', subHeadline: '',
      summary: 'The vehicle has sustained accident-related damage affecting multiple right-hand-side exterior components together with wheel, tyre and associated mechanical concerns. On the basis of the physical inspection and evidence presently available, **no damage to a principal structural member has been identified** subject to full strip inspection.\n\nThe vehicle is considered **beyond economical repair** having regard to the extent of repair required, its pre-accident market value, age, repair complexity and the potential for supplementary non-structural and mechanical costs following dismantling and testing.'
    };
    Object.assign(j.instruction, {
      instructingParty: 'Courtesy Cars Group UK Limited', ownInsurer: 'Sample Insurer', ownRef: 'OWN-000001', tpInsurer: 'Sample TP Insurer Ltd', tpRef: 'TP-000002',
      dateOfLoss: '2026-09-01', locationOfLoss: 'High Street, Esher', tpVehicle: 'Honda Civic', tpReg: 'XX08 XXX', dateInstructed: '2026-09-01', fileRef: 'CCG-AB14CDE-010926',
      purpose: 'Car Flex Ltd was instructed by Courtesy Cars Group UK Limited to undertake an engineering and accident-damage assessment of the claimant\'s vehicle, establish the nature and extent of the accident-related damage, assess structural condition, roadworthiness and associated mechanical concerns, determine an appropriate repair methodology and estimated repair costs, and consider the vehicle\'s pre-accident value and economic repair position.'
    });
    Object.assign(j.vehicle, {
      reg: 'AB14 CDE', vin: 'SJNFBAF15U7000000', make: 'Nissan', model: 'Juke', derivative: 'Acenta CVT', mileage: '64368', body: '5-door crossover / SUV',
      fuel: 'Petrol', transmission: 'Automatic / CVT', engineSize: '1598', engineCode: 'HR16DE', colour: 'Black', paintCode: '', firstReg: '2014-08-05', oemKey: 'nissan-juke-f15'
    });
    Object.assign(j.inspection, {
      date: '2026-09-01', time: '11:45AM', location: 'CarFlex Secure Storage Gleneagles Farm\nGleneagles Close Stanwell\nStaines-upon-Thames TW19 7PD',
      condition: 'The vehicle was presented in accident-damaged condition. Visible damage was concentrated predominantly along the right-hand side, comprising impact abrasion, scoring, paint transfer, localised panel deformation, damaged exterior trims, damaged RH exterior mirror assembly and wheel/tyre involvement. The vehicle remained assembled during the inspection.',
      photos: 'Yes', diagnostic: 'XTool full-system scan recorded in the file; scan printout/reference not supplied with this report.',
      roadTest: 'Road test not undertaken. The vehicle should not be considered suitable for road use due to the identified body damage together with the reported RH front tyre pressure loss, directional pull, vibration / judder, abnormal wheel-related noise and perceived wheel play.',
      warningLamps: 'TPMS warning lamp illuminated at the time of inspection. Recorded mileage: 64,368 miles.'
    });
    Object.assign(j.circumstances, {
      providedBy: 'Sample Claimant — claimant / vehicle owner.',
      narrative: 'The claimant reports that AB14 CDE was established in the left-hand lane when Honda Civic XX08 XXX, travelling in the adjacent right-hand lane, moved left into the claimant\'s occupied lane.\n\nInitial contact is reported around the Nissan\'s RH rear wheel-arch / rear-quarter area, with sustained contact subsequently progressing longitudinally along the right-hand side of the vehicle.\n\nThe photographic damage pattern demonstrates predominantly horizontal and longitudinal abrasion, scoring and paint transfer across successive RH-side components and is consistent with sustained sideswipe-type contact.',
      impactType: 'Sideswipe / lateral side contact', primaryArea: 'RH rear wheel-arch / rear quarter',
      secondaryArea: 'RH doors, exterior sill and wheel-arch trims, exterior mirror and wheel / tyre areas', direction: 'Rear to front along the RH side, as reported by the claimant',
      symptoms: 'RH front tyre deflation/pressure loss, directional pull, vibration/judder, abnormal wheel-related noise, perceived wheel play and TPMS warning. No specific braking problem or airbag deployment was reported'
    });
    j.zones = ['RH rear quarter', 'RH rear door', 'RH front door', 'RH sill', 'RH mirror', 'RH front wheel', 'RH rear wheel'];
    Object.assign(j.assessment, {
      structural: 'Visible accident-related damage is concentrated along the vehicle\'s right-hand side and includes abrasion, scoring, paint transfer and localised deformation of the affected exterior body panels. The RH front and RH rear doors display localised deformation of the outer door skins, most notably around the lower body contour and adjoining door-edge areas. The RH rear-side / quarter exterior area also displays accident-related abrasion and localised outer-panel disturbance.\n\nThe RH sill exterior moulding and affected RH wheel-arch mouldings are visibly damaged. The deformation presently identified is confined to the exterior panels and associated non-structural trim components.\n\nAt the time of this pre-strip inspection, no accident-related deformation, fracture, displacement or loss of integrity of a principal structural member was identified. The presently available evidence therefore does not establish structural damage for salvage categorisation purposes.\n\nThe vehicle is accordingly assessed as having sustained non-structural accident damage.\n\nAs no dismantling was undertaken, concealed components remain subject to supplementary inspection if the vehicle were to be repaired; however, this does not alter the present Category N assessment.',
      mechanical: 'Post-impact symptoms reported include directional pull, vibration/judder, abnormal wheel-related noise and perceived wheel play. The RH front wheel, hub/bearing, steering and suspension components require inspection and testing to establish whether any accident-related mechanical damage or displacement is present.',
      wheels: 'Collision-related abrasion is visible to the affected RH alloy wheels.\n\nBoth should be removed and checked for run-out, cracking, distortion and serviceability. Refurbishment is appropriate where structurally sound.\n\nThe RH front tyre requires removal and internal / external inspection due to the reported post-impact pressure loss.\n\nThe TPMS sensor / valve requires testing and replacement where confirmed damaged or defective.',
      geometry: 'A four-wheel geometry measurement should be undertaken following completion of the necessary wheel, tyre, steering and suspension inspections.\n\nAny geometry deviation should be investigated to establish whether it arises from wheel / suspension displacement or other accident-related mechanical damage.\n\nNo structural datum correction is presently included because principal structural damage has not been identified.',
      diagnostics: 'XTool diagnostic scan undertaken. TPMS warning lamp illuminated. No other relevant warning lamps identified at the time of assessment. Any stored diagnostic trouble codes relevant to the collision should be recorded and investigated as required. Recorded mileage at inspection:\n\n64,368 miles',
      roadworthiness: 'The vehicle should remain off the road until the RH body, tyre, wheel, steering and suspension concerns have been resolved.'
    });
    j.valuation = {
      date: 'September 2026', mileage: '64368', costNew: 'N/A', condition: 'SATISFACTORY',
      sources: [{ name: "Glass's Guide", amount: 5682 }, { name: 'CAP HPI', amount: 5395 }, { name: 'AutoTrader', amount: 5323 }, { name: 'Percayso Vehicle Intelligence', amount: 5269 }],
      adopted: 5682, salvagePct: 15, salvageOverride: '',
      comments: 'The vehicle has been valued at **64,368 miles**.\n\nAvailable valuation evidence ranges from **£5,269 to £5,682**, and an assessed pre-accident value of **£5,682** has been adopted.\n\nThe provisional salvage allowance of **£852.30** is used for assessment purposes only and may be replaced by an actual salvage quotation.\n\nThe vehicle has sustained accident-related damage across multiple RH-side body panels and exterior components, together with wheel, tyre and unresolved mechanical concerns.\n\nAlthough the vehicle remains technically repairable, the scale of repair, vehicle age, market value and reasonably anticipated supplementary mechanical repair risk make repair economically disproportionate.\n\nThe vehicle is therefore assessed as:'
    };
    j.outcome = { decision: 'Beyond Economical Repair / Total Loss Recommended', category: 'N' };
    const L = (type, description, partNo, hours, amount, costClass, code, side) => C.newLine({ type, description, partNo, hours, amount, costClass: costClass || 'parts', code: code || '', side: side || '', reviewed: true });
    j.lines = [
      L('Body', 'RH sill exterior moulding – remove & replace', '768501KA6A', 0.6, 74.55, 'parts', 'SS001', 'R'),
      L('Body', 'RH door mirror assembly – remove & replace', '96301BV80B', 0.6, 503.48, 'parts', 'MR001', 'R'),
      L('Body', 'Retainer / fixing – replace', '766901KA0A', 0.1, 21.17, 'parts', 'FX001'),
      L('Body', 'RH rear over-fender – remove & replace', '788601KA6A', 0.4, 85.61, 'parts', 'RQ004', 'R'),
      L('Body', 'RH front over-fender – remove & replace', '638601KA6A', 0.4, 85.70, 'parts', 'FW003', 'R'),
      L('Body', 'Retaining clip – replace', '768821KA1A', 0.1, 3.20, 'parts', 'FX002'),
      L('Mechanical', 'RH front tyre – remove, inspect & replace', '215/55 R17 94V', 0.5, 112.68, 'parts', 'WT003', 'R'),
      L('Body', 'Additional OE clip / fixing', '0146100QAD', 0.1, 2.81, 'parts', 'FX002'),
      L('Mechanical', 'TPMS sensor unit – test / replace as required', '407006WY0B', 0.3, 114.38, 'parts', 'WT004', 'R'),
      L('Body', 'RH rear-side / quarter outer panel – repair / metal finish', 'Existing panel', 1.7, 0, 'parts'),
      L('Body', 'RH rear door – panel restoration / metal finishing', 'Existing panel', 2.0, 0, 'parts'),
      L('Body', 'RH front door – panel restoration / metal finishing', 'Existing panel', 1.8, 0, 'parts'),
      L('Auxiliary', 'RH front door – strip / refit handle, trims & mouldings', '', 0.6, 0),
      L('Auxiliary', 'RH rear door – strip / refit handle, trims & mouldings', '', 0.6, 0),
      L('Auxiliary', 'RH sill exterior trim removal and concealed-area inspection', '', 0.5, 0),
      L('Body', 'Door gaps / flushness / hinge & striker alignment check', '', 0.8, 0),
      L('Mechanical', 'RH front wheel / hub / bearing / steering / suspension investigation', '', 1.2, 0),
      L('Mechanical', 'RH front & rear wheel – remove / refit for inspection', '', 0.6, 0),
      L('Auxiliary', 'Pre-repair diagnostic procedure', 'XTool', 0.3, 75, 'other'),
      L('Auxiliary', 'Post-repair diagnostic procedure', 'XTool', 0.3, 75, 'other'),
      L('Auxiliary', 'Four-wheel geometry setup / preparation', '', 0.4, 100, 'other'),
      L('Painting', 'RH rear-side / quarter – prepare & refinish', '', 1.6, 0, 'paint'),
      L('Painting', 'RH rear door – prepare & refinish', '', 1.6, 0, 'paint'),
      L('Painting', 'RH front door – prepare & refinish', '', 1.6, 0, 'paint'),
      L('Painting', 'Masking, colour matching, spray-out & paint setup', '', 0.7, 350, 'paint'),
      L('Auxiliary', 'Corrosion-protection application', '', 0.3, 22, 'other'),
      L('Auxiliary', 'Final quality-control inspection & controlled road test', '', 0.5, 0),
      L('Other', 'RH front alloy-wheel refurbishment', '', 0, 100, 'other'),
      L('Other', 'RH rear alloy-wheel refurbishment', '', 0, 100, 'other'),
      L('Materials', 'Panel-finishing / consumable materials', '', 0, 30, 'other'),
      L('Other', 'Tyre fitting, balancing & disposal', '', 0, 45, 'other')
    ];
    j.estimateNotes = 'This estimate represents the presently identifiable accident-related repair requirements based upon physical inspection, photographic evidence and the vehicle\'s assembled condition at the time of this pre-strip assessment.\n\nThe RH front and rear doors exhibit abrasion, scoring, paint transfer and localised outer-panel deformation requiring panel restoration / metal finishing prior to refinishing. The RH rear-side / quarter exterior area, RH sill exterior moulding, wheel-arch mouldings, RH exterior mirror, affected alloy wheels and RH front tyre are also included within the present repair scope.\n\nRemoval of the affected sill exterior trim and further inspection would be required to confirm the condition of the concealed sill / rocker structure. The estimate also provides for investigation of the reported RH wheel, hub / bearing, steering and suspension concerns, together with diagnostics and four-wheel geometry.\n\nAny additional accident-related damage identified during dismantling or mechanical testing would require separate supplementary assessment. The present estimate is therefore a pre-strip repair assessment and should not be interpreted as an absolute maximum repair cost.';
    j.opinion = 'The vehicle has sustained substantial accident-related damage predominantly along its right-hand side following a sustained sideswipe-type contact.\n\nVisible damage affects the RH rear wheel-arch / rear-quarter area, RH rear door, RH front door, RH sill exterior area, associated wheel-arch and sill mouldings, RH exterior mirror assembly and the affected RH wheel / tyre areas.\n\nThe RH front and rear doors exhibit extensive abrasion, scoring and paint transfer together with localised outer-panel deformation. These areas require panel restoration / metal finishing and refinishing rather than cosmetic polishing alone.\n\nThe RH sill / rocker exterior area has sustained contact damage. At this pre-strip stage, the underlying sill / rocker reinforcement and adjoining door-aperture structure remain partly concealed and cannot be conclusively assessed without removal of the relevant exterior trim. No definitive damage to a principal structural member has therefore been established on the evidence presently available.\n\nCollision-related marking is present to the affected RH alloy wheels. The RH front tyre has also been reported to have suffered post-impact pressure loss / deflation. Further reported symptoms include directional pull, vibration / judder, abnormal wheel-related noise and perceived wheel play. The RH front wheel, tyre, hub / bearing, steering and suspension assemblies therefore require further inspection and testing.\n\nThe presently identified repair estimate is £3,365.08 excluding VAT and £4,038.10 including VAT, against an assessed pre-accident value of £5,682.00.\n\nThe presently quantified repair cost therefore represents approximately 59.22% of the pre-accident value excluding VAT and 71.07% including VAT.\n\nThe vehicle has not undergone complete dismantling and the present estimate does not include any supplementary cost arising from concealed accident-related damage that may subsequently be identified during strip-down, dimensional inspection or mechanical investigation.\n\nHaving regard to the vehicle\'s age, pre-accident value, extent of multi-panel body repair, wheel and tyre involvement, unresolved mechanical concerns and the reasonable potential for supplementary repair costs following dismantling, repair is considered economically disproportionate.\n\nTOTAL LOSS RECOMMENDED.\n\nOn the presently available evidence, no damage to a principal structural member has been conclusively established. Accordingly, if the vehicle is formally declared a total loss and subsequent strip inspection confirms that the principal structural components remain unaffected, Category N — Non-Structural is considered the appropriate salvage category.';
    Object.assign(j.customer, {
      name: 'Sample Claimant', company: 'N/A', representative: 'Courtesy Cars Group UK Limited', relationship: 'Owner',
      address: '1 Sample Street, London', town: 'Brentford', postcode: 'TW8 0XX', telephone: '', mobile: '', email: 'claimant@example.com', vat: 'N/A',
      notes: 'Claim managed under instruction from Courtesy Cars Group UK Limited.'
    });
    Object.assign(j.assessor, { name: 'Sample Assessor', title: 'Automotive Accident Damage Assessor', dateSigned: '2026-09-06' });
    return j;
  }
  window.Sample = { sampleJob };
})();
