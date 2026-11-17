/*
 * Master parts catalogue: original data for this application.
 *
 * Codes, names, grouping and guide times are our own. They are NOT taken from
 * Audatex, Thatcham, GT Motive or any manufacturer system.
 *
 * Guide times are starting points for the assessor and can be edited on every
 * estimate line. They are not manufacturer-published times.
 *
 * Row format:
 *   [code, name, group, sided, replaceHrs, refinishHrs, kind]
 *     sided       1 = LH/RH versions exist, 0 = single part
 *     replaceHrs  remove & replace guide time, including normal transfers
 *     refinishHrs refinish guide time for a new panel (0 = not painted)
 *     kind        P painted panel | T trim | S structural | M mechanical
 *                 E electrical | G glass | L lighting | W wheel/tyre
 *                 C consumable/fixing | A ADAS/calibration
 */
window.CATALOGUE_GROUPS = [
  'Front end', 'Bonnet', 'Front wing & arch', 'Doors', 'Side & sill',
  'Rear quarter', 'Rear end', 'Tailgate / boot', 'Roof', 'Glass',
  'Lighting', 'Mirrors', 'Wheels & tyres', 'Suspension & steering',
  'Brakes', 'Cooling & A/C', 'Engine bay', 'Electrical & ADAS', 'SRS / airbags',
  'Interior', 'Underbody', 'Structural', 'Fixings & consumables'
];

