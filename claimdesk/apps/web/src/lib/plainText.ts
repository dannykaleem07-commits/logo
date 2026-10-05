/**
 * Plain English for text that comes from the server or the knowledge base (docs/V03-MANAGER-MODE-HIRE-PRICING.md §E8):
 * internal design references such as "(lesson g)", "(RENTX, lesson l)", "— live file lesson k" or "BLUEPRINT §3.1" are removed before the text
 * is shown. The stored text is never changed.
 */
const TEMPLATE_ID = /\b(form|letter|invoice|report|pack|notice|agreement|statement|schedule|bundle|certificate)\.([a-z0-9]+(?:_[a-z0-9]+)*)\b/g;
const KIND_WORD: Record<string, string> = { form: 'form', letter: 'letter', invoice: 'invoice', report: 'report', pack: 'pack', notice: 'notice', agreement: 'agreement', statement: 'statement', schedule: 'schedule', bundle: 'bundle', certificate: 'certificate' };

/** "form.statement_of_means" → "statement of means form"; "report.engineer" → "engineer report". */
export function templateIdText(kind: string, rest: string): string {
  const words = rest.replace(/_/g, ' ');
  return words.endsWith(KIND_WORD[kind] ?? kind) ? words : `${words} ${KIND_WORD[kind] ?? kind}`;
}

export function plainText(text: string): string {
  return text
    // "(form.statement_of_means)" on its own says nothing more than the sentence before it
    .replace(/\s*\((?:form|letter|invoice|report|pack|notice|agreement|statement|schedule|bundle|certificate)\.[a-z0-9_]+\)/g, '')
    .replace(TEMPLATE_ID, (_m, kind: string, rest: string) => templateIdText(kind, rest))
    .replace(/\s*\([^()]*\b(?:lessons?|BLUEPRINT)\b[^()]*\)/gi, '')
    .replace(/\s*BLUEPRINT\s*(?:§\s*[\d.]+(?:\([a-z]\))?|principle\s*\d+)/gi, '')
    .replace(/\s*[—–-]\s*(?:live[- ]file\s+)?lessons?\s+[a-z](?:\s*(?:,|and)\s*[a-z])*\b/gi, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}
