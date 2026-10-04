/**
 * @ccguk/documents — branded HTML templates → PDF for ClaimDesk.
 *
 *   import { renderTemplate, renderPdf, listTemplates } from '@ccguk/documents';
 *   const { html, templateVersion, title } = renderTemplate('letter.ncaf', data);
 *   const { pdf, sha256, pages } = await renderPdf(html, { reference: data.claim.ourReference });
 *
 * See src/README.md for the template contract.
 */
export * from './brand.js';
export * from './format.js';
export * from './common.js';
export * from './logo.js';
export * from './layout.js';
export * from './registry.js';
export * from './render.js';
export * from './guards.js';
export * from './hash.js';

// Side effect: every template module registers itself.
import './templates/index.js';
