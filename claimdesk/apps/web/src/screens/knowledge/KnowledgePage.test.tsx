// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { KnowledgeConflict, KnowledgeDigest, KnowledgeItemDetail, KnowledgeItemView, KnowledgeQueueResponse, KnowledgeStatusResponse, KnowledgeWeekDigest } from '@ccguk/domain';
import { DEFAULT_KNOWLEDGE_SETTINGS } from '@ccguk/domain';
import { renderWithProviders } from '../../test/harness';
import { knowledgeQk } from '../../api/knowledgeApi';
import { needsYouQk, type NeedsYouDetail, type NeedsYouItem } from '../../api/needsYouApi';
import { KnowledgePage } from './KnowledgePage';
import { KnowledgeReviewPanel } from './KnowledgeReviewPanel';
import { KnowledgeDigestSection } from './KnowledgeDigestSection';
import { KnowledgeUsedPanel } from './KnowledgeUsedPanel';
import { NeedsYouPage } from '../needsYou/NeedsYouPage';
import { londonToday } from './knowledgeView';

// ---------------------------------------------------------------------------
// A fake API behind fetch (no network): records every call; unknown routes answer like the API's not-found handler.
// ---------------------------------------------------------------------------

const calls: { method: string; path: string; body: unknown }[] = [];
const responses = new Map<string, unknown>();

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return { ok: status < 400, status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => JSON.parse(text) as unknown, text: async () => text } as unknown as Response;
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace(/^\/api/, '');
  calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const key = `${method} ${path}`;
  if (responses.has(key)) return Promise.resolve(jsonResponse(responses.get(key)));
  return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: `Route ${method} ${url.pathname} not found` } }, 404));
}

