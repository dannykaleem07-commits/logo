// owned by casework
/**
 * Brain packs and memory client (docs/SUPREME-DESIGN.md §E.5, §E.6, §L.10, §N.6). Shapes of
 * apps/api/src/routes/brain.ts, declared here (web code never imports API code).
 *
 *   GET  /brain/packs                          packs + versions + preview, staged files in the brain-packs folder
 *   POST /brain/packs/import                   {importId} | {uploadId} | {path}  (admin)
 *   GET  /brain/packs/:id/versions/:version    preview
 *   POST /brain/packs/:id/activate             {version?, business?, precedence?, useForCcguk?}  (admin)
 *   POST /brain/packs/:id/deactivate           (admin)
 *   GET  /brain/search?q=&kinds=&business=
 *   GET  /memory?status=  ·  POST /memory/:id/approve | retire
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Basis } from '@ccguk/domain';
import { request, seg } from './client';

export type Business = 'ccguk' | 'fixmyfile';
export const BUSINESS_LABEL: Record<Business, string> = { ccguk: 'Courtesy Cars (CCGUK)', fixmyfile: 'Fixmyfile' };

export interface PackPreview {
  packId: string;
  name: string;
  version: string;
  kind: 'ccguk' | 'playbook' | 'learned' | 'other';
  sourceKind: 'ccbrain' | 'folder' | 'skill';
  business: string[];
  precedence: number;
  entries: number;
  byKind: Record<string, number>;
  sample: Array<{ id: string; kind: string; title: string }>;
  redLines: Array<{ id: string; title: string; action: string }>;
  warnings: string[];
  sha256: string;
}

export interface PackVersion {
  version: string;
  sha256: string;
  entries: number;
  source: string;
  importedAt: string;
  importedBy: string;
}

export interface BrainPack {
  id: string;
  name: string;
  kind: PackPreview['kind'];
  activeVersion?: string;
  business: string[];
  precedence: number;
  useForCcguk: boolean;
  createdAt: string;
  updatedAt: string;
  versions: PackVersion[];
  preview: PackPreview | null;
}

export interface StagedPackFile {
  id: string;
  filename: string;
  bytes: number;
  sha256: string;
  receivedAt: string;
  status: 'staged' | 'consumed' | 'failed';
  error?: string;
}

export interface ImportResult {
  pack: BrainPack;
  version: PackVersion & { packId: string; storagePath: string };
  preview: PackPreview;
  duplicate: boolean;
}

export interface BrainHit {
  packId: string;
  packName: string;
  version: string;
  precedence: number;
  entryId: string;
  ref: string;
  kind: string;
  title: string;
  excerpt: string;
  verification: string | null;
  business: string[];
}

export interface MemoryItem {
  id: string;
  kind: 'note' | 'correction' | 'outcome' | 'preference' | 'research';
  scope: string;
  text: string;
  basis: Basis[];
  status: 'proposed' | 'approved' | 'retired';
  createdBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export type ImportSource = { importId: string } | { uploadId: string } | { path: string };

export interface ActivateBody {
  version?: string;
  business?: Business[];
  precedence?: number;
  useForCcguk?: boolean;
}

export const brainApi = {
  packs: () => request<{ packs: BrainPack[]; staged: StagedPackFile[] }>('/brain/packs'),
  import: (src: ImportSource) => request<ImportResult>('/brain/packs/import', { method: 'POST', body: src }),
  preview: (id: string, version: string) => request<PackPreview>(`/brain/packs/${seg(id)}/versions/${seg(version)}`),
  activate: (id: string, body: ActivateBody) => request<BrainPack>(`/brain/packs/${seg(id)}/activate`, { method: 'POST', body }),
  deactivate: (id: string) => request<BrainPack>(`/brain/packs/${seg(id)}/deactivate`, { method: 'POST', body: {} }),
  search: (q: string, business: Business = 'ccguk') => request<{ hits: BrainHit[] }>('/brain/search', { query: { q, business } }),
  memory: (status: 'proposed' | 'approved' | 'retired' | 'all' = 'proposed') => request<{ items: MemoryItem[]; counts: { proposed: number; approved: number } }>('/memory', { query: { status } }),
  approveMemory: (id: string) => request<MemoryItem>(`/memory/${seg(id)}/approve`, { method: 'POST', body: {} }),
  retireMemory: (id: string) => request<MemoryItem>(`/memory/${seg(id)}/retire`, { method: 'POST', body: {} }),
};

export const brainQk = {
  all: ['brain'] as const,
  packs: ['brain', 'packs'] as const,
  memory: (status: string) => ['brain', 'memory', status] as const,
  search: (q: string, business: string) => ['brain', 'search', q, business] as const,
};

export function useBrainPacks() {
  return useQuery({ queryKey: brainQk.packs, queryFn: brainApi.packs });
}

export function useMemory(status: 'proposed' | 'approved' | 'retired' | 'all' = 'proposed') {
  return useQuery({ queryKey: brainQk.memory(status), queryFn: () => brainApi.memory(status) });
}

export function useBrainSearch(q: string, business: Business) {
  return useQuery({ queryKey: brainQk.search(q, business), queryFn: () => brainApi.search(q, business), enabled: q.trim().length >= 2 });
}

export function useBrainMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: brainQk.all }) });
}
