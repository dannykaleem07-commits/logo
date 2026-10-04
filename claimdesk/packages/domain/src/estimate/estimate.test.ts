import { describe, it, expect } from 'vitest';
import type { Estimate, EstimateLine } from '../types.js';
import { computeTotals, computeTotalsDetailed, lineAmount, reconcile, type EstimateInput } from './totals.js';
import { parseEstimateText, parseEstimateLine, tokeniseLine, canonicalOperation } from './parser.js';
import { LabourLibrary } from './library.js';
import { summariseLines, paintMaterialsBasis } from './summarise.js';

// ---------------------------------------------------------------------------
// Fixture: labour £48/hr, paint £48/hr, paint materials £28 per paint hour, VAT 20%.
// ---------------------------------------------------------------------------

function line(id: string, over: Partial<EstimateLine> & Pick<EstimateLine, 'kind' | 'operation'>): EstimateLine {
  return { id, description: `${over.operation} ${over.panel ?? ''}`.trim(), quantity: 1, source: 'manual', confirmedByEngineer: true, ...over };
}

const lines: EstimateLine[] = [
  line('L1', { kind: 'labour', operation: 'Replace', panel: 'Front bumper', hours: 1.2 }), // 1.2 × £48 = £57.60
  line('L2', { kind: 'labour', operation: 'Repair', panel: 'NSF wing', hours: 2.5 }), // 2.5 × £48 = £120.00
  line('P1', { kind: 'part', operation: 'Replace', panel: 'Front bumper', partNumber: '5Q0807221', unitPence: 24_560, quantity: 1 }), // £245.60
  line('P2', { kind: 'part', operation: 'Replace', panel: 'Clips', unitPence: 120, quantity: 10 }), // £12.00
  line('PA1', { kind: 'paint', operation: 'Refinish', panel: 'Front bumper', hours: 2.0, materialsPence: 5_000 }), // £96.00 labour; per_hour materials 2.0 × £28 = £56.00
  line('PA2', { kind: 'paint', operation: 'Blend', panel: 'NSF door', hours: 1.5, materialsPence: 3_500 }), // £72.00 labour; materials 1.5 × £28 = £42.00
  line('A1', { kind: 'adas', operation: 'Calibrate', panel: 'Front camera', hours: 1.0, unitPence: 15_000 }), // £48 + £150 = £198.00
  line('X1', { kind: 'labour', operation: 'Repair', panel: 'Rear bumper scuff', hours: 1.0, preExisting: true }), // £48.00 excluded
  line('X2', { kind: 'part', operation: 'Replace', panel: 'Rear bumper trim', unitPence: 6_000, preExisting: true }), // £60.00 excluded
];

const estimate: EstimateInput = {
  id: 'est-1',
  claimId: 'claim-1',
  vehicleId: 'veh-1',
  lines,
  labourRatePence: 4_800,
  paintRatePence: 4_800,
  paintMaterialsMethod: 'per_hour',
  paintMaterialsPerHourPence: 2_800,
  vatRate: 0.2,
  createdAt: '2026-10-04T09:00:00Z',
};

