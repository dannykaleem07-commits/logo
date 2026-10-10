import { defineConfig } from 'vitest/config';
// No test ever calls a real model (docs/SUPREME-DESIGN.md §P.6): real AI drivers refuse to start under this flag.
export default defineConfig({ test: { env: { CLAIMDESK_FORBID_REAL_AI: '1' }, include: ['src/**/*.test.ts'], testTimeout: 60000 } });
