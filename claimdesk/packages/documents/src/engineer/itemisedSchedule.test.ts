import { describe, expect, it } from 'vitest';
import { computeSchedule, ESTIMATE_MARK, reconciliationRows, ScheduleError, scheduleRows, type ScheduleLine } from './itemisedSchedule.js';
import { sampleEngineerReport } from './__fixtures__/sample.js';

const line = (o: Partial<ScheduleLine>): ScheduleLine => ({ description: 'Item', operation: 'repair', labourCategory: 'body', labourHours: 0, partPricePence: 0, paintMaterialsPence: 0, source: 'manual', verified: true, ...o });

describe('computeSchedule', () => {
  it('reconciles the sample: category rows, 08 values and 09 totals', () => {
    const d = sampleEngineerReport();
    const s = computeSchedule(d.repair.lines, d.repair.otherItems);
    expect(s.labourRatePence).toBe(7250);
    expect(s.vatRatePercent).toBe(20);
    expect(s.categories.body).toEqual({ hours: 3.5, labourPence: 25_375, materialPence: 30_485 });
    expect(s.categories.mechanical).toEqual({ hours: 1.1, labourPence: 7_975, materialPence: 0 });
    expect(s.categories.auxiliary).toEqual({ hours: 1.0, labourPence: 7_250, materialPence: 68_722 });
    expect(s.categories.paint).toEqual({ hours: 4.2, labourPence: 30_450, materialPence: 16_270 });
    expect(s.totals).toEqual({
      partsPence: 99_207,
      labourPence: 40_600,
      paintPence: 46_720,
      otherPence: 16_350,
      materialPence: 115_557,
      paintMaterialsPence: 16_270,
      subtotalPence: 202_877,
      discountPence: 0,
      netPence: 202_877,
      vatPence: 40_575,
      totalPence: 243_452
    });
    // 09 identities: Labour = Σ labour (non-paint rows); Material = Σ material (non-paint rows) + other; Paint = painting row
    const c = s.categories;
    expect(c.body.labourPence + c.mechanical.labourPence + c.auxiliary.labourPence).toBe(s.totals.labourPence);
    expect(c.body.materialPence + c.mechanical.materialPence + c.auxiliary.materialPence + s.other.materialPence).toBe(s.totals.materialPence);
    expect(c.paint.labourPence + c.paint.materialPence).toBe(s.totals.paintPence);
    expect(s.totals.labourPence + s.totals.materialPence + s.totals.paintPence - s.totals.discountPence).toBe(s.totals.netPence);
    // the line totals add up to the subtotal
    expect(s.lines.reduce((a, l) => a + l.lineTotalPence, 0) + s.other.materialPence).toBe(s.totals.subtotalPence);
    expect(s.unverifiedCount).toBe(3);
  });

  it('applies a labour rate, discount and VAT rate; rounds line labour to the penny', () => {
    const s = computeSchedule([line({ labourHours: 1.333, partPricePence: 10_000 }), line({ labourCategory: 'paint', operation: 'paint', labourHours: 0.5, paintMaterialsPence: 2_000 })], [], { labourRatePence: 6_000, discountPercent: 10, vatRatePercent: 20 });
    expect(s.lines[0]!.labourHours).toBe(1.33);
    expect(s.lines[0]!.labourPence).toBe(7_980);
    expect(s.totals.subtotalPence).toBe(10_000 + 7_980 + 3_000 + 2_000);
    expect(s.totals.discountPence).toBe(2_298);
    expect(s.totals.netPence).toBe(20_682);
    expect(s.totals.vatPence).toBe(4_136);
    expect(s.totals.totalPence).toBe(24_818);
  });

  it('marks every unverified line and other item as an estimate', () => {
    const s = computeSchedule([line({ verified: false, source: 'ai_estimate' }), line({})], [{ description: 'Calibration', amountPence: 100, source: 'ai_estimate', verified: false }]);
    const rows = scheduleRows(s);
    expect(rows.lines.map((r) => r.cells[12])).toEqual([ESTIMATE_MARK, 'Verified', ESTIMATE_MARK]);
    expect(rows.lines.map((r) => r.estimate)).toEqual([true, false, true]);
    expect(rows.totals[12]).toBe('2 to confirm');
    expect(reconciliationRows(s).at(-1)).toEqual(['TOTAL REPAIR COST incl. VAT', '£1.20']);
  });

  it('refuses bad input', () => {
    expect(() => computeSchedule([line({ description: ' ' })])).toThrow(ScheduleError);
    expect(() => computeSchedule([line({ partPricePence: 12.5 })])).toThrow(/whole number of pence/);
    expect(() => computeSchedule([line({ labourHours: -1 })])).toThrow(/hours/);
    expect(() => computeSchedule([line({ operation: 'weld' as never })])).toThrow(/operation/);
    expect(() => computeSchedule([line({})], [], { vatRatePercent: 120 })).toThrow(/VAT/);
  });
});
