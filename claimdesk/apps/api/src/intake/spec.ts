// owned by intake
/**
 * The intake extractor (docs/SUPREME-DESIGN.md §C.1, §G.2 step 3, §A.6): Sonnet, medium effort, six turns, read access
 * for attachments, the intake tool subset (§B.4) and the `intake_extraction` result schema.
 *
 * The document text reaches the model only inside `<untrusted_document>` (delimiters escaped by the gateway, §K.1);
 * scanned PDFs and photos go as verified attachment copies. The CCGUK form fingerprint (computed in code) is a hint in
 * the brief, never an instruction.
 */
import { DOC_TYPES, FIELD_TARGETS, type Evidence } from '@ccguk/domain';
import type { IntakeItemRecord } from '@ccguk/db';
import type { AgentInput, AgentSpec } from '../agent/contracts.js';
import type { AiAttachment } from '../ai/types.js';
import { documentText, needsFileAttachment, type NormalisedDoc } from './normalise.js';

export const INTAKE_SPEC: AgentSpec = {
  name: 'intake',
  jobType: 'intake.extract',
  title: 'Intake: classify and extract',
  promptFiles: ['intake.md'],
  tools: ['claim_get', 'claims_search', 'evidence_read', 'vehicle_get', 'party_get', 'claim_field_propose', 'needs_you_create'],
  allowRead: true,
  resultSchemaId: 'intake_extraction',
  defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 5 * 60_000 },
};

/** The text the model gets (characters); longer documents are cut with a note. */
export const MODEL_TEXT_CHARS = 120_000;

export interface ExtractionContext {
  item: IntakeItemRecord;
  evidence: Evidence;
  doc: NormalisedDoc;
  /** Absolute path of the verified evidence file (for attachments). */
  absolutePath?: string;
  claimReference?: string;
}

/** The AgentInput for `intake.extract`. The task line carries a stable `[intake:<docKindHint>]` tag fixtures can match. */
export function extractionInput(c: ExtractionContext): AgentInput {
  const { item, evidence, doc } = c;
  const attachKind = needsFileAttachment(doc);
  const attachments: AiAttachment[] = [];
  if (attachKind && c.absolutePath) {
    attachments.push({ kind: attachKind, path: c.absolutePath, mime: doc.mime, sha256: evidence.sha256, label: evidence.filename, bytes: evidence.bytes });
  }
  let text = documentText(doc);
  let cut = false;
  if (text.length > MODEL_TEXT_CHARS) {
    text = text.slice(0, MODEL_TEXT_CHARS);
    cut = true;
  }
  const untrusted: NonNullable<AgentInput['untrusted']> = text ? [{ kind: doc.kind === 'email' ? 'email' : 'document', id: evidence.id, text }] : [];
  return {
    task: `Classify this document and extract its fields [intake:${doc.kind}${doc.scanned ? ':scanned' : ''}] — ${evidence.filename}`,
    brief: {
      intakeItemId: item.id,
      evidenceId: evidence.id,
      filename: evidence.filename,
      sniffedType: doc.sniffed,
      extensionMatches: doc.extensionMatches,
      pages: doc.pages ?? null,
      scanned: doc.scanned ?? false,
      textTruncated: Boolean(doc.textTruncated) || cut,
      claim: item.claimId ? { id: item.claimId, reference: c.claimReference ?? null } : null,
      email: doc.email ?? null,
      ccgukFormFingerprint: doc.fingerprint ?? null,
      allowedDocTypes: DOC_TYPES,
      allowedTargets: FIELD_TARGETS,
    },
    untrusted,
    attachments,
    question: [
      'Classify the document (docType + confidence) and extract every field the field list for that type names, each as {name, target, value, confidence, page, quote}.',
      'Use target only from allowedTargets (null when a value maps to no claim field). Quote the exact words you read the value from. Never guess a value: leave it out or give a low confidence.',
      attachments.length ? 'The document is attached as a file in ./input — read it with the Read tool.' : '',
      item.claimId ? 'The document belongs to the claim in the brief. You may read the claim with claim_get to see what is already on file.' : 'No claim is linked yet. Do not search for one unless the document names a ClaimDesk reference (CCG-YYYY-NNNNN).',
      'Return the IntakeExtraction JSON only.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
