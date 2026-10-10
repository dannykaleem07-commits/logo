// owned by mail
/** Settings > Email form logic (pure; tested). IONOS presets per docs/SUPREME-DESIGN.md §F.1. */
import type { MailAccountInput, MailAccountView } from '../../../api/mailApi';
import { isEmailAddress } from '../../../api/mailApi';

export interface EmailForm {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  username: string;
  fromAddress: string;
  password: string;
  smtpPassword: string;
  signatureText: string;
  processedFolder: string;
  quarantineFolder: string;
  moveAfterIngest: boolean;
  enabled: boolean;
}

export const SMTP_PRESETS = [
  { id: 'ionos-465', host: 'smtp.ionos.co.uk', port: 465, security: 'tls' as const, label: 'IONOS — port 465, TLS' },
  { id: 'ionos-587', host: 'smtp.ionos.co.uk', port: 587, security: 'starttls' as const, label: 'IONOS — port 587, STARTTLS' },
];

export function emptyForm(): EmailForm {
  return {
    imapHost: 'imap.ionos.co.uk',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.ionos.co.uk',
    smtpPort: 465,
    smtpSecurity: 'tls',
    username: '',
    fromAddress: '',
    password: '',
    smtpPassword: '',
    signatureText: '',
    processedFolder: 'ClaimDesk-Processed',
    quarantineFolder: 'ClaimDesk-Quarantine',
    moveAfterIngest: true,
    enabled: false,
  };
}

/** The form for a stored account (passwords are never returned — the fields start empty). */
export function formFromView(v: MailAccountView): EmailForm {
  const a = v.account;
  if (!a) return emptyForm();
  return {
    imapHost: a.imapHost,
    imapPort: a.imapPort,
    imapTls: a.imapTls,
    smtpHost: a.smtpHost,
    smtpPort: a.smtpPort,
    smtpSecurity: a.smtpSecurity,
    username: a.username,
    fromAddress: a.fromAddress,
    password: '',
    smtpPassword: '',
    signatureText: a.signatureText ?? '',
    processedFolder: a.processedFolder,
    quarantineFolder: a.quarantineFolder,
    moveAfterIngest: a.moveAfterIngest,
    enabled: a.enabled,
  };
}

/** A port typed by the owner: 1–65535, else 0 (validateForm then asks to check the port). Nothing is coerced. */
export function parsePort(text: string): number {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return 0;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : 0;
}

export function smtpPresetId(f: Pick<EmailForm, 'smtpHost' | 'smtpPort' | 'smtpSecurity'>): string {
  return SMTP_PRESETS.find((p) => p.host === f.smtpHost && p.port === f.smtpPort && p.security === f.smtpSecurity)?.id ?? 'custom';
}

export function validateForm(f: EmailForm, passwordSaved: boolean): string[] {
  const out: string[] = [];
  if (!isEmailAddress(f.fromAddress.trim())) out.push('Enter the mailbox address (for example claims@yourdomain.co.uk).');
  if (!f.username.trim()) out.push('Enter the user name (usually the mailbox address).');
  if (!f.password && !passwordSaved) out.push('Enter the mailbox password.');
  if (!f.imapHost.trim() || !(f.imapPort > 0 && f.imapPort < 65536)) out.push('Check the IMAP server and port.');
  if (!f.smtpHost.trim() || !(f.smtpPort > 0 && f.smtpPort < 65536)) out.push('Check the SMTP server and port.');
  if (f.smtpPort === 465 && f.smtpSecurity !== 'tls') out.push('Port 465 uses TLS.');
  if (f.smtpPort === 587 && f.smtpSecurity !== 'starttls') out.push('Port 587 uses STARTTLS.');
  if (!f.processedFolder.trim() || !f.quarantineFolder.trim()) out.push('Folder names cannot be empty.');
  return out;
}

/** The PUT body: passwords only when typed (write-only). */
export function toInput(f: EmailForm): MailAccountInput {
  return {
    imapHost: f.imapHost.trim(),
    imapPort: f.imapPort,
    imapTls: f.imapTls,
    smtpHost: f.smtpHost.trim(),
    smtpPort: f.smtpPort,
    smtpSecurity: f.smtpSecurity,
    username: f.username.trim(),
    fromAddress: f.fromAddress.trim(),
    ...(f.password ? { password: f.password } : {}),
    ...(f.smtpPassword ? { smtpPassword: f.smtpPassword } : {}),
    signatureText: f.signatureText.trim() ? f.signatureText : null,
    processedFolder: f.processedFolder.trim(),
    quarantineFolder: f.quarantineFolder.trim(),
    moveAfterIngest: f.moveAfterIngest,
    enabled: f.enabled,
  };
}