window.CATALOGUE = [
  // ---------- Front end ----------
  ['FE001', 'Front bumper cover', 'Front end', 0, 1.6, 2.4, 'P'],
  ['FE002', 'Front bumper reinforcement / impact bar', 'Front end', 0, 1.0, 0, 'S'],
  ['FE003', 'Front bumper energy absorber (foam)', 'Front end', 0, 0.3, 0, 'T'],
  ['FE004', 'Front bumper upper grille', 'Front end', 0, 0.4, 0, 'T'],
  ['FE005', 'Front bumper lower grille', 'Front end', 0, 0.3, 0, 'T'],
  ['FE006', 'Front bumper side grille / fog lamp bezel', 'Front end', 1, 0.2, 0, 'T'],
  ['FE007', 'Front bumper side bracket / guide', 'Front end', 1, 0.3, 0, 'T'],
  ['FE008', 'Front bumper lower spoiler / lip', 'Front end', 0, 0.4, 0, 'T'],
  ['FE009', 'Front bumper towing eye cover', 'Front end', 0, 0.1, 0.2, 'P'],
  ['FE010', 'Front number plate bracket', 'Front end', 0, 0.2, 0, 'T'],
  ['FE011', 'Front number plate', 'Front end', 0, 0.2, 0, 'T'],
  ['FE012', 'Front panel / slam panel carrier', 'Front end', 0, 2.5, 1.2, 'S'],
  ['FE013', 'Bonnet lock / latch', 'Front end', 0, 0.4, 0, 'M'],
  ['FE014', 'Bonnet release cable', 'Front end', 0, 0.8, 0, 'M'],
  ['FE015', 'Front emblem / badge', 'Front end', 0, 0.1, 0, 'T'],
  ['FE016', 'Front bumper wheel-arch splash shield', 'Front end', 1, 0.3, 0, 'T'],
  ['FE017', 'Engine undertray / splash guard', 'Front end', 0, 0.3, 0, 'T'],
  ['FE018', 'Headlamp washer jet / cover', 'Front end', 1, 0.3, 0.3, 'P'],
  ['FE019', 'Front parking sensor', 'Front end', 0, 0.3, 0.2, 'E'],
  ['FE020', 'Front radar / ACC sensor bracket', 'Front end', 0, 0.3, 0, 'A'],

  // ---------- Bonnet ----------
  ['BN001', 'Bonnet panel', 'Bonnet', 0, 1.0, 3.0, 'P'],
  ['BN002', 'Bonnet hinge', 'Bonnet', 1, 0.6, 0.5, 'P'],
  ['BN003', 'Bonnet gas strut', 'Bonnet', 1, 0.1, 0, 'M'],
  ['BN004', 'Bonnet insulation pad', 'Bonnet', 0, 0.2, 0, 'T'],
  ['BN005', 'Bonnet seal', 'Bonnet', 0, 0.2, 0, 'T'],
  ['BN006', 'Scuttle panel / cowl grille', 'Bonnet', 0, 0.6, 0, 'T'],

  // ---------- Front wing & arch ----------
  ['FW001', 'Front wing', 'Front wing & arch', 1, 1.2, 2.2, 'P'],
  ['FW002', 'Front wheel-arch liner', 'Front wing & arch', 1, 0.4, 0, 'T'],
  ['FW003', 'Front wheel-arch moulding / over-fender', 'Front wing & arch', 1, 0.4, 0, 'T'],
  ['FW004', 'Front wing side repeater', 'Front wing & arch', 1, 0.2, 0, 'L'],
  ['FW005', 'Front wing bracket', 'Front wing & arch', 1, 0.3, 0, 'T'],
  ['FW006', 'Front wing badge / garnish', 'Front wing & arch', 1, 0.1, 0, 'T'],

  // ---------- Doors ----------
  ['DR001', 'Front door shell', 'Doors', 1, 3.0, 2.8, 'P'],
  ['DR002', 'Front door outer skin', 'Doors', 1, 3.5, 2.4, 'P'],
  ['DR003', 'Rear door shell', 'Doors', 1, 2.8, 2.6, 'P'],
  ['DR004', 'Rear door outer skin', 'Doors', 1, 3.3, 2.2, 'P'],
  ['DR005', 'Front door exterior handle', 'Doors', 1, 0.5, 0.3, 'T'],
  ['DR006', 'Rear door exterior handle', 'Doors', 1, 0.5, 0.3, 'T'],
  ['DR007', 'Front door handle cap / keyhole cover', 'Doors', 1, 0.2, 0.2, 'P'],
  ['DR008', 'Front door lower moulding', 'Doors', 1, 0.3, 0, 'T'],
  ['DR009', 'Rear door lower moulding', 'Doors', 1, 0.3, 0, 'T'],
  ['DR010', 'Front door waist / belt moulding', 'Doors', 1, 0.4, 0, 'T'],
  ['DR011', 'Rear door waist / belt moulding', 'Doors', 1, 0.4, 0, 'T'],
  ['DR012', 'Front door window regulator', 'Doors', 1, 0.8, 0, 'M'],
  ['DR013', 'Rear door window regulator', 'Doors', 1, 0.8, 0, 'M'],
  ['DR014', 'Front door lock / latch', 'Doors', 1, 0.7, 0, 'M'],
  ['DR015', 'Rear door lock / latch', 'Doors', 1, 0.7, 0, 'M'],
  ['DR016', 'Front door hinge (pair)', 'Doors', 1, 1.0, 0.5, 'P'],
  ['DR017', 'Rear door hinge (pair)', 'Doors', 1, 1.0, 0.5, 'P'],
  ['DR018', 'Front door check strap', 'Doors', 1, 0.3, 0, 'M'],
  ['DR019', 'Front door weatherstrip', 'Doors', 1, 0.3, 0, 'T'],
  ['DR020', 'Rear door weatherstrip', 'Doors', 1, 0.3, 0, 'T'],
  ['DR021', 'Front door trim panel', 'Doors', 1, 0.4, 0, 'T'],
  ['DR022', 'Rear door trim panel', 'Doors', 1, 0.4, 0, 'T'],
  ['DR023', 'Front door B-pillar applique / blackout', 'Doors', 1, 0.2, 0, 'T'],
  ['DR024', 'Rear door B/C-pillar applique', 'Doors', 1, 0.2, 0, 'T'],
  ['DR025', 'Door protection film / side impact beam', 'Doors', 1, 0.2, 0, 'T'],

  // ---------- Side & sill ----------
  ['SS001', 'Sill exterior moulding / side skirt', 'Side & sill', 1, 0.6, 0, 'T'],
  ['SS002', 'Sill outer panel (section)', 'Side & sill', 1, 6.0, 2.0, 'S'],
  ['SS003', 'Sill full outer panel', 'Side & sill', 1, 10.0, 2.5, 'S'],
  ['SS004', 'Sill reinforcement', 'Side & sill', 1, 8.0, 0, 'S'],
  ['SS005', 'Kick plate / scuff plate', 'Side & sill', 1, 0.2, 0, 'T'],
  ['SS006', 'Roof rail / roof bar', 'Side & sill', 1, 0.6, 0, 'T'],
  ['SS007', 'Roof drip moulding', 'Side & sill', 1, 0.4, 0, 'T'],
  ['SS008', 'B-pillar outer panel', 'Side & sill', 1, 9.0, 1.5, 'S'],

  // ---------- Rear quarter ----------
  ['RQ001', 'Rear quarter panel (outer) - section', 'Rear quarter', 1, 8.0, 2.4, 'S'],
  ['RQ002', 'Rear quarter panel (outer) - full', 'Rear quarter', 1, 14.0, 2.8, 'S'],
  ['RQ003', 'Rear wheel-arch liner', 'Rear quarter', 1, 0.4, 0, 'T'],
  ['RQ004', 'Rear wheel-arch moulding / over-fender', 'Rear quarter', 1, 0.4, 0, 'T'],
  ['RQ005', 'Fuel filler flap', 'Rear quarter', 0, 0.2, 0.5, 'P'],
  ['RQ006', 'Fuel filler housing', 'Rear quarter', 0, 0.6, 0, 'T'],
  ['RQ007', 'Rear quarter glass', 'Rear quarter', 1, 1.0, 0, 'G'],
  ['RQ008', 'Rear quarter inner wheel-arch', 'Rear quarter', 1, 6.0, 1.0, 'S'],

  // ---------- Rear end ----------
  ['RE001', 'Rear bumper cover', 'Rear end', 0, 1.4, 2.4, 'P'],
  ['RE002', 'Rear bumper reinforcement', 'Rear end', 0, 0.8, 0, 'S'],
  ['RE003', 'Rear bumper energy absorber', 'Rear end', 0, 0.3, 0, 'T'],
  ['RE004', 'Rear bumper lower diffuser / valance', 'Rear end', 0, 0.4, 0, 'T'],
  ['RE005', 'Rear bumper side bracket / guide', 'Rear end', 1, 0.3, 0, 'T'],
  ['RE006', 'Rear bumper reflector', 'Rear end', 1, 0.1, 0, 'L'],
  ['RE007', 'Rear parking sensor', 'Rear end', 0, 0.3, 0.2, 'E'],
  ['RE008', 'Rear panel / back panel', 'Rear end', 0, 7.0, 2.0, 'S'],
  ['RE009', 'Boot floor (section)', 'Rear end', 0, 6.0, 1.0, 'S'],
  ['RE010', 'Rear number plate', 'Rear end', 0, 0.2, 0, 'T'],
  ['RE011', 'Tow bar assembly', 'Rear end', 0, 1.5, 0, 'M'],
  ['RE012', 'Exhaust tail pipe / rear silencer', 'Rear end', 0, 0.8, 0, 'M'],
  ['RE013', 'Blind-spot radar sensor (rear)', 'Rear end', 1, 0.4, 0, 'A'],

  // ---------- Tailgate / boot ----------
  ['TG001', 'Tailgate / boot lid shell', 'Tailgate / boot', 0, 2.5, 2.6, 'P'],
  ['TG002', 'Tailgate spoiler', 'Tailgate / boot', 0, 0.5, 1.0, 'P'],
  ['TG003', 'Tailgate gas strut', 'Tailgate / boot', 1, 0.1, 0, 'M'],
  ['TG004', 'Tailgate handle / number plate garnish', 'Tailgate / boot', 0, 0.4, 0, 'T'],
  ['TG005', 'Tailgate lock / latch', 'Tailgate / boot', 0, 0.5, 0, 'M'],
  ['TG006', 'Tailgate hinge', 'Tailgate / boot', 1, 0.8, 0.4, 'P'],
  ['TG007', 'Rear camera', 'Tailgate / boot', 0, 0.4, 0, 'E'],
  ['TG008', 'Rear wiper motor', 'Tailgate / boot', 0, 0.4, 0, 'E'],
  ['TG009', 'Tailgate trim panel', 'Tailgate / boot', 0, 0.3, 0, 'T'],
  ['TG010', 'Rear badge / emblem', 'Tailgate / boot', 0, 0.1, 0, 'T'],

  // ---------- Roof ----------
  ['RF001', 'Roof panel', 'Roof', 0, 12.0, 3.0, 'S'],
  ['RF002', 'Sunroof glass', 'Roof', 0, 1.5, 0, 'G'],
  ['RF003', 'Roof aerial / shark fin', 'Roof', 0, 0.5, 0.4, 'E'],
  ['RF004', 'Roof lining (headlining)', 'Roof', 0, 2.0, 0, 'T'],

  // ---------- Glass ----------
  ['GL001', 'Windscreen', 'Glass', 0, 1.5, 0, 'G'],
  ['GL002', 'Front door glass', 'Glass', 1, 0.8, 0, 'G'],
  ['GL003', 'Rear door glass', 'Glass', 1, 0.8, 0, 'G'],
  ['GL004', 'Rear screen / tailgate glass', 'Glass', 0, 1.2, 0, 'G'],
  ['GL005', 'Windscreen camera calibration (static/dynamic)', 'Glass', 0, 1.0, 0, 'A'],

  // ---------- Lighting ----------
  ['LT001', 'Headlamp assembly', 'Lighting', 1, 0.6, 0, 'L'],
  ['LT002', 'Daytime running lamp', 'Lighting', 1, 0.4, 0, 'L'],
  ['LT003', 'Front fog lamp', 'Lighting', 1, 0.3, 0, 'L'],
  ['LT004', 'Rear lamp assembly (body)', 'Lighting', 1, 0.3, 0, 'L'],
  ['LT005', 'Rear lamp assembly (tailgate)', 'Lighting', 1, 0.3, 0, 'L'],
  ['LT006', 'High-level brake lamp', 'Lighting', 0, 0.3, 0, 'L'],
  ['LT007', 'Number plate lamp', 'Lighting', 0, 0.1, 0, 'L'],
  ['LT008', 'Rear fog lamp', 'Lighting', 0, 0.2, 0, 'L'],
  ['LT009', 'Headlamp aim / beam setting', 'Lighting', 0, 0.3, 0, 'A'],
  ['LT010', 'Headlamp levelling sensor', 'Lighting', 0, 0.4, 0, 'E'],

  // ---------- Mirrors ----------
  ['MR001', 'Door mirror assembly', 'Mirrors', 1, 0.6, 0, 'E'],
  ['MR002', 'Door mirror glass', 'Mirrors', 1, 0.2, 0, 'G'],
  ['MR003', 'Door mirror cover / cap', 'Mirrors', 1, 0.2, 0.6, 'P'],
  ['MR004', 'Door mirror indicator / repeater', 'Mirrors', 1, 0.3, 0, 'L'],
  ['MR005', 'Door mirror lower housing', 'Mirrors', 1, 0.4, 0, 'T'],
  ['MR006', 'Door mirror motor / fold unit', 'Mirrors', 1, 0.5, 0, 'E'],

  // ---------- Wheels & tyres ----------
  ['WT001', 'Alloy wheel', 'Wheels & tyres', 1, 0.3, 0, 'W'],
  ['WT002', 'Steel wheel', 'Wheels & tyres', 1, 0.3, 0, 'W'],
  ['WT003', 'Tyre', 'Wheels & tyres', 1, 0.5, 0, 'W'],
  ['WT004', 'TPMS sensor / valve', 'Wheels & tyres', 1, 0.3, 0, 'E'],
  ['WT005', 'Wheel trim / hub cap', 'Wheels & tyres', 1, 0.1, 0, 'T'],
  ['WT006', 'Centre cap', 'Wheels & tyres', 1, 0.1, 0, 'T'],
  ['WT007', 'Wheel bolt / nut set', 'Wheels & tyres', 0, 0.1, 0, 'C'],
  ['WT008', 'Spare wheel / space saver', 'Wheels & tyres', 0, 0.2, 0, 'W'],

  // ---------- Suspension & steering ----------
  ['SU001', 'Front lower control arm', 'Suspension & steering', 1, 0.8, 0, 'M'],
  ['SU002', 'Front shock absorber / strut', 'Suspension & steering', 1, 1.2, 0, 'M'],
  ['SU003', 'Front coil spring', 'Suspension & steering', 1, 0.3, 0, 'M'],
  ['SU004', 'Front hub carrier / knuckle', 'Suspension & steering', 1, 1.5, 0, 'M'],
  ['SU005', 'Front wheel hub / bearing', 'Suspension & steering', 1, 1.0, 0, 'M'],
  ['SU006', 'Track-rod end', 'Suspension & steering', 1, 0.5, 0, 'M'],
  ['SU007', 'Inner track rod', 'Suspension & steering', 1, 0.8, 0, 'M'],
  ['SU008', 'Steering rack', 'Suspension & steering', 0, 3.0, 0, 'M'],
  ['SU009', 'Drive shaft', 'Suspension & steering', 1, 1.0, 0, 'M'],
  ['SU010', 'Anti-roll bar drop link', 'Suspension & steering', 1, 0.3, 0, 'M'],
  ['SU011', 'Front subframe', 'Suspension & steering', 0, 4.0, 0, 'S'],
  ['SU012', 'Rear shock absorber', 'Suspension & steering', 1, 0.6, 0, 'M'],
  ['SU013', 'Rear coil spring', 'Suspension & steering', 1, 0.5, 0, 'M'],
  ['SU014', 'Rear axle beam / twist beam', 'Suspension & steering', 0, 3.5, 0, 'M'],
  ['SU015', 'Rear hub / bearing', 'Suspension & steering', 1, 0.8, 0, 'M'],
  ['SU016', 'Rear trailing / control arm', 'Suspension & steering', 1, 0.8, 0, 'M'],
  ['SU017', 'Four-wheel alignment / geometry', 'Suspension & steering', 0, 1.0, 0, 'A'],
  ['SU018', 'Steering angle sensor calibration', 'Suspension & steering', 0, 0.3, 0, 'A'],

  // ---------- Brakes ----------
  ['BR001', 'Front brake disc', 'Brakes', 1, 0.6, 0, 'M'],
  ['BR002', 'Front brake caliper', 'Brakes', 1, 0.8, 0, 'M'],
  ['BR003', 'Front brake hose', 'Brakes', 1, 0.5, 0, 'M'],
  ['BR004', 'Brake disc backplate / dust shield', 'Brakes', 1, 0.6, 0, 'M'],
  ['BR005', 'ABS wheel-speed sensor', 'Brakes', 1, 0.4, 0, 'E'],
  ['BR006', 'Rear brake disc / drum', 'Brakes', 1, 0.6, 0, 'M'],
  ['BR007', 'Brake fluid bleed', 'Brakes', 0, 0.5, 0, 'M'],

  // ---------- Cooling & A/C ----------
  ['CL001', 'Radiator', 'Cooling & A/C', 0, 1.2, 0, 'M'],
  ['CL002', 'A/C condenser', 'Cooling & A/C', 0, 1.0, 0, 'M'],
  ['CL003', 'Intercooler', 'Cooling & A/C', 0, 1.0, 0, 'M'],
  ['CL004', 'Cooling fan assembly', 'Cooling & A/C', 0, 0.8, 0, 'M'],
  ['CL005', 'Radiator support / cooling pack carrier', 'Cooling & A/C', 0, 1.5, 0, 'S'],
  ['CL006', 'A/C evacuate & recharge', 'Cooling & A/C', 0, 1.0, 0, 'M'],
  ['CL007', 'Coolant drain & refill', 'Cooling & A/C', 0, 0.5, 0, 'M'],
  ['CL008', 'Expansion tank', 'Cooling & A/C', 0, 0.4, 0, 'M'],

  // ---------- Engine bay ----------
  ['EB001', 'Air filter box / intake', 'Engine bay', 0, 0.5, 0, 'M'],
  ['EB002', 'Battery', 'Engine bay', 0, 0.3, 0, 'E'],
  ['EB003', 'Battery tray', 'Engine bay', 0, 0.6, 0, 'T'],
  ['EB004', 'Washer bottle', 'Engine bay', 0, 0.6, 0, 'T'],
  ['EB005', 'Horn', 'Engine bay', 0, 0.3, 0, 'E'],
  ['EB006', 'Engine mounting', 'Engine bay', 1, 1.0, 0, 'M'],
  ['EB007', 'Fuse / relay box', 'Engine bay', 0, 1.0, 0, 'E'],

  // ---------- Electrical & ADAS ----------
  ['EL001', 'Front radar sensor (ACC/AEB)', 'Electrical & ADAS', 0, 0.5, 0, 'A'],
  ['EL002', 'Front radar calibration', 'Electrical & ADAS', 0, 1.0, 0, 'A'],
  ['EL003', 'Front camera calibration', 'Electrical & ADAS', 0, 1.0, 0, 'A'],
  ['EL004', 'Surround-view camera', 'Electrical & ADAS', 1, 0.5, 0, 'A'],
  ['EL005', 'Blind-spot radar calibration', 'Electrical & ADAS', 0, 0.8, 0, 'A'],
  ['EL006', 'Wiring harness repair', 'Electrical & ADAS', 0, 1.0, 0, 'E'],
  ['EL007', 'Pre-repair diagnostic scan', 'Electrical & ADAS', 0, 0.3, 0, 'A'],
  ['EL008', 'Post-repair diagnostic scan', 'Electrical & ADAS', 0, 0.3, 0, 'A'],
  ['EL009', 'Key / immobiliser coding', 'Electrical & ADAS', 0, 0.5, 0, 'E'],

  // ---------- SRS / airbags ----------
  ['SR001', 'Driver airbag', 'SRS / airbags', 0, 0.4, 0, 'E'],
  ['SR002', 'Passenger airbag', 'SRS / airbags', 0, 1.5, 0, 'E'],
  ['SR003', 'Curtain airbag', 'SRS / airbags', 1, 2.5, 0, 'E'],
  ['SR004', 'Seat side airbag', 'SRS / airbags', 1, 1.5, 0, 'E'],
  ['SR005', 'Airbag control module', 'SRS / airbags', 0, 1.0, 0, 'E'],
  ['SR006', 'Seat-belt pretensioner', 'SRS / airbags', 1, 0.8, 0, 'E'],
  ['SR007', 'Crash / impact sensor', 'SRS / airbags', 1, 0.5, 0, 'E'],
  ['SR008', 'Clock spring / spiral cable', 'SRS / airbags', 0, 0.8, 0, 'E'],
  ['SR009', 'Dashboard / instrument panel', 'SRS / airbags', 0, 6.0, 0, 'T'],

  // ---------- Interior ----------
  ['IN001', 'A-pillar trim', 'Interior', 1, 0.3, 0, 'T'],
  ['IN002', 'B-pillar trim', 'Interior', 1, 0.3, 0, 'T'],
  ['IN003', 'Boot side trim', 'Interior', 1, 0.5, 0, 'T'],
  ['IN004', 'Seat (complete)', 'Interior', 1, 0.8, 0, 'T'],
  ['IN005', 'Valet / interior clean', 'Interior', 0, 1.0, 0, 'C'],

  // ---------- Underbody ----------
  ['UB001', 'Underbody protection panel', 'Underbody', 1, 0.4, 0, 'T'],
  ['UB002', 'Fuel tank', 'Underbody', 0, 2.5, 0, 'M'],
  ['UB003', 'Exhaust centre section', 'Underbody', 0, 1.0, 0, 'M'],
  ['UB004', 'Heat shield', 'Underbody', 0, 0.5, 0, 'T'],

  // ---------- Structural ----------
  ['ST001', 'Front chassis leg / rail (section)', 'Structural', 1, 8.0, 1.0, 'S'],
  ['ST002', 'Front inner wing / suspension turret', 'Structural', 1, 10.0, 1.5, 'S'],
  ['ST003', 'A-pillar (section)', 'Structural', 1, 10.0, 1.5, 'S'],
  ['ST004', 'Rear chassis leg (section)', 'Structural', 1, 8.0, 1.0, 'S'],
  ['ST005', 'Floor pan (section)', 'Structural', 0, 8.0, 1.0, 'S'],
  ['ST006', 'Jig / bench set-up and measure', 'Structural', 0, 3.0, 0, 'S'],
  ['ST007', 'Body dimensional check (electronic measure)', 'Structural', 0, 1.5, 0, 'S'],
  ['ST008', 'Crumple box / crash can', 'Structural', 1, 1.5, 0, 'S'],

  // ---------- Fixings & consumables ----------
  ['FX001', 'Retainer / fixing', 'Fixings & consumables', 0, 0.1, 0, 'C'],
  ['FX002', 'Retaining clip', 'Fixings & consumables', 0, 0.1, 0, 'C'],
  ['FX003', 'Adhesive tape / emblem tape', 'Fixings & consumables', 0, 0.1, 0, 'C'],
  ['FX004', 'Seam sealer & cavity wax', 'Fixings & consumables', 0, 0.3, 0, 'C'],
  ['FX005', 'Corrosion-protection application', 'Fixings & consumables', 0, 0.3, 0, 'C'],
  ['FX006', 'Panel-finishing / consumable materials', 'Fixings & consumables', 0, 0, 0, 'C'],
  ['FX007', 'Tyre fitting, balancing & disposal', 'Fixings & consumables', 0, 0, 0, 'C'],
  ['FX008', 'Hazardous waste disposal', 'Fixings & consumables', 0, 0, 0, 'C']
];

