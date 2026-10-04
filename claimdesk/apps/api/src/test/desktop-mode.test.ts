// The packaged desktop app runs on plain http://localhost with no email/SMS sender: COOKIE_SECURE=false and
// ESIGN_DELIVERY=handler. These tests pin that behaviour and the production defaults it overrides.
import { afterEach, describe, expect, it } from 'vitest';
import { cookieOptions } from '../services/auth.js';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t?.ctx.close();
  t = undefined;
});

describe('desktop-mode settings', () => {
  it('cookieSecure decides the Secure flag on the session cookie', async () => {
    t = await createTestApp(undefined, { config: { cookieSecure: true } });
    expect(cookieOptions(t.ctx).secure).toBe(true);
    await t.app.close();
    t.ctx.close();
    t = await createTestApp(undefined, { config: { cookieSecure: false } });
    expect(cookieOptions(t.ctx).secure).toBe(false);
  });

  it('ESIGN_DELIVERY=handler returns the signing code to the handler and audits it; external does not', async () => {
    for (const mode of ['handler', 'external'] as const) {
      t = await createTestApp(undefined, { config: { esignDelivery: mode } });
      const ids = t.ctx.repos.seedFileOne(t.ctx.db);
      const draft = await t.api<{ id: string }>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' });
      expect(draft.status).toBe(201);
      expect((await t.api('POST', `/documents/${draft.body.id}/approve`, {})).status).toBe(200);
      const start = await t.api<{ handlerCode?: string; devCode?: string }>('POST', `/documents/${draft.body.id}/sign/start`, { signerPartyId: ids.claimantId, contact: 'jane.doe@example.test', channel: 'email' });
      expect(start.status).toBe(200);
      const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: draft.body.id } as never) as Array<{ action: string }>;
      if (mode === 'handler') {
        expect(start.body.handlerCode).toMatch(/^\d{6}$/);
        expect(audit.some((a) => a.action === 'document.sign.code_shown_to_handler')).toBe(true);
      } else {
        expect(start.body.handlerCode).toBeUndefined();
      }
      await t.app.close();
      t.ctx.close();
      t = undefined;
    }
  });
});
