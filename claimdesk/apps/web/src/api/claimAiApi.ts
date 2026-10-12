// owned by claimai-web
/**
 * AI input on a claim — client (docs/CLAIM-AI-INPUT.md §11). Web code never imports API code and does not depend on new
 * @ccguk/domain exports, so every JSON shape of §11.1 is declared here (frozen contract, §17.3).
 *
 *   GET   /claims/:id/ai-input                                   → AiInputPanel
 *   GET   /claims/:id/ai-input/inputs?limit&offset&kind          → { items: AiInputSummary[], total }
 *   POST  /claims/:id/ai-input/updates {text, channel?, extraText?} → 201 AiInputDetail
 *   GET   /claims/:id/ai-input/:inputId                          → AiInputDetail   (polled: 2 s interpreting/applying, 5 s waiting_ai/reading)
 *   POST  …/:inputId/answers {answers}                           → AiInputDetail
 *   POST  …/:inputId/apply {actions?}                            → AiInputDetail
 *   POST  …/:inputId/undo {actionKeys?, reason?}                 → AiInputDetail
 *   POST  …/:inputId/cancel · /think-again · /files-done         → AiInputDetail
 *   POST  /claims/:id/ai-input/catch-up {note?, autoApply?}      → 201 AiInputDetail (upload to catchUp.bundleId)
 *   POST  …/:inputId/files/:fileId {direction?, date?, kind?, notThisClaim?} → AiInputDetail
 *   PATCH /claims/:id/ai-input/:inputId {autoApply}              → AiInputDetail
 *   GET   /claims/:id/instructions?status=active|all             → { items: StandingInstruction[] }
 *   POST  /claims/:id/instructions {text, appliesTo?, until?, effect?} → 201 StandingInstruction
 *   POST  /claims/:id/instructions/:instructionId/retire {reason?} → StandingInstruction
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, seg } from './client';

// ---------------------------------------------------------------------------
// §11.1 JSON types
// ---------------------------------------------------------------------------

export type AiInputKind = 'update' | 'catch_up';
export type AiInputChannel = 'typed' | 'call_note' | 'voice_note' | 'upload';
export type AiInputStatus = 'interpreting' | 'waiting_ai' | 'clarify' | 'preview' | 'reading' | 'applying' | 'applied' | 'partly_applied' | 'nothing_to_do' | 'cancelled' | 'failed' | 'undone';
export type ActionType =
  | 'event'
  | 'note'
  | 'field_update'
  | 'liability_position'
  | 'hire_end'
  | 'hire_correct'
  | 'hire_start'
  | 'task'
  | 'instruction'
  | 'pause_agents'
  | 'resume_agents'
  | 'run_job'
  | 'money'
  | 'offer_received'
  | 'offer_decision'
  | 'legal'
  | 'status_change'
  | 'close_or_decline'
  | 'private_note'
  | 'unsupported'
  | 'file_evidence'
  | 'record_correspondence';
export type ActionTier = 'apply' | 'confirm' | 'needs_you' | 'open_screen' | 'refused' | 'private';
export type ActionState = 'proposed' | 'applied' | 'not_applied' | 'skipped' | 'failed' | 'needs_you' | 'undone';
export type WaitingReason = 'agents_off' | 'kill_switch' | 'usage' | 'sign_in';
export type ContactRole = 'client' | 'at_fault_insurer' | 'engineer' | 'repairer' | 'supplier' | 'solicitor' | 'anyone';
export type AgentScope = 'all' | 'autopilot' | 'case_manager' | 'mail' | 'drafter' | 'intake';
export type EditableField = 'at' | 'value' | 'dueAt' | 'until' | 'text' | 'appliesTo';

export interface AiWaiting {
  reason: WaitingReason;
  until?: string;
}

export interface ActionRefs {
  eventId?: string;
  correctingEventId?: string;
  taskId?: string;
  instructionId?: string;
  proposalId?: string;
  hireId?: string;
  needsYouId?: string;
  jobId?: string;
  outboxId?: string;
  offerId?: string;
  correspondenceId?: string;
  evidenceId?: string;
}

export interface AiAction {
  key: string;
  type: ActionType;
  tier: ActionTier;
  /** "Will do" | "Needs your tick" | "Goes to Needs-you" | "Open the screen" | "Won't do" | "Private note" */
  tierLabel: string;
  ticked: boolean;
  tickable: boolean;
  title: string;
  detail: string | null;
  why: string | null;
  at: string | null;
  precision: 'date' | 'datetime' | null;
  quote: string | null;
  source: 'rules' | 'ai' | 'catch_up';
  from: 'owner_text' | 'transcript' | 'document';
  confidence: number;
  /** Value on file now (field / liability / hire date / status). */
  current: string | null;
  /** ActionParams (display only; the server re-validates). */
  params: Record<string, unknown>;
  editable: EditableField[];
  undo: { available: boolean; why: string | null };
  state: ActionState;
  result: { refs: ActionRefs; message: string | null; error: { code: string; message: string } | null; at: string | null } | null;
  /** In-app path ("/claims/<id>/hire", "/needs-you?item=<id>"). */
  link: string | null;
  bundleFileId: string | null;
}

