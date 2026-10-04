import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { EMPTY_PASSWORD_FORM, hasPasswordErrors, MIN_PASSWORD_LENGTH, PASSWORD_CHANGED_MESSAGE, passwordChangeError, validatePasswordForm } from './password';

const ok = { currentPassword: 'CourtesyCars123!', newPassword: 'a-much-longer-passphrase', confirmPassword: 'a-much-longer-passphrase' };

describe('validatePasswordForm (Change password card)', () => {
  it('accepts a valid change', () => {
    expect(validatePasswordForm(ok)).toEqual({});
    expect(hasPasswordErrors(validatePasswordForm(ok))).toBe(false);
  });
  it('requires all three boxes', () => {
    const e = validatePasswordForm(EMPTY_PASSWORD_FORM);
    expect(e.currentPassword).toBe('Enter your current password.');
    expect(e.newPassword).toBe('Enter a new password.');
    expect(e.confirmPassword).toBe('Type the new password again.');
    expect(hasPasswordErrors(e)).toBe(true);
  });
  it('needs at least 10 characters (9 fails, 10 passes)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(validatePasswordForm({ ...ok, newPassword: '123456789', confirmPassword: '123456789' }).newPassword).toBe('Use at least 10 characters.');
    expect(validatePasswordForm({ ...ok, newPassword: '1234567890', confirmPassword: '1234567890' })).toEqual({});
  });
  it('must differ from the current password', () => {
    expect(validatePasswordForm({ ...ok, newPassword: ok.currentPassword, confirmPassword: ok.currentPassword }).newPassword).toBe('The new password must be different from the current one.');
  });
  it('confirmation must match exactly', () => {
    expect(validatePasswordForm({ ...ok, confirmPassword: 'a-much-longer-passphrasE' }).confirmPassword).toBe('The two new passwords do not match.');
  });
  it('the success toast wording', () => {
    expect(PASSWORD_CHANGED_MESSAGE).toBe('Password changed — other sessions signed out');
  });
});

describe('passwordChangeError (POST /auth/change-password failures)', () => {
  it('wrong current password goes on that field', () => {
    expect(passwordChangeError(new ApiError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect', '/api/auth/change-password'))).toEqual({ field: 'currentPassword', message: 'Current password is incorrect.' });
  });
  it('other failures become the card error line', () => {
    expect(passwordChangeError(new ApiError(0, 'NETWORK', 'down', '/api/auth/change-password')).message).toMatch(/has not been changed/);
    expect(passwordChangeError(new ApiError(401, 'UNAUTHENTICATED', 'Sign in', '/api/auth/change-password')).message).toMatch(/Sign in again/);
    expect(passwordChangeError(new ApiError(400, 'VALIDATION', 'newPassword must be at least 10 characters', '/api/auth/change-password'))).toEqual({ message: 'newPassword must be at least 10 characters' });
    expect(passwordChangeError(new Error('x')).field).toBeUndefined();
  });
});
