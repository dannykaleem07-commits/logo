import { describe, expect, it } from 'vitest';
import { docx, heading, labelCell, p, pt, r, tbl, tc, tr, valueCell } from '../__fixtures__/build.js';
import { scanDocx } from '../scan.js';
import { suggestMapping } from './automap.js';
import { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes, builtinMapping } from './builtin/index.js';
import { resolveSelectors } from './mapping.js';

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

  it('an uploaded letter: client name, claim reference and our handler map to the right fields', () => {
    const scanL = scanDocx(
      docx(
        [
          pt('[Date]'),
          pt('Dear [Client name],'),
          pt('Your vehicle [Registration] was damaged on [Date of accident].'),
          tbl([tr([labelCell('Claim reference'), valueCell()]), tr([labelCell('Client name'), valueCell()])], [2300, 2500]),
          pt('Your handler is [Handler name].')
        ].join('')
      )
    );
    const s = suggestMapping(scanL);
    const key = (label: string) => s.entries.find((e) => e.slotId === scanL.slots.find((x) => x.label === label)?.id)?.key;
    expect(key('Claim reference')).toBe('claim.reference');
    expect(key('Handler name')).toBe('handler.caseHandler');
    expect(s.entries.find((e) => e.slotId === scanL.slots.find((x) => x.label === 'Client name')?.id)).toMatchObject({ key: 'claimant.name', score: 1 });
  });

  it('on the ten CCGUK templates (as if uploaded) no accepted suggestion puts one party’s detail in another’s box', () => {
    const PARTIES = ['claimant', 'witness', 'handler', 'recipient', 'vehicle', 'hireVehicle', 'tp', 'tpInsurer', 'ownInsurer'];
    const party = (k: string) => k.split('.')[0]!;
    const crossed: string[] = [];
    for (const t of BUILTIN_DOCX_TEMPLATES) {
      const scanT = scanDocx(builtinAssetBytes(t.id));
      const { bySlot } = resolveSelectors(builtinMapping(t.id), scanT);
      for (const e of suggestMapping(scanT).entries) {
        const cur = bySlot.get(e.slotId);
        if (!e.key || !cur) continue;
        // a box signed or dated by hand never gets a value
        if (cur.policy === 'signature') crossed.push(`${t.id} ${e.slotId}: ${e.key} in a signature box`);
        if (!cur.key || cur.key === e.key) continue;
        const a = party(e.key);
        const b = party(cur.key);
        if (a !== b && PARTIES.includes(a) && PARTIES.includes(b)) crossed.push(`${t.id} ${e.slotId}: ${e.key} instead of ${cur.key}`);
        // today's date is never the accident date
        if ((e.key === 'doc.date' || e.key === 'doc.dateToday') && b === 'accident') crossed.push(`${t.id} ${e.slotId}: ${e.key} instead of ${cur.key}`);
      }
    }
    expect(crossed).toEqual([]);
  });
});
