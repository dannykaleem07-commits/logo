/**
 * "Change password" card model (pure; unit-tested). Mirrors the API rules for POST /auth/change-password:
 * the new password has at least 10 characters and differs from the current one. The API stays the authority;
 * these checks just stop an obviously bad request and say why.
 */
import { isApiError } from '../../api/client';

export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordErrors = Partial<Record<keyof PasswordForm, string>>;

export const EMPTY_PASSWORD_FORM: PasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };

export const PASSWORD_CHANGED_MESSAGE = 'Password changed — other sessions signed out';

/** Field-by-field errors; an empty object means the form can be sent. */
export function validatePasswordForm(form: PasswordForm): PasswordErrors {
  const errors: PasswordErrors = {};
  if (!form.currentPassword) errors.currentPassword = 'Enter your current password.';
  if (!form.newPassword) errors.newPassword = 'Enter a new password.';
  else if (form.newPassword.length < MIN_PASSWORD_LENGTH) errors.newPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (form.currentPassword && form.newPassword === form.currentPassword) errors.newPassword = 'The new password must be different from the current one.';
  if (!form.confirmPassword) errors.confirmPassword = 'Type the new password again.';
  else if (form.confirmPassword !== form.newPassword) errors.confirmPassword = 'The two new passwords do not match.';
  return errors;
}

export function hasPasswordErrors(errors: PasswordErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/**
 * Map an API failure onto the form: a wrong current password (400 INVALID_CREDENTIALS) is shown on that field;
 * anything else becomes the card's error line (`form`).
 */
export function passwordChangeError(error: unknown): { field?: keyof PasswordForm; message: string } {
  if (isApiError(error)) {
    if (error.code === 'INVALID_CREDENTIALS') return { field: 'currentPassword', message: 'Current password is incorrect.' };
    if (error.isNetwork) return { message: 'Cannot reach the ClaimDesk server. Your password has not been changed.' };
    if (error.status === 401) return { message: 'Your session has ended. Sign in again, then change the password.' };
    return { message: `${error.message || 'The password could not be changed.'}` };
  }
  return { message: error instanceof Error && error.message ? error.message : 'The password could not be changed.' };
}
