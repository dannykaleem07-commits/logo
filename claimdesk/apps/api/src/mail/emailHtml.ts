// owned by claimai-server (email footer task)
/**
 * Every email ClaimDesk sends is multipart: the plain text (the body as written, the account's text signature and the
 * Companies Act trading disclosure) and, with Settings > Email "HTML footer" on (the default), an HTML part — the body
 * as escaped, email-safe paragraphs above the branded footer, with the logo attached inline (Content-ID `ccguk-logo`).
 *
 * Company details come from the brand (packages/documents brand.ts) with the Settings overrides (company name, number,
 * registered office) — nothing is typed here. The "Please quote our reference" row is shown only for a claim email.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brand, formatRegisteredOffice } from '@ccguk/documents';
import type { MailAccountRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';

export const LOGO_CID = 'ccguk-logo';
export const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'email-logo.png');
const REF_RE = /\[(CCG-\d{4}-\d{5})\]/i;

export interface CompanyDetails {
  name: string;
  tradingName: string;
  tagline: string;
  companyNumber: string;
  registeredOffice: string;
  officePhone: string;
  claimsLine: string;
  email: string;
  website: string;
  statusLine: string;
}

/** The brand's company details with the owner's Settings overrides. */
export function companyDetails(ctx: AppContext): CompanyDetails {
  let s: ReturnType<AppContext['settings']> | undefined;
  try {
    s = ctx.settings();
  } catch {
    s = undefined;
  }
  const c = brand.company;
  const name = s?.companyName?.trim() || c.registeredName;
  return {
    name,
    tradingName: c.tradingName,
    tagline: c.tagline,
    companyNumber: s?.companyNumber?.trim() || c.companyNumber,
    registeredOffice: formatRegisteredOffice(s?.registeredOffice),
    officePhone: c.officePhone,
    claimsLine: c.caseHandlerPhone,
    email: c.claimsEmail,
    website: c.website,
    statusLine: c.statusLine.split(c.registeredName).join(name),
  };
}

/** Part 6 Companies Act 2006 disclosure (one line). */
export function tradingDisclosure(d: CompanyDetails): string {
  return `${d.name}. Registered in England and Wales, company number ${d.companyNumber}. Registered office: ${d.registeredOffice.replace(/\.$/, '')}.`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "020 7052 5403" → "+442070525403"; "07425 475922" → "+447425475922". */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : digits.startsWith('0') ? `+44${digits.slice(1)}` : digits;
}

const FONT = 'font-family:Arial,Helvetica,sans-serif;';

/** The body as email-safe paragraphs: blank lines split paragraphs, single new lines become <br>, all text escaped. */
export function bodyHtml(text: string): string {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim().length > 0);
  return paras.map((p) => `<p style="margin:0 0 14px 0;${FONT}font-size:14px;line-height:21px;color:#1A202C">${p.split('\n').map(escapeHtml).join('<br>')}</p>`).join('\n');
}

const row = (label: string, value: string, href: string, strong: boolean): string =>
  `<tr><td style="padding:2px 14px 2px 0;color:#718096;font-size:11px;letter-spacing:1px;text-transform:uppercase">${escapeHtml(label)}</td><td style="padding:2px 0"><a href="${escapeHtml(href)}" style="color:${strong ? '#0D1C50' : '#04347F'};text-decoration:none${strong ? ';font-weight:bold' : ''}">${escapeHtml(value)}</a></td></tr>`;

/**
 * The branded footer (the owner-approved design). `claimRef` fills "Please quote our reference"; without a claim the
 * row is left out. `logoSrc` is `cid:ccguk-logo` in a sent email (a data: URL in the Settings preview).
 */
