// owned by claimai-web
/**
 * Synthetic AI input fixtures (invented names, references and addresses; no private data). Each call returns a fresh
 * copy, so tests may change it freely. `claimAiApi.test.ts` checks every fixture carries every key of the §11.1 types.
 */
import previewRaw from './updatePreview.json';
import appliedRaw from './updateApplied.json';
import catchUpRaw from './catchUp.json';
import panelRaw from './panel.json';
import type { AiInputDetail, AiInputPanel } from '../../../../api/claimAiApi';

export const updatePreview = (): AiInputDetail => structuredClone(previewRaw) as unknown as AiInputDetail;
export const updateApplied = (): AiInputDetail => structuredClone(appliedRaw) as unknown as AiInputDetail;
export const catchUpDetail = (): AiInputDetail => structuredClone(catchUpRaw) as unknown as AiInputDetail;
export const panelFixture = (): AiInputPanel => structuredClone(panelRaw) as unknown as AiInputPanel;

/** The key paths of §11.1 a full answer carries (key paths, not values). */
export const SUMMARY_KEYS = ['id', 'claimId', 'kind', 'channel', 'status', 'statusLabel', 'excerpt', 'createdAt', 'createdBy', 'createdByName', 'appliedAt', 'engine', 'counts', 'headline', 'waiting', 'bundle'] as const;
export const DETAIL_KEYS = [...SUMMARY_KEYS, 'text', 'extraText', 'understood', 'actions', 'questions', 'notDone', 'pendingText', 'warnings', 'catchUp', 'whatChanged', 'log', 'canApply', 'canUndo', 'canCancel', 'canThinkAgain', 'revision'] as const;
export const ACTION_KEYS = ['key', 'type', 'tier', 'tierLabel', 'ticked', 'tickable', 'title', 'detail', 'why', 'at', 'precision', 'quote', 'source', 'from', 'confidence', 'current', 'params', 'editable', 'undo', 'state', 'result', 'link', 'bundleFileId'] as const;
export const CATCH_UP_FILE_KEYS = [
  'fileId', 'itemId', 'evidenceId', 'filename', 'mime', 'bytes', 'role', 'parentFileId', 'segment', 'stage', 'stageLabel', 'waiting', 'docType', 'docTypeLabel', 'pages', 'groupKey', 'plan', 'planLabel',
  'alreadyOnFile', 'duplicateOf', 'otherClaim', 'direction', 'directionWhy', 'directionConfidence', 'directionSetBy', 'realDate', 'dateSource', 'dateWhy', 'dateFlag', 'kind', 'kindLabel', 'counterparty',
  'alreadyRecorded', 'evidenceKind', 'filed', 'recorded', 'fileUrl',
] as const;
export const CATCH_UP_VIEW_KEYS = ['bundleId', 'readiness', 'autoApply', 'filesDone', 'fileCounts', 'files', 'willDo', 'blockers', 'note'] as const;
export const PANEL_KEYS = ['claim', 'ai', 'open', 'instructions', 'history', 'badge'] as const;
export const INSTRUCTION_KEYS = ['id', 'claimId', 'text', 'appliesTo', 'appliesToLabel', 'effect', 'effectLabel', 'activeFrom', 'until', 'status', 'createdBy', 'createdByName', 'createdAt', 'source', 'retiredBy', 'retiredAt', 'retiredReason'] as const;
