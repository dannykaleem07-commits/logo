import { describe, expect, it } from 'vitest';
import { docx, heading, labelCell, p, pt, r, tbl, tc, tr, valueCell } from '../__fixtures__/build.js';
import { scanDocx } from '../scan.js';
import { suggestMapping } from './automap.js';
import { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes } from './builtin/index.js';

function synthetic(): Uint8Array {
  return docx(
    [
      heading('01', 'Client details'),
      tbl([tr([labelCell('Client full name'), valueCell()]), tr([labelCell('Date of birth'), valueCell()])], [2300, 2500]),
      heading('02', 'Replacement vehicle'),
      tbl([tr([labelCell('Registration'), valueCell()])], [2300, 2500]),
      pt('Our reference {{claim.reference}} and {{unknown.key}}'),
      tbl([tr([tc([p(r('Signature', { b: true })), p('', { bottomBorder: true })], { w: 4800 })])], [4800])
    ].join('')
  );
}

describe('suggestMapping (§B.8)', () => {
  const scan = scanDocx(synthetic());
  const { entries, unmapped } = suggestMapping(scan);
  const byLabel = (label: string) => {
    const s = scan.slots.find((x) => x.label === label);
    if (!s) throw new Error(`no slot ${label}: ${scan.slots.map((x) => x.id).join(', ')}`);
    return entries.find((e) => e.slotId === s.id)!;
  };

  it('maps labels to fields by synonym', () => {
    expect(byLabel('Client full name')).toMatchObject({ key: 'claimant.name', policy: 'auto', score: 1 });
    expect(byLabel('Date of birth')).toMatchObject({ key: 'claimant.dateOfBirth', policy: 'auto-if-known' });
  });

  it('uses the section context: Registration under "Replacement vehicle" is the hire vehicle', () => {
    const e = byLabel('Registration');
    expect(e.key).toBe('hireVehicle.registration');
    expect(e.score).toBeGreaterThanOrEqual(0.75);
    expect(e.reason).toMatch(/context/);
  });

  it('maps known tokens exactly and leaves unknown tokens unmapped', () => {
    const tokens = scan.slots.filter((s) => s.kind === 'token');
    expect(tokens.map((s) => s.token?.key).sort()).toEqual(['claim.reference', 'unknown.key']);
    const known = entries.find((e) => e.slotId === tokens.find((s) => s.token?.key === 'claim.reference')!.id)!;
    expect(known).toMatchObject({ key: 'claim.reference', score: 1, policy: 'auto' });
    const unknownSlot = tokens.find((s) => s.token?.key === 'unknown.key')!;
    expect(unmapped).toContain(unknownSlot.id);
    expect(entries.find((e) => e.slotId === unknownSlot.id)).toMatchObject({ reason: 'UNKNOWN_TOKEN', policy: 'handler' });
    expect(entries.find((e) => e.slotId === unknownSlot.id)?.key).toBeUndefined();
  });

  it('a Signature line gets policy signature and no key', () => {
    const sig = scan.slots.find((s) => s.signature);
    expect(sig).toBeDefined();
    const e = entries.find((x) => x.slotId === sig!.id)!;
    expect(e.policy).toBe('signature');
    expect(e.key).toBeUndefined();
  });

  it('every slot gets exactly one suggestion; unmapped ones say why', () => {
    expect(entries.map((e) => e.slotId).sort()).toEqual(scan.slots.map((s) => s.id).sort());
    for (const id of unmapped) expect(entries.find((e) => e.slotId === id)?.key).toBeUndefined();
  });

  it('on a real CCGUK form it maps the obvious client fields and never maps a signature', () => {
    const real = scanDocx(builtinAssetBytes(BUILTIN_DOCX_TEMPLATES.find((t) => t.id === 'form.ccguk_05_payment_direction')!.id));
    const s = suggestMapping(real);
    const get = (id: string) => s.entries.find((e) => e.slotId === id);
    expect(get('01-claim-and-client-details/client-full-name')?.key).toBe('claimant.name');
    expect(get('01-claim-and-client-details/third-party-insurer')?.key).toBe('tpInsurer.name');
    for (const sl of real.slots.filter((x) => x.signature)) expect(get(sl.id)).toMatchObject({ policy: 'signature' });
  });
});