export interface AiQuestion {
  id: string;
  text: string;
  options: Array<{ id: string; label: string }>;
  allowText: boolean;
  allowDate: boolean;
  /** Action key the question is about. */
  about: string | null;
  answer: { optionId: string | null; text: string | null; date: string | null } | null;
}

export type WhatChangedKind = 'filed' | 'recorded' | 'event' | 'field' | 'hire' | 'task' | 'instruction' | 'agents' | 'job' | 'needs_you' | 'clock' | 'autopilot' | 'not_done';

export interface WhatChanged {
  lines: Array<{ kind: WhatChangedKind; text: string; link: string | null }>;
  clocks: Array<{ label: string; before: string | null; after: string; status: string }>;
  autopilot: { stopped: string | null; firstSteps: Array<{ id: string; title: string; status: string; sentence: string }> } | null;
}

export interface AiInputCounts {
  actions: number;
  applied: number;
  waitingTick: number;
  needsYou: number;
  undone: number;
  failed: number;
  questions: number;
}

export interface AiInputSummary {
  id: string;
  claimId: string;
  kind: AiInputKind;
  channel: AiInputChannel;
  status: AiInputStatus;
  statusLabel: string;
  /** First 200 chars of the owner's text (or the catch-up note / file count). */
  excerpt: string;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  appliedAt: string | null;
  engine: 'rules' | 'ai' | 'rules_ai' | 'catch_up' | null;
  counts: AiInputCounts;
  /** "Hire ended 11 Oct · reminder Mon · 1 for Needs-you" */
  headline: string;
  waiting: AiWaiting | null;
  bundle: { id: string; files: number; inProgress: number; filed: number } | null;
}

export type CatchUpPlanKind = 'file_and_record' | 'file_only' | 'already_on_file' | 'other_claim' | 'excluded' | 'ask';
export type CatchUpDirection = 'out' | 'in' | 'none' | 'unknown';
export type CatchUpDateSource = 'document' | 'email_header' | 'owner' | 'file_metadata';

export interface CatchUpFile {
  fileId: string;
  itemId: string;
  evidenceId: string;
  filename: string;
  mime: string;
  bytes: number;
  role: string;
  parentFileId: string | null;
  segment: { fromPage: number; toPage: number } | null;
  stage: string;
  stageLabel: string;
  waiting: AiWaiting | null;
  docType: string | null;
  docTypeLabel: string | null;
  pages: number | null;
  groupKey: string;
  plan: CatchUpPlanKind;
  /** "File and record" | "Just file" | "Already on file" | "Belongs to CCG-…" | "Not filed" | "Who sent it?" */
  planLabel: string;
  alreadyOnFile: { evidenceId: string; how: 'same_file' | 'same_text' } | null;
  duplicateOf: string | null;
  otherClaim: { id: string; reference: string; reasons: string[] } | null;
  direction: CatchUpDirection;
  directionWhy: string;
  directionConfidence: number;
  directionSetBy: 'auto' | 'owner';
  realDate: string | null;
  dateSource: CatchUpDateSource | null;
  dateWhy: string;
  dateFlag: string | null;
  kind: string | null;
  kindLabel: string | null;
  counterparty: string | null;
  alreadyRecorded: { how: 'event' | 'outbox' | 'document' | 'correspondence'; at: string; text: string } | null;
  evidenceKind: string;
  filed: { evidenceId: string; kind: string; at: string } | null;
  recorded: { correspondenceId: string; eventId: string | null } | null;
  /** "/api/evidence/<evidenceId>/file" */
  fileUrl: string;
}

