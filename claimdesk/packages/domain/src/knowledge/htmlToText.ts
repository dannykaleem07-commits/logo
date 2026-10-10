// owned by knowledge-research
/**
 * Fetched page → text (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3): drops script, style, noscript, template, comments and
 * hidden elements (display:none, hidden, aria-hidden, zero-width runs) and reports whether hidden text was present. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 */
import { notImplemented } from './notImplemented.js';

export interface HtmlTextResult {
  text: string;
  title: string | null;
  hiddenText: boolean;
}

export function htmlToText(_html: string): HtmlTextResult {
  return notImplemented('knowledge-research', 'htmlToText');
}