describe('computeTotals', () => {
  it('totals every head, excludes pre-existing lines from the net and charges VAT on the net', () => {
    const t = computeTotals(estimate);
    expect(t.labourPence).toBe(17_760); // £57.60 + £120.00
    expect(t.partsPence).toBe(25_760); // £245.60 + £12.00
    expect(t.paintLabourPence).toBe(16_800); // £96.00 + £72.00
    expect(t.paintMaterialsPence).toBe(9_800); // £56.00 + £42.00 (per hour; the line figures are ignored)
    expect(t.otherPence).toBe(19_800); // ADAS £48.00 + £150.00
    expect(t.preExistingExcludedPence).toBe(10_800); // £48.00 + £60.00
    expect(t.netPence).toBe(89_920);
    expect(t.vatPence).toBe(17_984);
    expect(t.grossPence).toBe(107_904);
    expect(t.labourHours).toBe(3.7); // pre-existing hour not counted
    expect(t.paintHours).toBe(3.5);
  });
  it('paint_system method uses the line materials figures', () => {
    const t = computeTotals({ ...estimate, paintMaterialsMethod: 'paint_system' });
    expect(t.paintMaterialsPence).toBe(8_500); // £50.00 + £35.00
    expect(t.netPence).toBe(89_920 - 9_800 + 8_500);
  });
  it('fixed method behaves like paint_system for materials', () => {
    const t = computeTotals({ ...estimate, paintMaterialsMethod: 'fixed' });
    expect(t.paintMaterialsPence).toBe(8_500);
  });
  it('per_hour method without a rate counts the line figure and warns', () => {
    const d = computeTotalsDetailed({ ...estimate, paintMaterialsPerHourPence: undefined });
    expect(d.totals.paintMaterialsPence).toBe(8_500);
    expect(d.warnings.some((w) => w.includes('no per-hour materials rate'))).toBe(true);
  });
  it('a line rate overrides the estimate rate', () => {
    const la = lineAmount(line('L9', { kind: 'labour', operation: 'Repair', hours: 2, ratePence: 6_000 }), estimate);
    expect(la.labourPence).toBe(12_000);
    expect(la.ratePence).toBe(6_000);
  });
  it('hours on a part line are costed as labour; explicit materials lines go to paint materials', () => {
    const p = lineAmount(line('P9', { kind: 'part', operation: 'Replace', unitPence: 10_000, quantity: 2, hours: 0.5 }), estimate);
    expect(p.partsPence).toBe(20_000);
    expect(p.labourPence).toBe(2_400);
    expect(p.amountPence).toBe(22_400);
    const m = lineAmount(line('M1', { kind: 'materials', operation: 'Other', materialsPence: 1_500 }), estimate);
    expect(m.paintMaterialsPence).toBe(1_500);
  });
  it('rounds hours × rate to the penny', () => {
    const la = lineAmount(line('L8', { kind: 'labour', operation: 'Repair', hours: 0.33, ratePence: 4_800 }), estimate);
    expect(la.labourPence).toBe(1_584); // 0.33 × 4800 = 1584
    const lb = lineAmount(line('L7', { kind: 'labour', operation: 'Repair', hours: 1.15, ratePence: 4_567 }), estimate);
    expect(lb.labourPence).toBe(5_252); // 5252.05 → 5252
  });
  it('an empty estimate totals zero', () => {
    const t = computeTotals({ ...estimate, lines: [] });
    expect(t.netPence).toBe(0);
    expect(t.grossPence).toBe(0);
  });
});

describe('reconcile', () => {
  it('reconciles an exact net match', () => {
    const r = reconcile(estimate, 89_920);
    expect(r.reconciled).toBe(true);
    expect(r.basis).toBe('net');
    expect(r.differencePence).toBe(0);
    expect(r.message).toContain('Reconciled: imported total £899.20 agrees with our net of VAT (claimable lines) total £899.20');
  });
  it('tolerates ±£1.00 by default and fails at £1.01', () => {
    expect(reconcile(estimate, 90_020).reconciled).toBe(true); // we are £1.00 under the import
    expect(reconcile(estimate, 90_020).differencePence).toBe(-100);
    expect(reconcile(estimate, 89_820).reconciled).toBe(true);
    const r = reconcile(estimate, 90_021);
    expect(r.reconciled).toBe(false);
    expect(r.differencePence).toBe(-101);
    expect(r.message).toContain('Not reconciled: imported total £900.21 differs from our net total £899.20 by -£1.01');
    expect(r.message).toContain('gross would be £1,079.04');
  });
  it('matches on gross when the import includes VAT', () => {
    const r = reconcile(estimate, 107_904);
    expect(r.reconciled).toBe(true);
    expect(r.basis).toBe('gross');
    expect(r.message).toContain('appears to be stated on that basis');
  });
  it('matches on net including pre-existing lines when the bodyshop priced everything', () => {
    const r = reconcile(estimate, 100_720); // 89,920 + 10,800
    expect(r.reconciled).toBe(true);
    expect(r.basis).toBe('net_all_lines');
    const g = reconcile(estimate, 120_864); // 100,720 × 1.2
    expect(g.basis).toBe('gross_all_lines');
  });
  it('honours a custom tolerance', () => {
    expect(reconcile(estimate, 89_930, 5).reconciled).toBe(false);
    expect(reconcile(estimate, 89_925, 5).reconciled).toBe(true);
  });
});

