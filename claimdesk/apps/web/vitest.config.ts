import { defineConfig } from 'vitest/config';
// No test ever calls a real model (docs/SUPREME-DESIGN.md §P.6): real AI drivers refuse to start under this flag.
// testTimeout: dynamic imports of whole screens can take > 5 s on a loaded machine (as the api and documents configs allow).
export default defineConfig({ test: { env: { CLAIMDESK_FORBID_REAL_AI: '1' }, include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node', testTimeout: 20_000 } });
