import { z } from 'zod';
import { id, isoDate, pence, signedPence } from './common.js';

export const headOfLoss = z.enum([
  'hire', 'recovery', 'storage', 'engineer_fee', 'pav', 'repair', 'salvage', 'excess', 'loss_of_use', 'diminution', 'personal_effects',
  'loss_of_earnings', 'travel', 'misc', 'interest', 'court_fee', 'fixed_costs',
]);
export const ledgerKind = z.enum(['claimed', 'invoiced', 'offered', 'reduced', 'paid', 'interim_paid', 'written_off', 'adjustment']);

export const ledgerEntryBody = z.object({
  head: headOfLoss,
  kind: ledgerKind,
  amountPence: signedPence,
  vatPence: pence.optional(),
  date: isoDate,
  description: z.string().trim().min(1),
  counterpartyId: id.optional(),
  reference: z.string().optional(),
  sourceDocumentId: id.optional(),
  sourceEvidenceId: id.optional(),
  supersedesId: id.optional(),
});

export const ledgerListQuery = z.object({
  head: headOfLoss.optional(),
  kind: ledgerKind.optional(),
  includeSuperseded: z.enum(['true', 'false']).optional(),
});
