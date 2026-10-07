/**
 * Shared vitest setup (docs/SUPREME-DESIGN.md §P.6, §R.1): every API test runs with real AI drivers forbidden — the
 * subscription CLI and API-key drivers throw REAL_AI_FORBIDDEN when this is set; tests use the FakeDriver only.
 */
process.env.CLAIMDESK_FORBID_REAL_AI = '1';
// Never inherit a developer's driver choice or mail transport into tests.
delete process.env.AI_DRIVER;
delete process.env.MAIL_TRANSPORT;
