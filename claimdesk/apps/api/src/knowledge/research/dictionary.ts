// owned by knowledge-research
/**
 * The per-run ClaimDictionary (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.6, KR-7): hashed tokens of every individual's name,
 * every VRM, our claim references and the insurers' references / policy numbers in the database. Built per call (the
 * DB is the owner's; a few thousand hashes), never stored and never sent. Insurer names are not included: they are
 * public entities and research may name them.
 */
import { buildClaimDictionary, type ClaimDictionary } from '@ccguk/domain';
import type { AppContext } from '../../context.js';

export function claimDictionaryFor(ctx: AppContext): ClaimDictionary {
  const sqlite = ctx.handle.sqlite;
  const col = (q: string): string[] => (sqlite.prepare(q).all() as Array<{ v: string | null }>).map((r) => r.v).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return buildClaimDictionary({
    name: [...col(`SELECT name AS v FROM parties WHERE kind = 'individual'`), ...col(`SELECT trading_name AS v FROM parties WHERE kind = 'individual'`)],
    vrm: col(`SELECT registration AS v FROM vehicles`),
    claim_ref: col(`SELECT reference AS v FROM claims`),
    insurer_ref: [...col(`SELECT at_fault_insurer_ref AS v FROM claims`), ...col(`SELECT client_policy_number AS v FROM claims`)],
  });
}