beforeEach(() => {
  calls.length = 0;
  responses.clear();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-10-09T10:00:00.000Z';

function itemView(over: Partial<KnowledgeItemView> = {}): KnowledgeItemView {
  return {
    id: 'k1',
    itemKey: 'contact:aviva:tp-team',
    version: 1,
    kind: 'contact',
    area: 'contact',
    title: 'Aviva third-party team',
    body: 'Third-party motor claims team: 0300 000 0001',
    data: { insurerSlug: 'aviva', team: 'TP motor', name: null, role: null, phone: '0300 000 0001', phoneKind: 'team', email: null, ivr: null, hours: null, observations: 3, independentThreads: 2, lastSeenAt: NOW } as never,
    tags: [],
    scope: { kind: 'insurer', slug: 'aviva' },
    business: ['ccguk'],
    useLimit: 'internal',
    origin: 'observed',
    verification: 'unverified',
    lastCheckId: null,
    confidence: 0.9,
    supportN: 3,
    status: 'proposed',
    health: 'ok',
    validFrom: null,
    validTo: null,
    reviewBy: null,
    provenance: [{ kind: 'snapshot', snapshotId: 'snap1', url: 'https://www.aviva.co.uk/contact', fetchedAt: NOW, quote: '0300 000 0001', anchor: null, quoteMatch: 'exact' }],
    supersedesId: null,
    gapId: null,
    contentSha256: 'x',
    autonomy: { outcome: 'queue', ruleIds: ['KN-07'], reasons: ['Differs from the insurer directory'], priority: 'normal' },
    createdBy: 'agent:supervisor',
    createdAt: NOW,
    originJobId: null,
    originRunId: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    needsYouId: null,
    updatedAt: NOW,
    badges: ['unverified', 'external'],
    ...over,
  };
}

const detailOf = (i: KnowledgeItemView): KnowledgeItemDetail => ({ item: i, versions: [i], checks: [], changes: [], usage: [], conflicts: [], inActiveVersion: false });

const STATUS: KnowledgeStatusResponse = { learningEnabled: true, useLearnedKnowledge: true, webResearchEnabled: false, activeVersion: 3, items: { proposed: 1, active: 12, held: 0 }, conflictsOpen: 1, gapsOpen: 2, alarmsOpen: 0, needsYouOpen: 1 };

const day = (d: string, over: Partial<KnowledgeDigest> = {}): KnowledgeDigest => ({
  day: d,
  learningEnabled: true,
  activeVersion: 3,
  publishedToday: [],
  learnedAutomatically: [],
  waitingForYou: { count: 0, lines: [] },
  gaps: { opened: 0, filled: 0, open: 0, lines: [] },
  sources: { fetched: 0, changed: 0, refused: 0 },
  research: { runs: 0, proposals: 0, ownerRejected: 0 },
  alarms: [],
  headline: '',
  ...over,
});

const CONFLICT: KnowledgeConflict = { id: 'c1', kind: 'directory_mismatch', leftRef: 'ki:k1', rightRef: 'directory:aviva', detail: 'The learned phone differs from the directory', detectedBy: 'agent:supervisor', status: 'open', resolution: null, needsYouId: null, createdAt: NOW, resolvedBy: null, resolvedAt: null };

// ---------------------------------------------------------------------------

describe('Knowledge screen', () => {
  it('This week: headline, learned lines with badges and Undo (retire), waiting link to Approve', async () => {
    const week: KnowledgeWeekDigest = {
      start: '2026-10-03',
      end: londonToday(),
      days: [day('2026-10-09', { learnedAutomatically: [{ at: NOW, text: 'Learned Aviva statistics', badges: ['computed'], itemId: 'k9', link: '/knowledge?tab=library&item=k9', undoRoute: '/api/knowledge/items/k9/retire' }], waitingForYou: { count: 1, lines: [] } })],
      learnedAutomatically: 1,
      waitingForYou: 1,
      gapsFilled: 0,
      headline: 'This week: learned 1 thing automatically, 1 waits for you, 0 gaps filled.',
    };
    responses.set('POST /knowledge/items/k9/retire', { item: itemView({ id: 'k9', status: 'retired' }) });
    responses.set('GET /knowledge/digest/week', week);
    responses.set('GET /knowledge/status', STATUS);
    const r = renderWithProviders(
      <Routes>
        <Route path="/knowledge" element={<KnowledgePage />} />
      </Routes>,
      { route: '/knowledge', queryData: [[knowledgeQk.week(londonToday()), week], [knowledgeQk.status, STATUS], [knowledgeQk.versions, { activeVersion: null, versions: [] }]] },
    );
    expect(screen.getByText(week.headline)).toBeTruthy();
    expect(screen.getByText('Learned Aviva statistics')).toBeTruthy();
    expect(screen.getByText('COMPUTED')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Approve/ })).toBeTruthy();
    await r.user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/knowledge/items/k9/retire')).toBe(true));
    expect(await screen.findByText('undone')).toBeTruthy();
  });

  it('Approve: grouped queue, source copy with the quote, conflicts, and the decision buttons', async () => {
    const item = itemView();
    const queue: KnowledgeQueueResponse = { items: [item], held: [], groups: [{ key: 'contacts:aviva', title: 'Contacts — aviva', kind: 'contacts', itemIds: ['k1'] }], conflicts: [CONFLICT] };
    responses.set('POST /knowledge/items/k1/approve', { item: { ...item, status: 'active' } });
    const r = renderWithProviders(
      <Routes>
        <Route path="/knowledge" element={<KnowledgePage />} />
      </Routes>,
      {
        route: '/knowledge?tab=approve',
        queryData: [
          [knowledgeQk.queue, queue],
          [knowledgeQk.status, STATUS],
          [knowledgeQk.item('k1'), detailOf(item)],
          [knowledgeQk.snapshot('snap1'), { snapshot: { id: 'snap1', url: 'https://www.aviva.co.uk/contact', finalUrl: 'https://www.aviva.co.uk/contact', domain: 'aviva.co.uk', fetchedAt: NOW, httpStatus: 200, contentType: 'text/html', bytes: 900, sha256: 'x', title: 'Contact us', licence: 'link_only', extractAllowed: true, previousId: null, changed: false, injectionFlags: [], reason: 'research', gapId: null, text: 'Call our third-party team on 0300 000 0001 from 9am.' } }],
        ],
      },
    );
    expect(screen.getByText('Contacts — aviva')).toBeTruthy();
    expect(screen.getAllByText('The learned phone differs from the directory').length).toBeGreaterThan(0);
    const mark = document.querySelector('mark.kn-mark');
    expect(mark?.textContent).toBe('0300 000 0001');
    const sv = screen.getByRole('button', { name: 'Approve as source-verified' }) as HTMLButtonElement;
    expect(sv.disabled).toBe(false);
    // r opens the reason form, Cancel closes it
    fireEvent.keyDown(window, { key: 'r' });
    expect(await screen.findByText(/Why reject it/)).toBeTruthy();
    await r.user.click(screen.getByRole('button', { name: 'Cancel' }));
    await r.user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/knowledge/items/k1/approve')).toBeTruthy());
  });

  it('Approve as source-verified stays disabled when a quote did not match exactly', () => {
    const item = itemView({ provenance: [{ kind: 'snapshot', snapshotId: 'snap1', url: 'https://www.aviva.co.uk/contact', fetchedAt: NOW, quote: 'x', anchor: null, quoteMatch: 'normalised' }] });
    renderWithProviders(
      <Routes>
        <Route path="/knowledge" element={<KnowledgePage />} />
      </Routes>,
      { route: '/knowledge?tab=approve', queryData: [[knowledgeQk.queue, { items: [item], held: [], groups: [{ key: 'g', title: 'G', kind: 'contacts', itemIds: ['k1'] }], conflicts: [] }], [knowledgeQk.status, STATUS], [knowledgeQk.item('k1'), detailOf(item)]] },
    );
    expect((screen.getByRole('button', { name: 'Approve as source-verified' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Safety: web research needs the honest notice read first; always-queue categories are disabled', async () => {
    const r = renderWithProviders(
      <Routes>
        <Route path="/knowledge" element={<KnowledgePage />} />
      </Routes>,
      { route: '/knowledge?tab=safety', queryData: [[knowledgeQk.settings, DEFAULT_KNOWLEDGE_SETTINGS], [knowledgeQk.status, STATUS]] },
    );
    const web = screen.getByRole('switch', { name: 'Web research' }) as HTMLInputElement;
    expect(web.checked).toBe(false);
    expect(web.disabled).toBe(true);
    expect(screen.getByText(/fetched from this PC’s own internet connection/)).toBeTruthy();
    await r.user.click(screen.getByLabelText('I have read this'));
    expect((screen.getByRole('switch', { name: 'Web research' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Rules and strategies' }) as HTMLInputElement).disabled).toBe(true);
    // replay and alarms are not installed: they say so instead of failing
    expect(await screen.findByText(/Golden replay is not available yet/)).toBeTruthy();
  });
});

describe('Knowledge panels elsewhere', () => {
  const gapCard: NeedsYouItem = {
    id: 'ny1',
    kind: 'knowledge_review',
    title: "I couldn't find: how does Aviva issue a handling reference?",
    summary: 'Where I looked: gov.uk.',
    options: [
      { id: 'answer', label: 'I know the answer', tone: 'primary', requiresEdit: true },
      { id: 'dismiss', label: 'Dismiss', tone: 'neutral', requiresReason: true },
    ],
    payload: { variant: 'gap', gapId: 'g1', question: 'How does Aviva issue a handling reference?', preparedItemId: null, looked: [{ domain: 'gov.uk', url: null }] },
    priority: 'low',
    status: 'open',
    createdBy: 'agent:researcher',
    createdAt: NOW,
  };

  it('Needs-you gap card: "I know the answer" opens the answer form and resolves with {answer}', async () => {
    responses.set('POST /needs-you/ny1/resolve', { item: { ...gapCard, status: 'resolved' }, count: { total: 0, urgent: 0, byPriority: { urgent: 0, high: 0, normal: 0, low: 0 }, snoozed: 0 } });
    const detail: NeedsYouDetail = { item: gapCard, events: [], resolverRegistered: true };
    const r = renderWithProviders(
      <Routes>
        <Route path="/needs-you/:id" element={<NeedsYouPage />} />
      </Routes>,
      { route: '/needs-you/ny1', queryData: [[needsYouQk.list({ status: 'open', kind: '', claimId: undefined }), { items: [gapCard], count: { total: 1, urgent: 0, byPriority: { urgent: 0, high: 0, normal: 0, low: 1 }, snoozed: 0 } }], [needsYouQk.detail('ny1'), detail]] },
    );
    const panel = screen.getByLabelText('Knowledge to check');
    expect(within(panel).getByText('How does Aviva issue a handling reference?')).toBeTruthy();
    expect(within(panel).getByText(/Where the researcher looked: gov.uk/)).toBeTruthy();
    await r.user.click(screen.getByRole('button', { name: 'I know the answer' }));
    const answer = await screen.findByLabelText('Your answer');
    await r.user.type(answer, 'Call the TP team and quote our reference');
    await r.user.click(screen.getByRole('button', { name: 'Save my answer' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/needs-you/ny1/resolve')).toBeTruthy());
    expect(calls.find((c) => c.path === '/needs-you/ny1/resolve')!.body).toEqual({ optionId: 'answer', edits: { answer: 'Call the TP team and quote our reference' } });
  });

  it('items card shows the proposal and its source; editing resolves with {itemId, title, body, data, scope}', async () => {
    const item = itemView();
    const card: NeedsYouItem = { ...gapCard, id: 'ny2', title: 'New contact details for aviva', options: [{ id: 'approve', label: 'Approve', tone: 'primary' }, { id: 'edit_approve', label: 'Edit then approve', tone: 'neutral', requiresEdit: true }], payload: { variant: 'items', groupTitle: 'New contact details for aviva', itemIds: ['k1'], replayRunId: null } };
    responses.set('POST /needs-you/ny2/resolve', { item: { ...card, status: 'resolved' } });
    const r = renderWithProviders(<KnowledgeReviewPanel item={card} closed={false} />, { queryData: [[knowledgeQk.item('k1'), detailOf(item)]] });
    expect(screen.getByText('Aviva third-party team')).toBeTruthy();
    await r.user.click(screen.getByRole('button', { name: 'Edit this one, then approve' }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    await r.user.clear(title);
    await r.user.type(title, 'Aviva TP team');
    await r.user.click(screen.getByRole('button', { name: 'Approve my version' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/needs-you/ny2/resolve')).toBeTruthy());
    const body = calls.find((c) => c.path === '/needs-you/ny2/resolve')!.body as { optionId: string; edits: Record<string, unknown> };
    expect(body.optionId).toBe('edit_approve');
    expect(body.edits).toMatchObject({ itemId: 'k1', title: 'Aviva TP team', scope: { kind: 'insurer', slug: 'aviva' } });
  });

  it('daily log Knowledge section renders from sections.knowledge and nothing without it', () => {
    const d = day('2026-10-09', { headline: 'Learned 2 things automatically, 1 waits for you, 0 gaps filled', learnedAutomatically: [{ at: NOW, text: 'Contact for Aviva', badges: ['unverified'], itemId: 'k1', link: '/knowledge?tab=library&item=k1', undoRoute: '/api/knowledge/items/k1/retire' }], waitingForYou: { count: 1, lines: [] } });
    const { container, unmount } = renderWithProviders(<KnowledgeDigestSection sections={{ knowledge: d }} />);
    expect(screen.getByText(d.headline)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(container.textContent).toContain('UNVERIFIED');
    unmount();
    const empty = renderWithProviders(<KnowledgeDigestSection sections={{}} />);
    expect(empty.container.textContent).toBe('');
  });

  it('Knowledge used shows a chip per ref, and nothing when the route is not installed', async () => {
    renderWithProviders(<KnowledgeUsedPanel targetKind="outbox" targetId="o1" />, { queryData: [[knowledgeQk.used('outbox', 'o1'), { targetKind: 'outbox', targetId: 'o1', refs: [{ ref: 'ki:k1', badges: ['owner_confirmed'], cited: true, title: 'Aviva TP team', itemId: 'k1' }] }]] });
    expect(screen.getByText('Aviva TP team')).toBeTruthy();
    expect(screen.getByText('OWNER-CONFIRMED')).toBeTruthy();
    const none = renderWithProviders(<KnowledgeUsedPanel targetKind="outbox" targetId="o2" />);
    await waitFor(() => expect(calls.some((c) => c.path === '/knowledge/used')).toBe(true));
    expect(none.container.querySelector('.kn-used')).toBeNull();
  });
});