/* Standard non-part operations: labour-only lines used in most reports. */
window.LABOUR_OPS = [
  ['OP001', 'Panel restoration / metal finishing', 'Body', 1.5],
  ['OP002', 'Prepare & refinish panel', 'Painting', 1.6],
  ['OP003', 'Blend adjacent panel', 'Painting', 0.9],
  ['OP004', 'Masking, colour matching, spray-out & paint setup', 'Painting', 0.7],
  ['OP005', 'Strip / refit handle, trims & mouldings', 'Auxiliary', 0.6],
  ['OP006', 'Trim removal and concealed-area inspection', 'Auxiliary', 0.5],
  ['OP007', 'Door gaps / flushness / hinge & striker alignment check', 'Body', 0.8],
  ['OP008', 'Wheel / hub / bearing / steering / suspension investigation', 'Mechanical', 1.2],
  ['OP009', 'Wheels remove / refit for inspection', 'Mechanical', 0.6],
  ['OP010', 'Pre-repair diagnostic procedure', 'Auxiliary', 0.3],
  ['OP011', 'Post-repair diagnostic procedure', 'Auxiliary', 0.3],
  ['OP012', 'Four-wheel geometry setup / preparation', 'Auxiliary', 0.4],
  ['OP013', 'Final quality-control inspection & controlled road test', 'Auxiliary', 0.5],
  ['OP014', 'Paintless dent repair (PDR)', 'Body', 1.0],
  ['OP015', 'Smart repair / spot repair', 'Painting', 1.0],
  ['OP016', 'Polish / cut & polish', 'Painting', 0.5],
  ['OP017', 'Cavity wax application', 'Auxiliary', 0.3],
  ['OP018', 'Vehicle wash & valet before handover', 'Auxiliary', 0.5]
];
