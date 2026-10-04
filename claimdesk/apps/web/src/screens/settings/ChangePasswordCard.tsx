import { useState, type FormEvent } from 'react';
import { useChangePassword, useMe } from '../../api/hooks';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { TextInput } from '../../components/Form';
import { useToast } from '../../components/Toast';
import { EMPTY_PASSWORD_FORM, hasPasswordErrors, MIN_PASSWORD_LENGTH, PASSWORD_CHANGED_MESSAGE, passwordChangeError, validatePasswordForm, type PasswordErrors, type PasswordForm } from './password';

/**
 * Change the signed-in user's password (POST /auth/change-password). The API signs out every other session of
 * this user; this one stays signed in. Changing the default account's password also stops the sign-in pre-fill.
 */
export function ChangePasswordCard() {
  const change = useChangePassword();
  const username = useMe().data?.username ?? '';
  const toast = useToast();
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (key: keyof PasswordForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (change.isPending) return;
    const found = validatePasswordForm(form);
    setErrors(found);
    if (hasPasswordErrors(found)) return;
    setFormError(null);
    try {
      await change.mutateAsync({ currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm(EMPTY_PASSWORD_FORM);
      setErrors({});
      toast.success(PASSWORD_CHANGED_MESSAGE);
    } catch (err) {
      const mapped = passwordChangeError(err);
      if (mapped.field) setErrors({ [mapped.field]: mapped.message });
      else setFormError(mapped.message);
    }
  };

  return (
    <Card title="Change password">
      <form className="stack" onSubmit={submit} noValidate>
        {/* lets password managers pair the new password with the signed-in account */}
        <input type="text" name="username" autoComplete="username" hidden readOnly value={username} />
        <p className="basis">
          At least {MIN_PASSWORD_LENGTH} characters. Changing it signs out every other device using this account; this one stays signed in. Passwords are stored only as a salted hash.
        </p>
        {formError && (
          <div className="notice notice-danger" role="alert">
            {formError}
          </div>
        )}
        <TextInput label="Current password" type="password" value={form.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" error={errors.currentPassword} required />
        <div className="form-grid">
          <TextInput label="New password" type="password" value={form.newPassword} onChange={set('newPassword')} autoComplete="new-password" error={errors.newPassword} minLength={MIN_PASSWORD_LENGTH} required />
          <TextInput label="Confirm new password" type="password" value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" error={errors.confirmPassword} required />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}
