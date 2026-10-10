// owned by knowledge-research
/**
 * Prompt-injection defences (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.7, KR-9). STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 */
import { notImplemented } from './notImplemented.js';

/** Flags over snapshot text and raw HTML: 'hidden_text', 'instruction', … (a flagged snapshot is withheld from models). */
export function injectionFlags(_text: string, _rawHtml?: string | null): string[] {
  return notImplemented('knowledge-research', 'injectionFlags');
}

/** Instruction-like text aimed at an AI ("ignore", "you are", "system prompt", "send all", "always approve", "mcp__", tool names). */
export function directiveLint(_text: string): string[] {
  return notImplemented('knowledge-research', 'directiveLint');
}