export interface CatchUpView {
  bundleId: string;
  readiness: 'reading' | 'ready' | 'applied';
  autoApply: boolean;
  filesDone: boolean;
  fileCounts: { total: number; read: number; inProgress: number; waitingAi: number; failed: number; skipped: number; duplicates: number };
  files: CatchUpFile[];
  willDo: string[];
  blockers: Array<{ code: string; text: string; fileId: string | null }>;
  note: string | null;
}

export interface AiInputLogLine {
  seq: number;
  at: string;
  kind: string;
  actionKey: string | null;
  actor: string;
  actorName: string | null;
  note: string | null;
}

export interface AiInputDetail extends AiInputSummary {
  text: string;
  extraText: string | null;
  understood: string | null;
  actions: AiAction[];
  questions: AiQuestion[];
  /** Not understood / dropped by validation. */
  notDone: Array<{ text: string; why: string }>;
  /** Clauses waiting for the AI. */
  pendingText: string[];
  warnings: string[];
  catchUp: CatchUpView | null;
  whatChanged: WhatChanged | null;
  log: AiInputLogLine[];
  canApply: boolean;
  canUndo: boolean;
  canCancel: boolean;
  canThinkAgain: boolean;
  revision: number;
}

export type InstructionEffect = { kind: 'hold_contact' | 'ask_before_sending'; contacts: ContactRole[] } | { kind: 'pause_agents' } | { kind: 'none' };

