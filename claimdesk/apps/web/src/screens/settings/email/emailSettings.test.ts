// owned by mail
import { describe, expect, it } from 'vitest';
import { emptyForm, formFromView, smtpPresetId, toInput, validateForm } from './emailSettings';
import type { MailAccountView } from '../../../api/mailApi';

describe('Settings > Email form', () => {
  it('starts from the IONOS presets', () => {
    const f = emptyForm();
    expect(f).toMatchObject({ imapHost: 'imap.ionos.co.uk', imapPort: 993, imapTls: true, smtpHost: 'smtp.ionos.co.uk', smtpPort: 465, smtpSecurity: 'tls', moveAfterIngest: true, enabled: false });
    expect(smtpPresetId(f)).toBe('ionos-465');
    expect(smtpPresetId({ smtpHost: 'smtp.ionos.co.uk', smtpPort: 587, smtpSecurity: 'starttls' })).toBe('ionos-587');
    expect(smtpPresetId({ smtpHost: 'mail.example', smtpPort: 25, smtpSecurity: 'starttls' })).toBe('custom');
  });

  it('validates the address, password (unless saved) and the port/security pairs', () => {
    const f = { ...emptyForm(), fromAddress: 'claims@ccguk-test.example', username: 'claims@ccguk-test.example' };
    expect(validateForm(f, false)).toEqual(['Enter the mailbox password.']);
    expect(validateForm(f, true)).toEqual([]);
    expect(validateForm({ ...f, smtpPort: 587 }, true)).toEqual(['Port 587 uses STARTTLS.']);
    expect(validateForm({ ...f, fromAddress: 'nope' }, true)[0]).toMatch(/mailbox address/);
  });

  it('never echoes a password: the stored form starts empty and the body only carries typed passwords', () => {
    const view = { account: { id: 'a', label: 'x', imapHost: 'imap.ionos.co.uk', imapPort: 993, imapTls: true, smtpHost: 'smtp.ionos.co.uk', smtpPort: 465, smtpSecurity: 'tls', username: 'u@x.test', fromName: 'Claims Team, Courtesy Cars Group UK Ltd', fromAddress: 'u@x.test', processedFolder: 'P', quarantineFolder: 'Q', moveAfterIngest: false, enabled: true, createdAt: '', updatedAt: '' }, passwordSaved: { imap: true, smtp: true } } as unknown as MailAccountView;
    const f = formFromView(view);
    expect(f.password).toBe('');
    expect(toInput(f)).not.toHaveProperty('password');
    expect(toInput({ ...f, password: 'typed' })).toMatchObject({ password: 'typed', moveAfterIngest: false, enabled: true });
  });
});
