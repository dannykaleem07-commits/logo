export * from './brand.js';
// Renderer, templates and registry are added by the documents build agents:
//   ./render.ts     — HTML → PDF via playwright-core (A4, brand margins, page X of Y, SHA-256)
//   ./registry.ts   — template registry: id, version, title, dataSchema, render(data) → html
//   ./templates/*   — one file per template