export interface StandingInstruction {
  id: string;
  claimId: string;
  text: string;
  appliesTo: AgentScope[];
  appliesToLabel: string;
  effect: InstructionEffect | null;
  effectLabel: string | null;
  activeFrom: string;
  until: string | null;
  status: 'active' | 'ended' | 'retired';
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  source: { inputId: string; actionKey: string | null } | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

export interface AiInputPanel {
  claim: { id: string; reference: string; status: string };
  ai: { available: boolean; waiting: AiWaiting | null };
  /** Inputs needing the owner (interpreting/waiting_ai/clarify/preview/reading/partly_applied). */
  open: AiInputSummary[];
  /** Active first, then ended/retired (newest 20). */
  instructions: StandingInstruction[];
  /** Newest 20. */
  history: { items: AiInputSummary[]; total: number };
  badge: { open: number; instructions: number };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface CreateUpdateBody {
  text: string;
  channel?: 'typed' | 'call_note' | 'voice_note';
  extraText?: string;
}

export interface AnswerBody {
  questionId: string;
  optionId?: string;
  text?: string;
  date?: string;
}

export interface ActionEdits {
  at?: string;
  value?: string;
  dueAt?: string;
  until?: string | null;
  text?: string;
  appliesTo?: AgentScope[];
}

export interface ApplyChoice {
  key: string;
  ticked: boolean;
  edits?: ActionEdits;
}

export interface ApplyBody {
  actions?: ApplyChoice[];
}

export interface UndoBody {
  actionKeys?: string[];
  reason?: string;
}

export interface CatchUpBody {
  note?: string;
  autoApply?: boolean;
}

export interface FileOverrideBody {
  direction?: 'out' | 'in' | 'none';
  date?: string;
  kind?: string;
  notThisClaim?: boolean;
}

export interface AddInstructionBody {
  text: string;
  appliesTo?: AgentScope[];
  until?: string | null;
  effect?: InstructionEffect | null;
}

// ---------------------------------------------------------------------------
// Defensive normalisers (a partial server answer never breaks the screen)
// ---------------------------------------------------------------------------

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const EMPTY_COUNTS: AiInputCounts = { actions: 0, applied: 0, waitingTick: 0, needsYou: 0, undone: 0, failed: 0, questions: 0 };

export function normaliseSummary(raw: unknown): AiInputSummary {
  const s = (raw ?? {}) as Partial<AiInputSummary>;
  return {
    ...(s as AiInputSummary),
    excerpt: s.excerpt ?? '',
    statusLabel: s.statusLabel ?? String(s.status ?? ''),
    headline: s.headline ?? '',
    counts: { ...EMPTY_COUNTS, ...(s.counts ?? {}) },
    waiting: s.waiting ?? null,
    bundle: s.bundle ?? null,
    createdByName: s.createdByName ?? null,
    appliedAt: s.appliedAt ?? null,
    engine: s.engine ?? null,
  };
}

export function normaliseDetail(raw: unknown): AiInputDetail {
  const d = (raw ?? {}) as Partial<AiInputDetail>;
  const catchUp = d.catchUp
    ? { ...d.catchUp, files: list<CatchUpFile>(d.catchUp.files), willDo: list<string>(d.catchUp.willDo), blockers: list<CatchUpView['blockers'][number]>(d.catchUp.blockers), note: d.catchUp.note ?? null }
    : null;
  const whatChanged = d.whatChanged ? { lines: list<WhatChanged['lines'][number]>(d.whatChanged.lines), clocks: list<WhatChanged['clocks'][number]>(d.whatChanged.clocks), autopilot: d.whatChanged.autopilot ?? null } : null;
  return {
    ...normaliseSummary(d),
    ...(d as AiInputDetail),
    counts: { ...EMPTY_COUNTS, ...(d.counts ?? {}) },
    text: d.text ?? '',
    extraText: d.extraText ?? null,
    understood: d.understood ?? null,
    actions: list<AiAction>(d.actions),
    questions: list<AiQuestion>(d.questions),
    notDone: list<{ text: string; why: string }>(d.notDone),
    pendingText: list<string>(d.pendingText),
    warnings: list<string>(d.warnings),
    catchUp,
    whatChanged,
    log: list<AiInputLogLine>(d.log),
    canApply: Boolean(d.canApply),
    canUndo: Boolean(d.canUndo),
    canCancel: Boolean(d.canCancel),
    canThinkAgain: Boolean(d.canThinkAgain),
    revision: d.revision ?? 0,
  };
}

export function normalisePanel(raw: unknown, claimId = ''): AiInputPanel {
  const p = (raw ?? {}) as Partial<AiInputPanel>;
  const history = (p.history ?? {}) as Partial<AiInputPanel['history']>;
  const open = list<unknown>(p.open).map(normaliseSummary);
  const instructions = list<StandingInstruction>(p.instructions);
  return {
    claim: p.claim ?? { id: claimId, reference: '', status: '' },
    ai: { available: p.ai?.available ?? true, waiting: p.ai?.waiting ?? null },
    open,
    instructions,
    history: { items: list<unknown>(history.items).map(normaliseSummary), total: typeof history.total === 'number' ? history.total : 0 },
    badge: { open: p.badge?.open ?? open.length, instructions: p.badge?.instructions ?? instructions.filter((i) => i.status === 'active').length },
  };
}

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

const base = (claimId: string) => `/claims/${seg(claimId)}/ai-input`;
const one = (claimId: string, inputId: string) => `${base(claimId)}/${seg(inputId)}`;
const detail = async (p: Promise<unknown>): Promise<AiInputDetail> => normaliseDetail(await p);

export const HISTORY_PAGE_SIZE = 20;

export const claimAiApi = {
  panel: (claimId: string) => request<unknown>(base(claimId)).then((r) => normalisePanel(r, claimId)),
  inputs: (claimId: string, opts: { limit?: number; offset?: number; kind?: AiInputKind } = {}) =>
    request<{ items?: unknown[]; total?: number }>(`${base(claimId)}/inputs`, { query: { limit: opts.limit ?? HISTORY_PAGE_SIZE, offset: opts.offset, kind: opts.kind } }).then((r) => ({
      items: list<unknown>(r?.items).map(normaliseSummary),
      total: typeof r?.total === 'number' ? r.total : 0,
    })),
  createUpdate: (claimId: string, body: CreateUpdateBody) => {
    const clean: CreateUpdateBody = { text: body.text.trim() };
    if (body.channel) clean.channel = body.channel;
    if (body.extraText && body.extraText.trim()) clean.extraText = body.extraText.trim();
    return detail(request<unknown>(`${base(claimId)}/updates`, { method: 'POST', body: clean }));
  },
  get: (claimId: string, inputId: string) => detail(request<unknown>(one(claimId, inputId))),
  answer: (claimId: string, inputId: string, answers: AnswerBody[]) => detail(request<unknown>(`${one(claimId, inputId)}/answers`, { method: 'POST', body: { answers } })),
  apply: (claimId: string, inputId: string, body: ApplyBody = {}) => detail(request<unknown>(`${one(claimId, inputId)}/apply`, { method: 'POST', body })),
  undo: (claimId: string, inputId: string, body: UndoBody = {}) => detail(request<unknown>(`${one(claimId, inputId)}/undo`, { method: 'POST', body })),
  cancel: (claimId: string, inputId: string) => detail(request<unknown>(`${one(claimId, inputId)}/cancel`, { method: 'POST', body: {} })),
  thinkAgain: (claimId: string, inputId: string) => detail(request<unknown>(`${one(claimId, inputId)}/think-again`, { method: 'POST', body: {} })),
  createCatchUp: (claimId: string, body: CatchUpBody = {}) => {
    const clean: CatchUpBody = {};
    if (body.note && body.note.trim()) clean.note = body.note.trim();
    if (body.autoApply !== undefined) clean.autoApply = body.autoApply;
    return detail(request<unknown>(`${base(claimId)}/catch-up`, { method: 'POST', body: clean }));
  },
  filesDone: (claimId: string, inputId: string) => detail(request<unknown>(`${one(claimId, inputId)}/files-done`, { method: 'POST', body: {} })),
  overrideFile: (claimId: string, inputId: string, fileId: string, body: FileOverrideBody) => detail(request<unknown>(`${one(claimId, inputId)}/files/${seg(fileId)}`, { method: 'POST', body })),
  setAutoApply: (claimId: string, inputId: string, autoApply: boolean) => detail(request<unknown>(one(claimId, inputId), { method: 'PATCH', body: { autoApply } })),
  instructions: (claimId: string, status: 'active' | 'all' = 'all') =>
    request<{ items?: StandingInstruction[] }>(`/claims/${seg(claimId)}/instructions`, { query: { status } }).then((r) => ({ items: list<StandingInstruction>(r?.items) })),
  addInstruction: (claimId: string, body: AddInstructionBody) => {
    const clean: AddInstructionBody = { text: body.text.trim() };
    if (body.appliesTo && body.appliesTo.length) clean.appliesTo = body.appliesTo;
    if (body.until !== undefined) clean.until = body.until;
    if (body.effect) clean.effect = body.effect;
    return request<StandingInstruction>(`/claims/${seg(claimId)}/instructions`, { method: 'POST', body: clean });
  },
  retireInstruction: (claimId: string, instructionId: string, reason?: string) =>
    request<StandingInstruction>(`/claims/${seg(claimId)}/instructions/${seg(instructionId)}/retire`, { method: 'POST', body: reason && reason.trim() ? { reason: reason.trim() } : {} }),
};

// ---------------------------------------------------------------------------
// Query keys and polling rules (§11.2)
// ---------------------------------------------------------------------------

export const claimAiKeys = {
  all: (claimId: string) => ['claim-ai', claimId] as const,
  panel: (claimId: string) => ['claim-ai', claimId, 'panel'] as const,
  history: (claimId: string, offset: number, kind: AiInputKind | 'all') => ['claim-ai', claimId, 'history', kind, offset] as const,
  input: (claimId: string, inputId: string) => ['claim-ai', claimId, 'input', inputId] as const,
  instructions: (claimId: string) => ['claim-ai', claimId, 'instructions'] as const,
};

/** Poll every 2 s while the server is reading or applying. */
export const FAST_POLL_MS = 2000;
/** Poll every 5 s while waiting for the AI or while files are being read. */
export const SLOW_POLL_MS = 5000;

/** How often to refetch one input (false = not at all): 2 s interpreting/applying, 5 s waiting_ai/reading. */
export function inputPollMs(status: AiInputStatus | undefined): number | false {
  if (status === 'interpreting' || status === 'applying') return FAST_POLL_MS;
  if (status === 'waiting_ai' || status === 'reading') return SLOW_POLL_MS;
  return false;
}

/** The panel polls at the fastest rate any open input needs (and never when nothing is moving). */
export function panelPollMs(panel: Pick<AiInputPanel, 'open'> | undefined): number | false {
  let best: number | false = false;
  for (const i of panel?.open ?? []) {
    const ms = inputPollMs(i.status);
    if (ms !== false && (best === false || ms < best)) best = ms;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useAiInputPanel(claimId: string | undefined) {
  return useQuery({
    queryKey: claimAiKeys.panel(claimId ?? ''),
    queryFn: () => claimAiApi.panel(claimId!),
    enabled: Boolean(claimId),
    retry: false,
    refetchInterval: (q) => panelPollMs(q.state.data),
  });
}

export function useAiInputHistory(claimId: string, offset: number, kind: AiInputKind | 'all' = 'all') {
  return useQuery({
    queryKey: claimAiKeys.history(claimId, offset, kind),
    queryFn: () => claimAiApi.inputs(claimId, { offset, limit: HISTORY_PAGE_SIZE, ...(kind === 'all' ? {} : { kind }) }),
    enabled: Boolean(claimId),
    retry: false,
  });
}

export function useAiInput(claimId: string, inputId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: claimAiKeys.input(claimId, inputId ?? ''),
    queryFn: () => claimAiApi.get(claimId, inputId!),
    enabled: Boolean(claimId && inputId) && enabled,
    retry: false,
    refetchInterval: (q) => inputPollMs(q.state.data?.status),
  });
  // A poll that brings a new status (files read, the AI back, applied by the catch-up job) refreshes the panel and the
  // history too, so their chips never lag behind the input on screen.
  const status = q.data?.status;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!status) return;
    if (seen.current !== undefined && seen.current !== status) {
      void qc.invalidateQueries({ queryKey: claimAiKeys.panel(claimId) });
      void qc.invalidateQueries({ queryKey: ['claim-ai', claimId, 'history'] });
    }
    seen.current = status;
  }, [status, qc, claimId]);
  return q;
}

