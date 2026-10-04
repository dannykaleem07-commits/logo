import { describe, it, expect } from 'vitest';
import { mapDvsaMotHistory, registrationFormat } from './index.js';

describe('PROBE vehicle', () => {
  it('V1 dotted completedDate (legacy TAPI shape) is not silently dropped', () => {
    const r = mapDvsaMotHistory({ motTests: [{ completedDate: '2026.03.01 10:15:00', testResult: 'PASSED', odometerValue: '61200', odometerUnit: 'mi', odometerResultType: 'READ', defects: [] }] });
    console.log('V1', r);
    expect(r.motHistory).toHaveLength(1);
  });
  it('V2 Q plate', () => {
    console.log('V2', registrationFormat('Q123 ABC'));
    expect(registrationFormat('Q123 ABC')).not.toBe('invalid');
  });
});
