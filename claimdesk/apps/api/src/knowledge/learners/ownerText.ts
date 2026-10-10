// owned by knowledge-learners
/**
 * L6 owner-written letters → snippets (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.6) — `knowledge.observe` source
 * `owner_text`.
 *
 * Inputs: outbox emails a person wrote and sent, and documents a person wrote (approved or sent). Each body paragraph
 * that is not already in ClaimDesk's own wording (shingle Jaccard < 0.8 against agent-drafted letters of the same
 * template / email kind and against the existing snippets) is generalised — amounts → [amount], dates → [date],
 * references → [ref], party names → [name] — and proposed as a `template_snippet` (origin observed, owner-authored).
 * Fully generalised → KN-17 applies it automatically; if any literal remains it waits for the owner.
 */
import { generaliseSnippet, paragraphsOf, shingleJaccard, type KnowledgeProposal, type TemplateSnippetData } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { proposeKnowledge } from '../store.js';
import { LEARNER, advanceWatermark, all, documentHtmlToText, isPerson, json, one, watermark } from './common.js';

export const SNIPPET_SIMILARITY_MAX = 0.8;
const MAX_PER_RUN = 25;
/** Templates whose body the owner writes freely; any other template's text is ClaimDesk's own wording unless edited. */
export const FREE_TEXT_TEMPLATES: readonly string[] = ['letter.other', 'letter.ccguk_letterhead_formal'];

function namesFor(ctx: AppContext, claimId: string | null): string[] {
  if (!claimId) return [];
  const c = one<{ claimant_id: string; driver_id: string | null; third_party_ids: string; at_fault_insurer_id: string | null; client_insurer_id: string | null; handler_id: string | null }>(
    ctx,
    `SELECT claimant_id, driver_id, third_party_ids, at_fault_insurer_id, client_insurer_id, handler_id FROM claims WHERE id = ?`,
    claimId,
  );
  if (!c) return [];
  const ids = [c.claimant_id, c.driver_id, c.at_fault_insurer_id, c.client_insurer_id, c.handler_id, ...(json<string[]>(c.third_party_ids) ?? [])].filter((x): x is string => Boolean(x));
  const names = ids.map((id) => one<{ name: string }>(ctx, `SELECT name FROM parties WHERE id = ?`, id)?.name).filter((x): x is string => Boolean(x));
  return [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/).filter((w) => w.length >= 3 && /^[A-Z][a-z]/.test(w))]))];
}

export interface OwnerTextResult {
  scanned: number;
  proposed: { itemId: string; outcome: string }[];
  skippedSimilar: number;
}

