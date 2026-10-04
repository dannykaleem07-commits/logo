export type { KbEntry, KbEntryType, InsurerDirectoryEntry, GtaRate, Verification } from '@ccguk/domain';
// Loaders, search and advisor are added by the knowledge-base build agents:
//   ./load.ts    — typed loaders for ../data/*.json
//   ./search.ts  — BM25-style retrieval with citations
//   ./advisor.ts — assembles cited guidance for a claim state (human-approved, never auto-sent)
