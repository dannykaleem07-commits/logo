// owned by intake-server
/**
 * The rules reading (docs/SMART-INTAKE.md §5.3): for every item with text (and every photo), a deterministic
 * classification + field reading stored as an append-only `intake_extractions` row (`schemaId intake_rules/1`,
 * `extras.engine 'rules'`). It works with the AI paused; the AI reading, when it comes, wins (`bestIntakeExtraction`).
 * A rules reading never creates proposals on a claim by itself (`intake.apply` still runs after the AI extract only).
 */
import { classifyText, injectionFlags, ruleDocSide, ruleDocumentDate, ruleExtract, type DocType, type ExtractedField, type PdfMeta } from '@ccguk/domain';
import type { IntakeExtractionRecord, IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { NormalisedDoc } from './normalise.js';
import { docTypeLabel } from './proposals.js';

export const RULES_SCHEMA_ID = 'intake_rules/1';

/** Extras stored with every extraction row (rules and AI). */
export interface ExtractionExtras {
  engine: 'ai' | 'rules';
  documentDate: string | null;
  docSide: 'front' | 'back' | null;
  photo: { scene: string; plates: Array<{ text: string; confidence: number }>; damageZones: Array<{ zoneId: string; severity: number; confidence: number }>; notes: string | null } | null;
  segments: Array<{ fromPage: number; toPage: number; docType: string; confidence: number; title: string }>;
  pdfMeta: PdfMeta | null;
  docType?: string;
  docTypeConfidence?: number;
}

let insurerCache: { at: number; names: string[] } | undefined;

/** Insurer names for classification and reading: the insurer directory (names and brands) + insurer parties on file. */
export function insurerNames(ctx: AppContext): string[] {
  const now = Date.now();
  if (insurerCache && now - insurerCache.at < 60_000) return insurerCache.names;
  const names = new Set<string>();
  try {
    for (const e of ctx.kb.directory()) {
      if (e.name) names.add(e.name);
      for (const b of e.brands ?? []) if (b && b.length >= 4) names.add(b);
    }
  } catch {
    /* no KB data: parties only */
  }
  for (const p of ctx.repos.listParties(ctx.db, { roles: ['insurer'], limit: 2000 })) if (p.name) names.add(p.name);
  const list = [...names].filter((n) => n.trim().length >= 3).sort((a, b) => b.length - a.length);
  insurerCache = { at: now, names: list };
  return list;
}

/** Forget the cached insurer names (tests; a new insurer party). */
export function resetInsurerNames(): void {
  insurerCache = undefined;
}

/** Read the item's text with the rules and store the reading (append-only). */
export function storeRulesReading(ctx: AppContext, item: IntakeItemRecord, doc: NormalisedDoc, filename: string): { extraction: IntakeExtractionRecord; docType: DocType; confidence: number; fields: ExtractedField[] } {
  const pages = doc.pageTexts ?? [];
  const text = pages.join('\n');
  const names = insurerNames(ctx);
  const cls = classifyText(text, { filename, fingerprintTemplateId: doc.fingerprint?.templateId ?? null, isEmail: doc.kind === 'email', isImage: doc.kind === 'image', insurerNames: names });
  const fields = doc.kind === 'image' ? [] : ruleExtract(pages, cls.docType, { insurerNames: names });
  let documentDate = doc.kind === 'image' ? null : ruleDocumentDate(pages, cls.docType);
  if (!documentDate && doc.kind === 'email' && doc.email?.date) documentDate = doc.email.date.slice(0, 10);
  const extras: ExtractionExtras = {
    engine: 'rules',
    documentDate,
    docSide: ruleDocSide(pages, cls.docType),
    photo: null,
    segments: [],
    pdfMeta: doc.pdfMeta ?? null,
    docType: cls.docType,
    docTypeConfidence: cls.confidence,
  };
  const extraction = ctx.repos.appendIntakeExtraction(ctx.db, {
    intakeItemId: item.id,
    schemaId: RULES_SCHEMA_ID,
    fields,
    summary: `${docTypeLabel(cls.docType)} (read without AI)`,
    warnings: [],
    extras,
    now: ctx.now(),
  });
  // The rules classification shows only until the AI has classified the item.
  const hasAi = ctx.repos.listIntakeExtractions(ctx.db, item.id).some((e) => !e.schemaId.startsWith('intake_rules'));
  if (!hasAi) ctx.repos.updateIntakeItem(ctx.db, item.id, { docType: cls.docType, docTypeConfidence: cls.confidence }, ctx.now());
  return { extraction, docType: cls.docType, confidence: cls.confidence, fields };
}

/** Instruction-like text aimed at an AI in a document (code check; the document stays data only). */
export function documentInjectionFlags(doc: NormalisedDoc): string[] {
  const text = (doc.pageTexts ?? []).join('\n');
  if (!text.trim()) return [];
  return injectionFlags(text).filter((f) => f === 'instruction' || f === 'tool_reference' || f === 'zero_width');
}
