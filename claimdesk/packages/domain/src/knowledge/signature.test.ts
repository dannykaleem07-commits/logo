// owned by knowledge-learners
import { describe, expect, it } from 'vitest';
import { classifySender, extractSignature, parseSignature } from './signature.js';

// Every name, number and domain here is invented (Ofcom drama ranges, .test domains).
const BODY = [
  'Hello,',
  '',
  'We acknowledge receipt of your payment pack and will respond shortly.',
  '',
  'Kind regards',
  '',
  'Jane Example',
  'Senior Claims Handler',
  'Third Party Recoveries Team',
  'DDI: 0161 496 0123',
  'Tel: +44 (0)20 7946 0999',
  'Mob 07700 900123',
  'jane.example@example-insurer.test',
  'Call 0161 496 0000 and press 2, then option 3',
  'Mon-Fri 9am - 5pm',
  'This email and any attachments are confidential and intended solely for the addressee.',
  'Registered in England No. 123456',
  '',
  'On 1 Oct 2026, Claims Team <claims@courtesy.test> wrote:',
  '> Please find our pack attached.',
  '> Kind regards',
  '> Somebody Else',
].join('\n');

describe('extractSignature', () => {
  it('takes the block after the last sign-off of the newest message, without disclaimers or quoted text', () => {
    const b = extractSignature(BODY)!;
    expect(b.lines[0]).toBe('Jane Example');
    expect(b.lines.at(-1)).toBe('Mon-Fri 9am - 5pm');
    expect(b.lines.join('\n')).not.toMatch(/confidential|Somebody/);
    expect(b.startLine).toBe(6);
  });
  it('prefers a "-- " separator and returns null when there is no sign-off', () => {
    expect(extractSignature('Thanks for this.\nRegards\nA\n-- \nJohn Sample\n0161 496 0456')!.lines).toEqual(['John Sample', '0161 496 0456']);
    expect(extractSignature('Just a body with no sign-off at all.')).toBeNull();
    expect(extractSignature('')).toBeNull();
  });
  it('caps the block at 25 lines', () => {
    const long = ['Regards', ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join('\n');
    expect(extractSignature(long)!.lines).toHaveLength(25);
  });
});

describe('parseSignature', () => {
  it('reads name, role, team, labelled phones, email, IVR and hours', () => {
    const c = parseSignature(extractSignature(BODY)!);
    expect(c.name).toBe('Jane Example');
    expect(c.role).toBe('Senior Claims Handler');
    expect(c.team).toBe('Third Party Recoveries Team');
    expect(c.phones).toEqual([
      { norm: '01614960123', kind: 'direct' },
      { norm: '02079460999', kind: null },
      { norm: '07700900123', kind: 'mobile' },
      { norm: '01614960000', kind: null },
    ]);
    expect(c.emails).toEqual(['jane.example@example-insurer.test']);
    expect(c.ivr).toBe('Call 0161 496 0000 and press 2, then option 3');
    expect(c.hours).toBe('Mon-Fri 9am - 5pm');
  });
  it('switchboard and team labels', () => {
    const c = parseSignature({ lines: ['Switchboard: 0113 496 0000', 'Team line 0113 496 0001'], startLine: 0 });
    expect(c.phones).toEqual([{ norm: '01134960000', kind: 'switchboard' }, { norm: '01134960001', kind: 'team' }]);
    expect(c.name).toBeNull();
  });
});

describe('classifySender', () => {
  const entry = { ownDomains: ['example-insurer.test'], copycatDomains: ['example-insurer-claims.test'] };
  it('own domain, subdomain, unknown, copycat and spoof', () => {
    expect(classifySender('example-insurer.test', { dmarc: 'pass' }, false, entry)).toBe('own_domain');
    expect(classifySender('mail.example-insurer.test', { dmarc: 'pass' }, false, entry)).toBe('own_domain');
    expect(classifySender('other.test', { dmarc: 'pass' }, false, entry)).toBe('unknown_domain');
    expect(classifySender('example-insurer-claims.test', { dmarc: 'pass' }, false, entry)).toBe('copycat');
    expect(classifySender('example-insurer.test', { dmarc: 'pass' }, true, entry)).toBe('spoof_suspect');
    expect(classifySender('example-insurer.test', { dmarc: 'fail' }, false, entry)).toBe('spoof_suspect');
    expect(classifySender('example-insurer.test', null, false, null)).toBe('unknown_domain');
  });
});
