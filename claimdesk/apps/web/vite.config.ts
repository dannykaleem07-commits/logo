import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // @ccguk/domain is consumed from source. Its esign/evidence modules import node:crypto, which has no
      // browser build; the shim lets Rollup bind the names and tree-shake the unused code (see src/shims).
      { find: /^(node:)?crypto$/, replacement: fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)) }
    ]
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } }
  },
  build: { outDir: 'dist', sourcemap: true }
});
