// owned by knowledge-research
/**
 * Prompt-injection defences (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.7, KR-9). Pure.
 *
 *  - `injectionFlags` runs over every stored snapshot (its text and raw HTML). A snapshot with `hidden_text` or
 *    `instruction` flags is WITHHELD from models ("withheld: possible instructions inside"); the owner can still view
 *    it in the app.
 *  - `directiveLint` finds instruction-like text aimed at an AI in a proposal's title and body; a hit rejects the
 *    proposal (KN-04) and flags the snapshot.
 */
import { htmlToText, ZERO_WIDTH_RE } from './htmlToText.js';

export type InjectionFlag = 'hidden_text' | 'instruction' | 'zero_width' | 'tool_reference';

/** Flags that withhold a snapshot from every model. */
export const WITHHOLDING_FLAGS: ReadonlySet<string> = new Set(['hidden_text', 'instruction', 'zero_width', 'tool_reference']);

interface Lint {
  id: string;
  re: RegExp;
}

/** Instruction-like phrases aimed at an AI. Kept specific so ordinary legal prose ("you are entitled to…") passes. */
const DIRECTIVES: readonly Lint[] = [
  { id: 'ignore_instructions', re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|existing|system|other)?\s*(?:instructions?|prompts?|rules?|directions?|guidance|context)\b/i },
  { id: 'role_assignment', re: /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|chatbot|language\s+model|llm|claude|gpt|agent|system|researcher|helpful)\b|\bact\s+as\s+(?:an?\s+)?(?:ai|assistant|system|admin(?:istrator)?|developer)\b|\bfrom\s+now\s+on,?\s+you\b/i },
  { id: 'system_prompt', re: /\b(?:system\s+prompt|developer\s+(?:message|mode)|jailbreak|prompt\s+injection|<\/?\s*(?:system|assistant|untrusted_[a-z]+)\s*>)/i },
  { id: 'exfiltrate', re: /\b(?:send|forward|email|upload|post|leak|exfiltrate)\s+(?:all|every|the\s+entire|any)\s+(?:claims?|data|records?|files?|emails?|details|information|contacts?)\b/i },
  { id: 'always_approve', re: /\b(?:always|automatically|auto[-\s]?)\s*(?:approve|accept|apply|send|settle|pay|trust|verify)\b|\bmark\s+(?:this|it|everything)\s+(?:as\s+)?(?:verified|approved|confirmed)\b|\bskip\s+(?:the\s+)?(?:review|approval|owner|checks?)\b/i },
  { id: 'add_rule', re: /\b(?:add|create|propose|insert|store|save)\s+(?:a\s+|this\s+|the\s+following\s+|new\s+)?(?:rule|instruction|memory|knowledge\s+item|policy)\b/i },
  { id: 'tool_reference', re: /\bmcp__[a-z0-9_]+|\b(?:knowledge_propose|knowledge_curate_propose|knowledge_gap_update|source_fetch|source_get|source_search|needs_you_create|email_draft|document_draft|outbox_send|memory_note|ledger_propose)\b/i },
  { id: 'do_not_tell', re: /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to|alert)\s+(?:the\s+)?(?:user|owner|human|operator)\b/i },
];

/** Instruction-like text aimed at an AI ("ignore", "you are", "system prompt", "send all", "always approve", "mcp__", tool names). */
export function directiveLint(text: string): string[] {
  const out: string[] = [];
  for (const d of DIRECTIVES) if (d.re.test(text)) out.push(d.id);
  return out;
}

/** Flags over snapshot text and raw HTML: 'hidden_text', 'instruction', 'zero_width', 'tool_reference'. */
export function injectionFlags(text: string, rawHtml?: string | null): string[] {
  const flags = new Set<InjectionFlag>();
  if (rawHtml) {
    if (htmlToText(rawHtml).hiddenText) flags.add('hidden_text');
    ZERO_WIDTH_RE.lastIndex = 0;
    if (ZERO_WIDTH_RE.test(rawHtml)) flags.add('zero_width');
    ZERO_WIDTH_RE.lastIndex = 0;
  }
  ZERO_WIDTH_RE.lastIndex = 0;
  if (ZERO_WIDTH_RE.test(text)) flags.add('zero_width');
  ZERO_WIDTH_RE.lastIndex = 0;
  const lint = directiveLint(text);
  if (lint.some((l) => l !== 'tool_reference')) flags.add('instruction');
  if (lint.includes('tool_reference')) flags.add('tool_reference');
  return [...flags];
}

/** Is a snapshot with these flags withheld from models? */
export const isWithheld = (flags: readonly string[]): boolean => flags.some((f) => WITHHOLDING_FLAGS.has(f));
