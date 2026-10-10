// owned by knowledge-ui
/**
 * Knowledge Builder client (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3, §11). STUB created by knowledge-core with the
 * core routes; knowledge-ui adds hooks and the learners / research / use routes. Shapes come from @ccguk/domain
 * (knowledge/api.ts) — web code never imports API code.
 */
import type {
  ApproveKnowledgeBody,
  KnowledgeDigest,
  KnowledgeItemDetail,
  KnowledgeItemsResponse,
  KnowledgeQueueResponse,
  KnowledgeSettings,
  KnowledgeSettingsPatch,
  KnowledgeStatusResponse,
  KnowledgeVersionsResponse,
} from '@ccguk/domain';
import { request, seg } from './client';

export const knowledgeApi = {
  status: () => request<KnowledgeStatusResponse>('/knowledge/status'),
  items: (query: Record<string, string | number | undefined> = {}) => request<KnowledgeItemsResponse>('/knowledge/items', { query }),
  item: (id: string) => request<KnowledgeItemDetail>(`/knowledge/items/${seg(id)}`),
  queue: () => request<KnowledgeQueueResponse>('/knowledge/queue'),
  approve: (id: string, body: ApproveKnowledgeBody = {}) => request<unknown>(`/knowledge/items/${seg(id)}/approve`, { method: 'POST', body }),
  reject: (id: string, reason: string) => request<unknown>(`/knowledge/items/${seg(id)}/reject`, { method: 'POST', body: { reason } }),
  retire: (id: string, reason: string) => request<unknown>(`/knowledge/items/${seg(id)}/retire`, { method: 'POST', body: { reason } }),
  versions: () => request<KnowledgeVersionsResponse>('/knowledge/versions'),
  digest: (day?: string) => request<KnowledgeDigest>('/knowledge/digest', { query: day ? { day } : {} }),
  settings: () => request<KnowledgeSettings>('/knowledge/settings'),
  patchSettings: (patch: KnowledgeSettingsPatch) => request<KnowledgeSettings>('/knowledge/settings', { method: 'PATCH', body: patch }),
};
