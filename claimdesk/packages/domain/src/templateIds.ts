/**
 * Canonical template ids (TEMPLATES-VEHICLES-DESKTOP §C.8).
 *
 * The CCGUK Word templates (`<kind>.ccguk_NN_<name>`) do the same legal job as some of the HTML templates. Every rule
 * that keys on a template id (acceptance gates, the GTA payment pack, the consistency engine's recipient inference, the
 * API's semantic send events) looks the id up through `canonicalTemplateId`, so a signed CCGUK-07 Statement of Means
 * counts exactly as a signed `form.statement_of_means` does. Ids without an equivalent are returned unchanged.
 */
export const DOCX_TEMPLATE_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze({
  'agreement.ccguk_03_credit_hire': 'agreement.credit_hire',
  'statement.ccguk_04_witness': 'statement.witness',
  'form.ccguk_07_statement_of_means': 'form.statement_of_means',
  'form.ccguk_08_intervention_mitigation': 'form.mitigation_questionnaire',
});

/** The equivalent HTML template id, else the id itself. */
export function canonicalTemplateId(id: string): string {
  return Object.prototype.hasOwnProperty.call(DOCX_TEMPLATE_EQUIVALENTS, id) ? DOCX_TEMPLATE_EQUIVALENTS[id]! : id;
}