describe('parseEstimateText', () => {
  const text = `
Operation   Description            Part No      Hrs    Price
Replace     Front bumper cover     5Q0807221    1.20   £245.60
Repair      NSF wing                            2.50
Refinish    Front bumper                        2.00   £48.00
Blend       NSF door                            1.50
R&I         Headlamp NSF                        0.50
Calibrate   Front camera ADAS                   1.00   £150.00
Replace     Clips 2 x £1.20  N90833801
Strip & Refit  Front grille                     0.3 hrs
Diagnostic scan                                        £45.00
Paint materials                                        £86.40
Sub-total                                              £1,234.56
VAT @ 20%                                              £246.91
Total                                                  £1,481.47
`;

  it('recognises operations', () => {
    expect(canonicalOperation('Replace front bumper')).toBe('Replace');
    expect(canonicalOperation('Strip & refit grille')).toBe('Strip/Refit');
    expect(canonicalOperation('R&R headlamp')).toBe('R&R');
    expect(canonicalOperation('R&I headlamp')).toBe('R&I');
    expect(canonicalOperation('Calibrate camera')).toBe('Calibrate');
    expect(canonicalOperation('Refinish door')).toBe('Refinish');
    expect(canonicalOperation('Blend wing')).toBe('Blend');
    expect(canonicalOperation('Repair dent')).toBe('Repair');
    expect(canonicalOperation('Lunch')).toBeUndefined();
  });

  it('tokenises part numbers, hours, prices and quantities', () => {
    const t = tokeniseLine('Replace     Front bumper cover     5Q0807221    1.20   £245.60');
    expect(t.operation).toBe('Replace');
    expect(t.partNumber).toBe('5Q0807221');
    expect(t.hours).toBe(1.2);
    expect(t.pricesPence).toEqual([24_560]);
    expect(t.quantity).toBe(1);
    const q = tokeniseLine('Replace Clips 2 x £1.20 N90833801');
    expect(q.quantity).toBe(2);
    expect(q.pricesPence).toEqual([120]);
    expect(q.partNumber).toBe('N90833801');
    const h = tokeniseLine('Strip & Refit Front grille 0.3 hrs');
    expect(h.hours).toBe(0.3);
    expect(h.operation).toBe('Strip/Refit');
    // a bare 2-dp figure ≥ £20 next to a part number is a price, not hours
    const p = tokeniseLine('Replace mirror glass 8E0857535 45.00');
    expect(p.hours).toBeUndefined();
    expect(p.pricesPence).toEqual([4_500]);
  });

  it('splits an Audatex line with part and hours into a part line and a labour line', () => {
    const out = parseEstimateLine('Replace     Front bumper cover     5Q0807221    1.20   £245.60', 2);
    expect(out).toHaveLength(2);
    const [part, labour] = out as [EstimateLine, EstimateLine];
    expect(part.kind).toBe('part');
    expect(part.partNumber).toBe('5Q0807221');
    expect(part.unitPence).toBe(24_560);
    expect(part.quantity).toBe(1);
    expect(part.panel).toBe('Front bumper cover');
    expect(part.source).toBe('import');
    expect(part.confirmedByEngineer).toBe(false);
    expect(labour.kind).toBe('labour');
    expect(labour.hours).toBe(1.2);
    expect(labour.id).toBe('import-2b');
  });

  it('parses the whole extract, classifying kinds and skipping totals', () => {
    const out = parseEstimateText(text);
    const kinds = out.map((l) => `${l.kind}:${l.operation}`);
    expect(kinds).toEqual([
      'part:Replace',
      'labour:Replace',
      'labour:Repair',
      'paint:Refinish',
      'paint:Blend',
      'labour:R&I',
      'adas:Calibrate',
      'part:Replace',
      'labour:Strip/Refit',
      'diagnostic:Diagnose',
      'materials:Refinish',
    ]);
    expect(out.every((l) => l.source === 'import' && l.confirmedByEngineer === false)).toBe(true);
    const repair = out.find((l) => l.operation === 'Repair')!;
    expect(repair.hours).toBe(2.5);
    expect(repair.panel).toBe('NSF wing');
    const refinish = out.find((l) => l.operation === 'Refinish' && l.kind === 'paint')!;
    expect(refinish.hours).toBe(2);
    expect(refinish.materialsPence).toBe(4_800);
    const adas = out.find((l) => l.kind === 'adas')!;
    expect(adas.hours).toBe(1);
    expect(adas.unitPence).toBe(15_000);
    const clips = out.filter((l) => l.kind === 'part')[1]!;
    expect(clips.quantity).toBe(2);
    expect(clips.unitPence).toBe(120);
    expect(clips.partNumber).toBe('N90833801');
    const diag = out.find((l) => l.kind === 'diagnostic')!;
    expect(diag.unitPence).toBe(4_500);
    const mats = out.find((l) => l.kind === 'materials')!;
    expect(mats.materialsPence).toBe(8_640);
  });

  it('ignores blank, header and total lines', () => {
    expect(parseEstimateText('\n\nTotal £100.00\nVAT £20.00\nDescription Qty Price\n')).toEqual([]);
  });

  it('a parsed import totals correctly through computeTotals', () => {
    const imported = parseEstimateText(text);
    const t = computeTotals({ ...estimate, lines: imported, paintMaterialsMethod: 'paint_system' });
    // labour: 1.2 + 2.5 + 0.5 + 0.3 = 4.5 hrs × £48 = £216.00
    expect(t.labourHours).toBe(4.5);
    expect(t.labourPence).toBe(21_600);
    // parts: £245.60 + 2 × £1.20 = £248.00
    expect(t.partsPence).toBe(24_800);
    // paint: 3.5 hrs × £48 = £168.00; materials £48.00 + £86.40 = £134.40
    expect(t.paintLabourPence).toBe(16_800);
    expect(t.paintMaterialsPence).toBe(13_440);
    // other: ADAS £48 + £150 = £198.00; diagnostic £45.00
    expect(t.otherPence).toBe(24_300);
  });
});

