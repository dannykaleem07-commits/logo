import { describe, expect, it } from 'vitest';
import * as domain from '../index.js';
import {
  DEFAULT_OVERRIDE_REASON,
  isManagerRole,
  isOverridable,
  MANAGER_MODE_DEFAULT_IDLE_MINUTES,
  MANAGER_MODE_MAX_IDLE_MINUTES,
  MANAGER_MODE_MIN_IDLE_MINUTES,
  MANAGER_OVERRIDE_HEADER,
  MANAGER_OVERRIDES_RESPONSE_HEADER,
  MANAGER_RELAXED_HEADER,
  MANAGER_ROLES,
  OVERRIDABLE_TEMPLATE_GUARDS,
  OVERRIDE_REASON_MAX,
  OVERRIDE_RULES,
  overrideRule,
} from './codes.js';

const CLASS_A = [
  'HARD_STOP', 'ALLOCATION_REFUSED', 'HIRE_OVERLAP', 'REGISTRATION_ON_CLAIM', 'UNIT_ON_HIRE', 'TRANSITION_REFUSED', 'CHECKLIST_INCOMPLETE', 'LINES_UNCONFIRMED',
  'TOO_FEW_COMPARABLES', 'DOCUMENT_BLOCKED', 'TEMPLATE_WARNINGS_UNACKNOWLEDGED', 'GUARD_BLOCKED', 'HIRE_OPEN', 'STORAGE_OPEN', 'NO_PAYMENT_PACK', 'EXTRA_OVERRIDES_LEDGER',
  'LEGACY_DETAIL', 'COMPANY_NAME_NOT_REGISTERED',
];
const CLASS_B = ['FNOL_INCOMPLETE', 'REGISTRATION_FORMAT', 'GTA_SUGGESTION_UNAVAILABLE', 'VALUES_REQUIRED', 'HIRE_END_BEFORE_START', 'WEB_VALIDATION'];
/** Class C spot checks (§A.2, §A.6): never overridable. */
const CLASS_C = [
  'WRONG_CLAIM', 'IMMUTABLE', 'DOCUMENT_STATE', 'S172_REFUSAL', 'NO_HIRER', 'BANK_DETAILS_PLACEHOLDER', 'TEMPLATE_CHANGED', 'SLOT_NOT_FILLABLE', 'UNKNOWN_VARIANT', 'UNAUTHENTICATED',
  'FORBIDDEN', 'LOGIN_RATE_LIMITED', 'VALIDATION', 'NOT_FOUND', 'DOCUMENT_PDF_TAMPERED', 'NO_HIRE', 'NO_STORAGE', 'HUMAN_REQUIRED',
];

describe('override registry (0.3 §A.3)', () => {
  it('lists exactly the class A and class B codes of the design', () => {
    expect(Object.keys(OVERRIDE_RULES).sort()).toEqual([...CLASS_A, ...CLASS_B].sort());
    for (const code of CLASS_A) expect(OVERRIDE_RULES[code]?.class, code).toBe('A');
    for (const code of CLASS_B) expect(OVERRIDE_RULES[code]?.class, code).toBe('B');
  });

  it('keys every rule by its own code, with a plain-English label and optional warning', () => {
    for (const [key, rule] of Object.entries(OVERRIDE_RULES)) {
      expect(rule.code).toBe(key);
      expect(rule.label.length).toBeGreaterThan(5);
      expect(rule.label).not.toMatch(/[A-Z]{3,}_[A-Z]/); // no flag codes in visible text
      if ('warning' in rule) expect(typeof rule.warning === 'string' && rule.warning.length > 10).toBe(true);
    }
    expect(OVERRIDE_RULES.GUARD_BLOCKED?.warning).toMatch(/Courtesy Cars Group UK Ltd/);
    expect(OVERRIDE_RULES.HIRE_OVERLAP).not.toHaveProperty('warning');
  });

  it('is frozen data', () => {
    expect(Object.isFrozen(OVERRIDE_RULES)).toBe(true);
    expect(() => {
      (OVERRIDE_RULES as Record<string, unknown>).NEW_CODE = { code: 'NEW_CODE', class: 'A', label: 'x' };
    }).toThrow();
  });

  it('never makes a class C code overridable, including inherited object keys', () => {
    for (const code of CLASS_C) {
      expect(isOverridable(code), code).toBe(false);
      expect(overrideRule(code)).toBeUndefined();
    }
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
      expect(isOverridable(key), key).toBe(false);
      expect(overrideRule(key)).toBeUndefined();
    }
    expect(overrideRule('HARD_STOP')).toBe(OVERRIDE_RULES.HARD_STOP);
    expect(isOverridable('HARD_STOP')).toBe(true);
  });

  it('overridable Word-template guards exclude the placeholder bank details', () => {
    expect(OVERRIDABLE_TEMPLATE_GUARDS).toContain('PRINTED_RATES_DIFFER');
    expect(OVERRIDABLE_TEMPLATE_GUARDS).toContain('REFERENCE_DOUBLED');
    expect(OVERRIDABLE_TEMPLATE_GUARDS as readonly string[]).not.toContain('BANK_DETAILS_PLACEHOLDER');
  });

  it('manager roles are admin and approver only', () => {
    expect([...MANAGER_ROLES]).toEqual(['admin', 'approver']);
    expect(isManagerRole('admin')).toBe(true);
    expect(isManagerRole('approver')).toBe(true);
    for (const r of ['handler', 'engineer', 'readonly', 'Admin', '', undefined, null]) expect(isManagerRole(r), String(r)).toBe(false);
  });

  it('constants and headers', () => {
    expect(MANAGER_MODE_DEFAULT_IDLE_MINUTES).toBe(60);
    expect(MANAGER_MODE_MIN_IDLE_MINUTES).toBe(1);
    expect(MANAGER_MODE_MAX_IDLE_MINUTES).toBe(480);
    expect(DEFAULT_OVERRIDE_REASON).toBe('Manager override');
    expect(OVERRIDE_REASON_MAX).toBe(500);
    // Node lower-cases incoming header names: the constants must be lower case to be read from request.headers.
    for (const h of [MANAGER_OVERRIDE_HEADER, MANAGER_RELAXED_HEADER, MANAGER_OVERRIDES_RESPONSE_HEADER]) expect(h).toBe(h.toLowerCase());
  });

  it('is exported from the package entry point', () => {
    expect(domain.OVERRIDE_RULES).toBe(OVERRIDE_RULES);
    expect(domain.isOverridable).toBe(isOverridable);
  });
});