export function footerHtml(d: CompanyDetails, opts: { claimRef: string | null; signer?: string; logoSrc?: string }): string {
  const signer = opts.signer?.trim() || 'Claims Team';
  const logo = opts.logoSrc ?? `cid:${LOGO_CID}`;
  const website = d.website.startsWith('http') ? d.website : `https://${d.website}`;
  const refRow = opts.claimRef
    ? `
  <tr><td style="padding:0 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#EEF3FB;border-left:3px solid #04347F;padding:10px 14px;${FONT}font-size:13px;line-height:19px;color:#0D1C50">
      Please quote our reference <strong>${escapeHtml(opts.claimRef)}</strong> on all correspondence.
    </td></tr></table>
  </td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border-collapse:collapse;background:#ffffff;${FONT}">
  <tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="64" height="4" style="background:#04347F;font-size:0;line-height:0">&nbsp;</td>
    <td height="4" style="background:#1F5BB8;font-size:0;line-height:0">&nbsp;</td>
    <td width="96" height="4" style="background:#2A74CA;font-size:0;line-height:0">&nbsp;</td>
  </tr></table></td></tr>
  <tr><td style="padding:22px 24px 6px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top" style="padding:0 16px 14px 0;${FONT}">
        <div style="font-size:16px;line-height:22px;font-weight:bold;color:#0D1C50">${escapeHtml(signer)}</div>
        <div style="font-size:13px;line-height:19px;color:#4A5568">${escapeHtml(d.name)}</div>
        <div style="font-size:11px;line-height:16px;color:#1F5BB8;letter-spacing:1.2px;text-transform:uppercase;padding-top:4px">${escapeHtml(d.tagline)}</div>
      </td>
      <td valign="top" align="right" style="padding:0 0 14px 0">
        <img src="${escapeHtml(logo)}" width="240" alt="${escapeHtml(d.tradingName)}" style="display:block;width:240px;max-width:100%;height:auto;border:0">
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 24px 18px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${FONT}font-size:13px;line-height:20px;color:#1A202C">
      ${row('Office', d.officePhone, `tel:${telHref(d.officePhone)}`, true)}
      ${row('Claims line', d.claimsLine, `tel:${telHref(d.claimsLine)}`, true)}
      ${row('Email', d.email, `mailto:${d.email}`, false)}
      ${row('Web', d.website, website, false)}
    </table>
  </td></tr>${refRow}
  <tr><td style="padding:16px 24px 22px 24px;${FONT}font-size:10.5px;line-height:15px;color:#718096">
    <p style="margin:0 0 8px 0">This email and any attachments are confidential and intended only for the named recipient. If you have received it in error, please tell us by replying and then delete it. Do not copy or pass it on.</p>
    <p style="margin:0 0 8px 0">${escapeHtml(d.statusLine)}</p>
    <p style="margin:0">${escapeHtml(tradingDisclosure(d))}</p>
  </td></tr>
</table>`;
}

/** The whole HTML document: escaped body paragraphs above the footer. */
export function emailHtmlDocument(body: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border-collapse:collapse"><tr><td style="padding:20px 24px 8px 24px">
${body}
</td></tr></table>
${footer}
</body></html>`;
}

/** The plain text: as written (it already carries the account's text signature), plus the trading disclosure. */
export function plainText(text: string, d: CompanyDetails): string {
  const disclosure = tradingDisclosure(d);
  const t = text.replace(/\s+$/, '');
  return t.includes(disclosure) ? `${t}\n` : `${t}\n\n--\n${disclosure}\n`;
}

/** The claim reference of an email: the bracketed subject tag every outbound claim email carries ("[CCG-2026-00001]"). */
export function claimRefOf(subject: string): string | null {
  return REF_RE.exec(subject)?.[1]?.toUpperCase() ?? null;
}

export interface InlineImage {
  filename: string;
  path: string;
  contentType: string;
  cid: string;
}

export interface ComposedEmail {
  text: string;
  html?: string;
  inline: InlineImage[];
}

/** Compose the parts for one outgoing email (§ footer task). */
export function composeEmail(ctx: AppContext, account: Pick<MailAccountRecord, 'htmlFooter' | 'fromName'> | undefined, msg: { subject: string; text: string; html?: string; claimRef?: string | null }): ComposedEmail {
  const d = companyDetails(ctx);
  const text = plainText(msg.text, d);
  if (account && account.htmlFooter === false) return { text, ...(msg.html ? { html: msg.html } : {}), inline: [] };
  const claimRef = msg.claimRef === undefined ? claimRefOf(msg.subject) : msg.claimRef;
  const signer = account?.fromName?.split(',')[0]?.trim() || 'Claims Team';
  const footer = footerHtml(d, { claimRef, signer });
  const html = emailHtmlDocument(msg.html ?? bodyHtml(msg.text), footer);
  const inline: InlineImage[] = existsSync(LOGO_PATH) ? [{ filename: 'ccguk-logo.png', path: LOGO_PATH, contentType: 'image/png', cid: LOGO_CID }] : [];
  return { text, html, inline };
}