describe('LabourLibrary', () => {
  const approved = { make: 'Volkswagen', model: 'Golf', panel: 'Front bumper', operation: 'Replace', approvedBy: 'eng-1' };

  it('refuses unapproved or malformed entries', () => {
    const lib = new LabourLibrary();
    expect(lib.add({ ...approved, hours: 1.2, approvedBy: '' }).added).toBe(false);
    expect(lib.add({ ...approved, hours: 0 }).added).toBe(false);
    expect(lib.add({ ...approved, hours: 1.2, panel: '' }).reason).toBe('panel is required');
    expect(lib.size).toBe(0);
  });

  it('median needs three observations and is case/whitespace insensitive', () => {
    const lib = new LabourLibrary();
    lib.add({ ...approved, hours: 1.2 });
    lib.add({ ...approved, hours: 1.4 });
    expect(lib.median('Volkswagen', 'Golf', 'Front bumper', 'Replace')).toBeNull();
    lib.add({ ...approved, hours: 1.0 });
    expect(lib.median('volkswagen', 'GOLF', ' front  bumper ', 'replace')).toEqual({ hours: 1.2, n: 3 });
    lib.add({ ...approved, hours: 2.0 });
    expect(lib.median('Volkswagen', 'Golf', 'Front bumper', 'Replace')).toEqual({ hours: 1.3, n: 4 }); // (1.2 + 1.4) / 2
  });

  it('suggests hours per line and reports the difference', () => {
    const lib = new LabourLibrary();
    [1.2, 1.4, 1.0].forEach((h) => lib.add({ ...approved, hours: h }));
    const s = lib.suggest('Volkswagen', 'Golf', [
      line('L1', { kind: 'labour', operation: 'Replace', panel: 'Front bumper', hours: 1.5 }),
      line('L2', { kind: 'labour', operation: 'Repair', panel: 'NSF wing', hours: 2.5 }),
      line('P1', { kind: 'part', operation: 'Replace', panel: 'Front bumper', unitPence: 100 }),
    ]);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ lineId: 'L1', suggestedHours: 1.2, n: 3, differenceHours: 0.3 });
    expect(s[0]!.note).toContain('0.3 hrs above the median');
    expect(s[1]).toMatchObject({ lineId: 'L2', suggestedHours: null, n: 0 });
  });

  it('only takes confirmed, non-pre-existing labour/paint lines from an approved estimate', () => {
    const lib = new LabourLibrary();
    const unapproved: Estimate = { ...estimate, totals: computeTotals(estimate) };
    expect(lib.addFromEstimate(unapproved, { make: 'Volkswagen', model: 'Golf' }).added).toBe(0);
    const approvedEst: Estimate = { ...unapproved, approvedBy: 'eng-1' };
    const r = lib.addFromEstimate(approvedEst, { make: 'Volkswagen', model: 'Golf' }, '2026-10-04T10:00:00Z');
    // L1, L2, PA1, PA2 qualify; X1 is pre-existing; parts and ADAS are not labour times
    expect(r.added).toBe(4);
    expect(lib.entries().every((e) => e.approvedBy === 'eng-1' && e.estimateId === 'est-1')).toBe(true);
  });

  it('exports and imports JSON', () => {
    const lib = new LabourLibrary();
    [1.2, 1.4, 1.0].forEach((h) => lib.add({ ...approved, hours: h }));
    const json = lib.export();
    const copy = LabourLibrary.fromJSON(json);
    expect(copy.size).toBe(3);
    expect(copy.median('Volkswagen', 'Golf', 'Front bumper', 'Replace')).toEqual({ hours: 1.2, n: 3 });
    expect(() => LabourLibrary.fromJSON('{"version":2}')).toThrow();
  });
});

