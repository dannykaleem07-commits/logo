// owned by ap-paperwork
import { describe, expect, it } from 'vitest';
import { assertScriptGuard } from '@ccguk/domain';
import { htmlToText } from '../guards.js';
import { getTemplate, hasTemplate, renderTemplate } from '../registry.js';
import './index.js';
import { formsCTemplates, hireCoverConfirmationTemplate, hirePeriodValidationTemplate } from './forms-c.js';
import {
  bookingConfirmationTemplate,
  hireOfferLetterTemplate,
  hireStartNoticeTemplate,
  lettersCTemplates,
  NEUTRAL_INTERVENTION_SENTENCE,
  signatureChaseTemplate,
  signatureRequestLetterTemplate
} from './letters-c.js';

function textOf(id: string, data?: unknown): string {
  const t = getTemplate(id);
  return htmlToText(renderTemplate(id, data ?? t.sample()).html);
}

describe('letters-c / forms-c registration', () => {
  it('registers the ten Autopilot templates (§D.6)', () => {
    const ids = [
      'letter.hire_offer',
      'letter.booking_confirmation',
      'letter.hire_start_notice',
      'letter.signature_request',
      'letter.signature_chase',
      'letter.recovery_storage_instruction',
      'letter.decline',
      'letter.closure',
      'form.hire_period_validation',
      'form.hire_cover_confirmation'
    ];
    for (const id of ids) expect(hasTemplate(id), id).toBe(true);
    expect([...lettersCTemplates, ...formsCTemplates].map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  it('includes the three default auto-send templates (SD §D.2 as changed by AP §0.6)', () => {
    for (const id of ['letter.hire_start_notice', 'letter.booking_confirmation', 'letter.signature_chase']) expect(hasTemplate(id)).toBe(true);
  });
});

describe('outgoing identity and money', () => {
  it('signs as the Claims Team, Courtesy Cars Group UK Ltd, unless a signatory is supplied', () => {
    const data = { ...hireOfferLetterTemplate.sample(), signatory: undefined };
    const text = textOf('letter.hire_offer', data);
    expect(text).toContain('Claims Team');
    expect(text).toContain('for and on behalf of Courtesy Cars Group UK Ltd');
  });

  it('never states a daily rate or calls the hire free (offer, booking, hire start notice)', () => {
    for (const id of ['letter.hire_offer', 'letter.booking_confirmation', 'letter.hire_start_notice']) {
      const text = textOf(id);
      expect(text, id).not.toMatch(/£\s?\d/);
      expect(text, id).not.toMatch(/\bper day\b|\bdaily rate\b/i);
      // "free to consider their offer" is the mandated neutral intervention sentence, not a price claim
      expect(text, id).not.toMatch(/\bfree\b(?! to consider)|no cost to you|without charge/i);
    }
  });
});

describe('letter.hire_offer', () => {
  it('prints the car, the like-for-like sentence, the delivery slot and the hold expiry', () => {
    const text = textOf('letter.hire_offer');
    expect(text).toContain('Volkswagen Golf 1.5 TSI Life');
    expect(text).toContain('LK26 CCG');
    expect(text).toContain('same hire group as your own car');
    expect(text).toContain('between 09:00 and 12:00');
    expect(text).toContain('To accept, reply YES');
    expect(text).toContain('14-day right to cancel');
  });

  it('carries the neutral intervention sentence and passes the script guard', () => {
    const text = textOf('letter.hire_offer');
    expect(text).toContain(NEUTRAL_INTERVENTION_SENTENCE);
    expect(assertScriptGuard(text).violations).toEqual([]);
  });

  it('no Autopilot letter or form trips the script guard', () => {
    for (const t of [...lettersCTemplates, ...formsCTemplates]) expect(assertScriptGuard(textOf(t.id)).violations, t.id).toEqual([]);
  });

  it('falls back to "we will call you" without a delivery slot, and uses the judge intro when given', () => {
    const s = hireOfferLetterTemplate.sample();
    const text = textOf('letter.hire_offer', { ...s, offer: { ...s.offer, delivery: null }, intro: 'Thank you for speaking to us today.' });
    expect(text).toContain('We will call you to arrange delivery');
    expect(text).toContain('Thank you for speaking to us today.');
    expect(text).not.toContain('We are sorry to hear');
  });
});

describe('letter.booking_confirmation', () => {
  it('prints the agreement number and the delivery slot', () => {
    const text = textOf('letter.booking_confirmation');
    expect(text).toContain('CHA-2026-00012');
    expect(text).toMatch(/Delivery .*between 09:00 and 12:00/);
  });

  it('handles a collection slot (off-hire pack)', () => {
    const s = bookingConfirmationTemplate.sample();
    const text = textOf('letter.booking_confirmation', { ...s, booking: { ...s.booking, movement: { ...s.booking.movement!, kind: 'collection' } } });
    expect(text).toContain('Collection of your replacement car');
    expect(text).toContain('return condition report');
  });
});

describe('letter.hire_start_notice', () => {
  it('is addressed to the at-fault insurer with group, start date and agreement number, and asks for the handling reference when missing', () => {
    expect(hireStartNoticeTemplate.recipientRole).toBe('at_fault_insurer');
    const text = textOf('letter.hire_start_notice');
    expect(text).toContain('CHA-2026-00012');
    expect(text).toContain('C (manual)');
    expect(text).toContain('Please quote your reference EXI/TP/4471920');
    const s = hireStartNoticeTemplate.sample();
    const noRef = textOf('letter.hire_start_notice', { ...s, claim: { ...s.claim, theirReference: undefined } });
    expect(noRef).toContain('Please let us have your handling reference');
  });
});

describe('signature request and chase', () => {
  it('splits documents to sign from documents to keep and lists them as enclosures', () => {
    const html = renderTemplate('letter.signature_request', signatureRequestLetterTemplate.sample()).html;
    const text = htmlToText(html);
    expect(text).toContain('Please sign and return');
    expect(text).toContain('For your records');
    expect(html).toContain('data-letter-part="enclosures"');
    expect(text).toContain('Friday 9 October 2026');
  });

  it('chase names the original date and the outstanding documents', () => {
    const text = textOf('letter.signature_chase');
    expect(text).toContain('2 October 2026');
    expect(text).toContain('Accident Report Form');
    const second = textOf('letter.signature_chase', { ...signatureChaseTemplate.sample(), chaseNumber: 2 });
    expect(second).toContain('We wrote to you again recently');
  });
});

describe('forms-c', () => {
  it('hire period validation prints the period, the milestones and the GTA as a benchmark only', () => {
    const text = textOf('form.hire_period_validation');
    expect(text).toContain('10 August 2026 to 2 September 2026 (24 days)');
    expect(text).toContain('Your engineer inspected the vehicle.');
    expect(text).toContain('industry benchmark only');
    expect(hirePeriodValidationTemplate.requiredData).toContain('milestones');
  });

  it('hire cover confirmation says it is not a certificate and names the permitted drivers', () => {
    const text = textOf('form.hire_cover_confirmation');
    expect(text).toContain('This is not a certificate of motor insurance');
    expect(text).toContain('FLEET-000000');
    expect(text).toContain('Ms Jane Example');
    expect(text).toContain('certificate of motor insurance for the vehicle is attached');
    const s = hireCoverConfirmationTemplate.sample();
    const held = textOf('form.hire_cover_confirmation', { ...s, cover: { ...s.cover, certificateAttached: false, permittedDrivers: [] } });
    expect(held).toContain('held by us');
    expect(held).toContain('do not drive until we confirm the drivers');
  });
});
