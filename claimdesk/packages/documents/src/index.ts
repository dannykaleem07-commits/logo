/**
 * @ccguk/documents — branded HTML templates → PDF for ClaimDesk.
 *
 *   import { renderTemplate, renderPdf, listTemplates } from '@ccguk/documents';
 *   const { html, templateVersion, title } = renderTemplate('letter.ncaf', data);
 *   const { pdf, sha256, pages } = await renderPdf(html, { reference: data.claim.ourReference });
 *
 * See src/README.md for the template contract.
 *
 * Surface:
 *   brand      company details, palette, typography, page margins, legacy block list, status line
 *   format     date / money / HTML formatters (the only way a template prints a date or an amount)
 *   common     shared data shapes (CompanySettings, RecipientBlock, ClaimHeader, BaseDocumentData) + sample fixtures
 *   logo       inline SVG lockup
 *   layout     baseLayout() + partials + Playwright headerTemplate() / footerTemplate()
 *   registry   Template<TData>, registerTemplate, getTemplate, listTemplates, renderTemplate, renderSample, errors
 *   render     renderPdf, mergePdfs, pdfPageCount, resolveChromium, closeBrowser
 *   guards     findBlockedStrings / findBannedPhrases / findProhibitedContent / assertNoProhibitedContent
 *   hash       sha256Hex, htmlSha256
 *   templates  every production template's data interface and template object; evaluating them registers the set
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

// Side effect as well as exports: evaluating the template modules registers every production template.
export * from './templates/index.js';
export * from './docx/index.js';
export * from './docx/fields/index.js';
export * from './letterContent.js';