/**
 * Mutations on the claim's AI input. Every route answers with the fresh AiInputDetail, which replaces the cached detail
 * at once; the panel and the history are invalidated, and the claim file itself when something may have changed on it.
 */
export function useClaimAiMutations(claimId: string) {
  const qc = useQueryClient();
  const refreshPanel = () => {
    void qc.invalidateQueries({ queryKey: claimAiKeys.panel(claimId) });
    void qc.invalidateQueries({ queryKey: ['claim-ai', claimId, 'history'] });
  };
  const setDetail = (d: AiInputDetail) => {
    if (d.id) qc.setQueryData(claimAiKeys.input(claimId, d.id), d);
    refreshPanel();
  };
  const changedClaim = (d: AiInputDetail) => {
    setDetail(d);
    void qc.invalidateQueries({ queryKey: ['claim', claimId] });
  };
  const refreshInstructions = () => {
    void qc.invalidateQueries({ queryKey: claimAiKeys.instructions(claimId) });
    refreshPanel();
  };
  return {
    createUpdate: useMutation({ mutationFn: (b: CreateUpdateBody) => claimAiApi.createUpdate(claimId, b), onSuccess: setDetail }),
    answer: useMutation({ mutationFn: (v: { inputId: string; answers: AnswerBody[] }) => claimAiApi.answer(claimId, v.inputId, v.answers), onSuccess: setDetail }),
    apply: useMutation({ mutationFn: (v: { inputId: string; body: ApplyBody }) => claimAiApi.apply(claimId, v.inputId, v.body), onSuccess: changedClaim }),
    undo: useMutation({ mutationFn: (v: { inputId: string; body: UndoBody }) => claimAiApi.undo(claimId, v.inputId, v.body), onSuccess: (d) => (changedClaim(d), refreshInstructions()) }),
    cancel: useMutation({ mutationFn: (inputId: string) => claimAiApi.cancel(claimId, inputId), onSuccess: setDetail }),
    thinkAgain: useMutation({ mutationFn: (inputId: string) => claimAiApi.thinkAgain(claimId, inputId), onSuccess: setDetail }),
    createCatchUp: useMutation({ mutationFn: (b: CatchUpBody) => claimAiApi.createCatchUp(claimId, b), onSuccess: setDetail }),
    filesDone: useMutation({ mutationFn: (inputId: string) => claimAiApi.filesDone(claimId, inputId), onSuccess: setDetail }),
    overrideFile: useMutation({ mutationFn: (v: { inputId: string; fileId: string; body: FileOverrideBody }) => claimAiApi.overrideFile(claimId, v.inputId, v.fileId, v.body), onSuccess: setDetail }),
    setAutoApply: useMutation({ mutationFn: (v: { inputId: string; autoApply: boolean }) => claimAiApi.setAutoApply(claimId, v.inputId, v.autoApply), onSuccess: setDetail }),
    addInstruction: useMutation({ mutationFn: (b: AddInstructionBody) => claimAiApi.addInstruction(claimId, b), onSuccess: refreshInstructions }),
    retireInstruction: useMutation({ mutationFn: (v: { id: string; reason?: string }) => claimAiApi.retireInstruction(claimId, v.id, v.reason), onSuccess: refreshInstructions }),
    refreshPanel,
  };
}