export function observeOwnerText(ctx: AppContext): OwnerTextResult {
  const out: OwnerTextResult = { scanned: 0, proposed: [], skippedSimilar: 0 };
  const existing = ctx.repos.listKnowledgeItems(ctx.db, { kind: 'template_snippet', status: ['active', 'proposed', 'rejected'], limit: 2000 }).items.map((i) => (i.data as TemplateSnippetData).text);
  const consider = (src: { kind: 'outbox' | 'document'; id: string; claimId: string | null; text: string; createdBy: string; at: string; emailKind: string | null; templateId: string | null; reference: string[] }): void => {
    out.scanned += 1;
    const names = namesFor(ctx, src.claimId);
    for (const para of paragraphsOf(src.text)) {
      if (out.proposed.length >= MAX_PER_RUN) return;
      const g = generaliseSnippet(para, names);
      if ([...existing, ...src.reference].some((t) => shingleJaccard(t, g.text) >= SNIPPET_SIMILARITY_MAX)) {
        out.skippedSimilar += 1;
        continue;
      }
      existing.push(g.text);
      const data: TemplateSnippetData = { purpose: `The owner's own wording${src.emailKind ? ` in a ${src.emailKind.replace(/_/g, ' ')} email` : src.templateId ? ` in ${src.templateId}` : ''}`, emailKind: src.emailKind, templateId: src.templateId, recipientRole: null, text: g.text, tokens: g.tokens };
      const proposal: KnowledgeProposal<TemplateSnippetData> = {
        kind: 'template_snippet',
        area: 'style',
        title: `Owner wording: ${g.text.slice(0, 80)}${g.text.length > 80 ? '…' : ''}`.slice(0, 200),
        body: g.text,
        data,
        tags: ['owner_style', ...(src.emailKind ? [`email:${src.emailKind}`] : []), ...(src.templateId ? [`template:${src.templateId}`.slice(0, 64)] : [])],
        scope: { kind: 'global' },
        business: ['ccguk'],
        useLimit: 'internal',
        origin: 'observed',
        confidence: 0.9,
        supportN: 1,
        provenance: [
          { kind: 'owner', userId: src.createdBy, at: src.at, note: `written by the owner (${src.kind} ${src.id})` },
          ...(src.kind === 'document' ? [{ kind: 'document' as const, documentId: src.id, evidenceId: null, page: null, quote: null }] : []),
        ],
        createdBy: LEARNER,
      };
      const r = proposeKnowledge(ctx, proposal, { snippet: { ownerAuthored: true, fullyGeneralised: !g.literalsRemain } });
      if (r.created) out.proposed.push({ itemId: r.item.id, outcome: r.decision.outcome });
    }
  };

  // Outbox emails a person wrote, once sent.
  const wOut = watermark(ctx, 'owner_text:outbox');
  const emails = all<{ id: string; claim_id: string | null; kind: string; body_text: string; created_by: string; updated_at: string }>(
    ctx,
    `SELECT id, claim_id, kind, body_text, created_by, updated_at FROM outbox WHERE status = 'sent' AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at, id LIMIT 500`,
    wOut.lastAt,
    wOut.lastAt,
    wOut.lastId ?? '',
  );
  for (const e of emails) {
    if (!isPerson(e.created_by)) continue;
    const agentWording = all<{ body_text: string }>(ctx, `SELECT body_text FROM outbox WHERE kind = ? AND created_by LIKE 'agent:%' ORDER BY created_at DESC LIMIT 20`, e.kind).flatMap((r) => paragraphsOf(r.body_text));
    consider({ kind: 'outbox', id: e.id, claimId: e.claim_id, text: e.body_text, createdBy: e.created_by, at: e.updated_at, emailKind: e.kind, templateId: null, reference: agentWording });
  }
  if (emails.length) advanceWatermark(ctx, 'owner_text:outbox', emails[emails.length - 1]!.updated_at, emails[emails.length - 1]!.id);

  // Documents a person wrote (approved or sent).
  const wDoc = watermark(ctx, 'owner_text:documents');
  const docs = all<{ id: string; claim_id: string | null; template_id: string; html: string; created_by: string; created_at: string; updated_at: string; supersedes_id: string | null }>(
    ctx,
    `SELECT id, claim_id, template_id, html, created_by, created_at, updated_at, supersedes_id FROM documents WHERE status IN ('approved','sent','signed') AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at, id LIMIT 500`,
    wDoc.lastAt,
    wDoc.lastAt,
    wDoc.lastId ?? '',
  );
  for (const d of docs) {
    // Only text the owner wrote: a free-text template, or an edit that supersedes an earlier document.
    if (!isPerson(d.created_by) || (!d.supersedes_id && !FREE_TEXT_TEMPLATES.includes(d.template_id))) continue;
    const agentWording = all<{ html: string }>(ctx, `SELECT html FROM documents WHERE template_id = ? AND id <> ? AND (supersedes_id IS NULL OR id = ?) ORDER BY created_at DESC LIMIT 10`, d.template_id, d.id, d.supersedes_id ?? '').flatMap((r) => paragraphsOf(documentHtmlToText(r.html)));
    consider({ kind: 'document', id: d.id, claimId: d.claim_id, text: documentHtmlToText(d.html), createdBy: d.created_by, at: d.created_at, emailKind: null, templateId: d.template_id, reference: agentWording });
  }
  if (docs.length) advanceWatermark(ctx, 'owner_text:documents', docs[docs.length - 1]!.updated_at, docs[docs.length - 1]!.id);
  return out;
}
