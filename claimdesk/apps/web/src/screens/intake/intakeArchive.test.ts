// owned by intake-web
/** Single files tab: a .zip whose files were unpacked reads "Unpacked (n files)" (docs/SMART-INTAKE.md §3.1, §11.5). */
import { describe, expect, it } from 'vitest';
import { itemStatusLabel } from './intakeModel';
import type { IntakeDocSummary } from '../../api/intakeApi';

const doc = (kind: IntakeDocSummary['kind']) => ({ kind }) as IntakeDocSummary;

describe('itemStatusLabel', () => {
  it('labels an unpacked archive with its file count', () => {
    expect(itemStatusLabel({ status: 'skipped', doc: doc('archive'), children: 6 })).toBe('Unpacked (6 files)');
    expect(itemStatusLabel({ status: 'skipped', doc: doc('archive'), children: 1 })).toBe('Unpacked (1 file)');
  });
  it('keeps the status label for everything else', () => {
    expect(itemStatusLabel({ status: 'skipped', doc: doc('skipped'), children: 0 })).toBe('Not read');
    expect(itemStatusLabel({ status: 'proposed', doc: null, children: 0 })).toBe('Read');
  });
});
