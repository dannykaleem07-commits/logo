/**
 * Every template module, re-exported. Evaluating a module registers its templates with the registry (side effect), so
 * importing this file — or `../index.ts`, which re-exports it — makes the whole production set available to
 * `listTemplates()` / `renderTemplate()`. The named exports (data interfaces and template objects) let the API type the
 * `data` it assembles for each template.
 *
 * Add a line here when you add a template file. Templates import from '../registry.js', '../layout.js', '../format.js'
 * and '../common.js' directly — never from '../index.js' (that would be a cycle). Export names must be unique across
 * these files (the typecheck fails on a collision; put shared constants in '../common.js'). `_example.ts` is the pattern
 * to copy and is deliberately not listed.
 */
export * from './letters-a.js';
export * from './letters-b.js';
export * from './invoices.js';
export * from './reports.js';
export * from './agreements-forms.js';
export * from './packs-bundles.js';
export * from './notices.js';
export * from './certificate.js';
// Autopilot letters and forms (docs/SUPREME-AUTOPILOT.md §D.6; ap-paperwork)
export * from './letters-c.js';
export * from './forms-c.js';
