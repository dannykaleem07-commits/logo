// owned by claimai-server (email footer task)
/**
 * Every email ClaimDesk sends is multipart text + HTML (mail/emailHtml.ts, mail/transport.ts): the branded footer with
 * the logo attached inline (cid:ccguk-logo), the body as escaped paragraphs, the claim reference row only for a claim
 * email, the plain text keeping the signature plus the trading disclosure, company details from the brand and the
 * Settings overrides, and Settings > Email "HTML footer" off → plain text only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brand } from '@ccguk/documents';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { bodyHtml, claimRefOf, companyDetails, footerHtml, LOGO_CID, plainText, telHref, tradingDisclosure } from '../mail/emailHtml.js';
import { ownerCompose, sendNowOutbox } from '../mail/outbox.js';
import { MAILBOX, queued, runJob, setUpMail } from './fixtures/mail/helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let t: TestApp;
let smtp: Awaited<ReturnType<typeof setUpMail>>['smtp'];
let claim: { id: string; reference: string };
const owner = { userId: 'courtesycars' } as never;

async function send(input: { claimId?: string; subject: string; bodyText: string }) {
  const o = ownerCompose(t.ctx, { to: ['someone@example-insurer.test'], kind: 'reply_general', ...input }, owner);
  sendNowOutbox(t.ctx, o.id, owner);
  for (const j of queued(t.ctx, 'outbox.release')) await runJob(t.ctx, j);
  const msg = smtp.sent.at(-1)!;
  expect(msg.subject).toContain(input.subject);
  return msg;
}

beforeAll(async () => {
  t = await createTestApp('2026-10-12T09:00:00.000Z');
  ({ smtp } = await setUpMail(t.ctx));
  const acc = t.ctx.repos.getDefaultMailAccount(t.ctx.db)!;
  t.ctx.repos.upsertMailAccount(t.ctx.db, { ...acc, signatureText: 'Kind regards\nClaims Team' });
  const c = await t.api<Json>('POST', '/claims', FNOL);
  claim = { id: (c.body.claim ?? c.body).id, reference: (c.body.claim ?? c.body).reference };
});

afterAll(async () => {
  await t?.close();
});

describe('email HTML pieces', () => {
  it('escapes the body into paragraphs (no markup from the text survives)', () => {
    const html = bodyHtml('Dear Sirs,\n\nYour <b>offer</b> & "terms" — see \'below\'.\nLine two\n\n\nKind regards');
    expect(html).toContain('Your &lt;b&gt;offer&lt;/b&gt; &amp; &quot;terms&quot; — see &#39;below&#39;.<br>Line two');
    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).not.toContain('<b>');
    expect(bodyHtml('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('shows the reference row only for a claim email; details come from the brand', () => {
    const d = companyDetails(t.ctx);
    expect(d.name).toBe(brand.company.registeredName);
    expect(d.companyNumber).toBe(brand.company.companyNumber);
    const withRef = footerHtml(d, { claimRef: 'CCG-2026-00001' });
    expect(withRef).toContain('Please quote our reference <strong>CCG-2026-00001</strong>');
    expect(withRef).toContain(`src="cid:${LOGO_CID}"`);
    expect(withRef).toContain(`tel:${telHref(brand.company.officePhone)}`);
    expect(withRef).toContain(`mailto:${brand.company.claimsEmail}`);
    expect(withRef).toContain(tradingDisclosure(d));
    expect(footerHtml(d, { claimRef: null })).not.toContain('Please quote our reference');
    expect(footerHtml(d, { claimRef: '<x>' })).toContain('&lt;x&gt;');
    expect(telHref('020 7052 5403')).toBe('+442070525403');
    expect(claimRefOf('Re: your letter [CCG-2026-00042]')).toBe('CCG-2026-00042');
    expect(claimRefOf('No reference')).toBeNull();
  });

  it('the plain text keeps the body and adds the trading disclosure once', () => {
    const d = companyDetails(t.ctx);
    const once = plainText('Hello\n\nKind regards', d);
    expect(once).toContain('Kind regards\n\n--\n' + tradingDisclosure(d));
    expect(plainText(once, d)).toBe(once);
  });
});

describe('sent emails', () => {
  it('a claim email is multipart: text (signature + disclosure) and HTML (body + footer + reference) with the inline logo', async () => {
    const msg = await send({ claimId: claim.id, subject: 'Your letter', bodyText: 'Dear Sirs,\n\nWe enclose the <form> you asked for.' });
    expect(msg.text).toContain('Kind regards\nClaims Team');
    expect(msg.text).toContain(tradingDisclosure(companyDetails(t.ctx)));
    expect(msg.html).toBeTruthy();
    expect(msg.html).toContain('We enclose the &lt;form&gt; you asked for.');
    expect(msg.html).toContain(`Please quote our reference <strong>${claim.reference}</strong>`);
    expect(msg.html).toContain('cid:ccguk-logo');
    expect(msg.attachments).toHaveLength(0); // the logo is an inline image, not a file attachment
    const logo = msg.inline?.find((a) => a.cid === LOGO_CID);
    expect(logo).toMatchObject({ contentType: 'image/png', filename: 'ccguk-logo.png' });
    const raw = msg.raw.toString('latin1');
    expect(raw).toMatch(/Content-Type: multipart\/related/i);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type: text\/plain/i);
    expect(raw).toMatch(/Content-Type: text\/html/i);
    expect(raw).toMatch(/Content-ID: <ccguk-logo>/i);
    // the stored copy is exactly what was sent
    const o = t.ctx.repos.listOutbox(t.ctx.db, { claimId: claim.id }).find((x) => x.subject.startsWith('Your letter'))!;
    expect(o.status).toBe('sent');
  });

  it('an email without a claim has no reference row', async () => {
    const msg = await send({ subject: 'Hello from ClaimDesk', bodyText: 'Just a note.' });
    expect(msg.html).toBeTruthy();
    expect(msg.html).not.toContain('Please quote our reference');
  });

  it('Settings overrides reach the footer and the disclosure', async () => {
    t.ctx.repos.patchSettings(t.ctx.db, { companyName: 'Courtesy Cars Group UK Limited' }, { userId: 'test' } as never);
    const msg = await send({ claimId: claim.id, subject: 'Override check', bodyText: 'Text.' });
    expect(msg.html).toContain('Courtesy Cars Group UK Limited');
    expect(msg.text).toContain('Courtesy Cars Group UK Limited. Registered in England and Wales');
    t.ctx.repos.patchSettings(t.ctx.db, { companyName: brand.company.registeredName }, { userId: 'test' } as never);
  });

  it('HTML footer off (Settings > Email): plain text only, no inline logo; the preview says so', async () => {
    const view = await t.api<Json>('GET', '/mail/account');
    expect(view.body.account.htmlFooter).toBe(true);
    const acc = t.ctx.repos.getDefaultMailAccount(t.ctx.db)!;
    t.ctx.repos.upsertMailAccount(t.ctx.db, { ...acc, htmlFooter: false });
    const msg = await send({ claimId: claim.id, subject: 'Plain only', bodyText: 'Text only please.' });
    expect(msg.html).toBeUndefined();
    expect(msg.inline ?? []).toHaveLength(0);
    expect(msg.text).toContain(tradingDisclosure(companyDetails(t.ctx)));
    expect(msg.raw.toString('latin1')).not.toMatch(/text\/html/i);
    const p = await t.api<Json>('GET', '/mail/footer-preview?withClaim=false');
    expect(p.status).toBe(200);
    expect(p.body.htmlFooter).toBe(false);
    expect(p.body.html).toContain('data:image/png;base64,');
    expect(p.body.html).not.toContain('Please quote our reference');
    expect(p.body.text).toContain('Kind regards');
    t.ctx.repos.upsertMailAccount(t.ctx.db, { ...acc, htmlFooter: true });
    const on = await t.api<Json>('GET', '/mail/footer-preview');
    expect(on.body.htmlFooter).toBe(true);
    expect(on.body.html).toContain('Please quote our reference <strong>CCG-2026-00001</strong>');
  });

  it('PUT /mail/account saves the switch', async () => {
    const acc = t.ctx.repos.getDefaultMailAccount(t.ctx.db)!;
    const r = await t.api<Json>('PUT', '/mail/account', { imapHost: acc.imapHost, imapPort: acc.imapPort, smtpHost: acc.smtpHost, smtpPort: acc.smtpPort, smtpSecurity: acc.smtpSecurity, username: acc.username, fromAddress: MAILBOX, htmlFooter: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.account.htmlFooter).toBe(false);
    expect(t.ctx.repos.getDefaultMailAccount(t.ctx.db)!.htmlFooter).toBe(false);
  });
});