describe('summariseLines', () => {
  it('separates pre-existing lines, totals by kind and states the basis', () => {
    const s = summariseLines(estimate);
    expect(s.lines.map((l) => l.id)).toEqual(['L1', 'L2', 'P1', 'P2', 'PA1', 'PA2', 'A1']);
    expect(s.preExistingLines.map((l) => l.id)).toEqual(['X1', 'X2']);
    expect(s.byKind.labour).toBe(17_760);
    expect(s.byKind.part).toBe(25_760);
    expect(s.byKind.paint).toBe(26_600); // paint labour £168 + materials £98
    expect(s.byKind.adas).toBe(19_800);
    expect(s.totals.netPence).toBe(89_920);
    expect(s.basisStatement).toBe('Labour 3.70 hrs at £48.00 per hour; paint 3.50 hrs at £48.00 per hour; paint materials at £28.00 per paint hour; VAT at 20% on the net.');
    expect(s.preExistingStatement).toBe('2 line(s) totalling £108.00 relate to pre-existing damage; they are shown separately and are not claimed.');
    expect(s.unconfirmedCount).toBe(0);
    expect(s.lines.find((l) => l.id === 'A1')?.amountPence).toBe(19_800);
  });
  it('paint materials basis wording per method', () => {
    expect(paintMaterialsBasis({ paintMaterialsMethod: 'paint_system' })).toContain('paint-maker system');
    expect(paintMaterialsBasis({ paintMaterialsMethod: 'fixed' })).toContain('fixed figures');
    expect(paintMaterialsBasis({ paintMaterialsMethod: 'per_hour' })).toContain('rate not set');
  });
  it('counts unconfirmed imported lines', () => {
    const s = summariseLines({ ...estimate, lines: parseEstimateText('Repair NSF wing 2.50') });
    expect(s.unconfirmedCount).toBe(1);
    expect(s.importedCount).toBe(1);
    expect(s.warnings.some((w) => w.includes('not been confirmed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial verification: real PDF header text that must NOT become repair lines, discount lines
// whose sign must survive, and a basis statement that must agree with the arithmetic.
// ---------------------------------------------------------------------------

describe('adversarial: header and identity text from an estimate PDF', () => {
  it('produces no lines from dates, vehicle descriptions, registration, VIN, phone and reference numbers', () => {
    const header = [
      'Date: 04/10/2026',
      'Estimate date 04.10.26  Time 10:30',
      'Vehicle: Volkswagen Golf 2019 1.5 TSI Match',
      'Reg AB19CDE',
      'Registration AB19 CDE',
      'VIN WVWZZZ1KZAW000001',
      'Tel 02012345678',
      'Estimate No 12345678  Claim ref ABC123456',
      'Mileage 48,120',
      'Policy No 9876543210',
    ].join('\n');
    expect(parseEstimateText(header)).toEqual([]);
  });

  it('a date on a genuine line does not become a price or a quantity', () => {
    const out = parseEstimateLine('Replace Front bumper cover 5Q0807221 1.20 £245.60 04/10/2026', 1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'part', partNumber: '5Q0807221', unitPence: 24_560, quantity: 1 });
    expect(out[1]).toMatchObject({ kind: 'labour', hours: 1.2 });
  });

  it('genuine lines without an operation word still parse when they carry a part number, a £ price or explicit hours', () => {
    expect(parseEstimateLine('Front bumper cover 5Q0807221 1.20 245.60', 1).map((l) => `${l.kind}:${l.unitPence ?? ''}:${l.hours ?? ''}`)).toEqual(['part:24560:', 'labour::1.2']);
    expect(parseEstimateLine('Environmental waste disposal 15.00', 2)).toMatchObject([{ kind: 'sundry', unitPence: 1_500 }]);
    expect(parseEstimateLine('Headlamp NSF 1.50 hrs', 3)).toMatchObject([{ kind: 'labour', hours: 1.5 }]);
    expect(parseEstimateLine('Headlamp NSF £320.00', 4)).toMatchObject([{ kind: 'part', unitPence: 32_000 }]);
    // a bare figure with no £, no hrs, no part number and no operation is not an estimate line
    expect(parseEstimateLine('Headlamp NSF 1.50', 5)).toEqual([]);
  });
});

describe('adversarial: discounts and credits keep their sign', () => {
  it('"-£50.00", "(£50.00)" and "Less discount £50.00" all parse as a −£50.00 sundry', () => {
    for (const text of ['Less discount -£50.00', 'Discount (£50.00)', 'Less discount £50.00', 'Credit note £-50.00']) {
      const out = parseEstimateLine(text, 1);
      expect(out, text).toHaveLength(1);
      expect(out[0], text).toMatchObject({ kind: 'sundry', unitPence: -5_000, quantity: 1 });
    }
  });

  it('a parsed discount reduces the net and reconciles against the bodyshop total that nets it off', () => {
    const text = ['Repair NSF wing 2.50', 'Replace Front bumper cover 5Q0807221 1.20 £245.60', 'Less discount -£50.00'].join('\n');
    const imported = parseEstimateText(text);
    const est: EstimateInput = { ...estimate, lines: imported };
    const t = computeTotals(est);
    // labour (2.5 + 1.2) × £48 = £177.60; parts £245.60; other −£50.00 → net £373.20
    expect(t.labourPence).toBe(17_760);
    expect(t.partsPence).toBe(24_560);
    expect(t.otherPence).toBe(-5_000);
    expect(t.netPence).toBe(37_320);
    expect(reconcile(est, 37_320).reconciled).toBe(true);
    // had the sign been dropped the net would read £473.20 and the import would NOT reconcile
    expect(reconcile(est, 47_320).reconciled).toBe(false);
  });
});

describe('adversarial: basis statement agrees with the arithmetic', () => {
  it('names per-line rate overrides instead of claiming every hour was at the estimate rate', () => {
    const s = summariseLines({
      ...estimate,
      lines: [
        line('L1', { kind: 'labour', operation: 'Replace', panel: 'Front bumper', hours: 1.2 }), // £48
        line('L2', { kind: 'labour', operation: 'Repair', panel: 'Roof', hours: 2, ratePence: 6_000 }), // specialist £60
        line('PA1', { kind: 'paint', operation: 'Refinish', panel: 'Front bumper', hours: 2.0 }),
      ],
    });
    // 1.2 × 4800 + 2 × 6000 = 5,760 + 12,000 = 17,760
    expect(s.totals.labourPence).toBe(17_760);
    expect(s.basisStatement).toContain('Labour 3.20 hrs at £48.00 per hour except 1 line(s) at the rate stated on the line');
    expect(s.basisStatement).toContain('paint 2.00 hrs at £48.00 per hour;');
    // the unchanged case keeps the plain wording
    expect(summariseLines(estimate).basisStatement).toContain('Labour 3.70 hrs at £48.00 per hour; paint');
  });
});
