import { defineConfig } from 'vitest/config';
// setupEnv sets CLAIMDESK_FORBID_REAL_AI=1 for every test file: no test ever calls a real model (SUPREME §P.6).
export default defineConfig({ test: { env: { CLAIMDESK_FORBID_REAL_AI: '1' }, include: ['src/**/*.test.ts'], testTimeout: 60000, setupFiles: ['src/test/setupEnv.ts'] } });
