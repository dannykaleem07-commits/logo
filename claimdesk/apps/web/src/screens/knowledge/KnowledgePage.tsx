// owned by knowledge-ui
/**
 * Knowledge (docs/SUPREME-KNOWLEDGE-BUILDER.md §11): what ClaimDesk has learned from your claims, your edits and official
 * sources, and what waits for you. Eight tabs, kept in the URL (`/knowledge?tab=approve`): This week, Approve, Gaps,
 * Insurers, Library, Sources, Versions, Safety. Deep links: `&item=<id>` opens the item drawer on any tab (the daily
 * log and digest use it), `&gap=`, `&insurer=` and `&alarm=` select within their tab.
 */
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Badge } from '../../components/Badge';
import { Tabs } from '../../components/Tabs';
import { useKnowledgeStatus } from '../../api/knowledgeApi';
import { KNOWLEDGE_TABS, parseTab, type KnowledgeTab } from './knowledgeView';
import { ItemDrawer } from './parts';
import { ThisWeekTab } from './ThisWeekTab';
import { ApproveTab } from './ApproveTab';
import { GapsTab } from './GapsTab';
import { InsurersTab } from './InsurersTab';
import { LibraryTab } from './LibraryTab';
import { SourcesTab } from './SourcesTab';
import { VersionsTab } from './VersionsTab';
import { SafetyTab } from './SafetyTab';
import './knowledge.css';

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const itemId = params.get('item') ?? undefined;
  const status = useKnowledgeStatus();
  const s = status.data;

  const set = (changes: Record<string, string | undefined>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace });
  };
  const goTab = (t: string) => setParams(new URLSearchParams({ tab: t }));
  const openItem = (id: string) => set({ item: id });

  const waiting = s ? s.items.proposed + s.conflictsOpen : 0;
  const badge = (n: number | null | undefined, tone: 'amber' | 'red' = 'amber') => (n ? <Badge tone={tone} className="kn-tab-badge">{n}</Badge> : undefined);
  const items = KNOWLEDGE_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    ...(t.id === 'approve' ? { badge: badge(waiting) } : t.id === 'gaps' ? { badge: badge(s?.gapsOpen) } : t.id === 'safety' ? { badge: badge(s?.alarmsOpen, 'red') } : {}),
  }));

  return (
    <div className="page kn-page">
      <PageHeader
        title="Knowledge"
        subtitle="What ClaimDesk has learned from your claims, your edits and official sources. Nothing that matters is used until you approve it, and everything can be undone."
        actions={
          s ? (
            <div className="row">
              {!s.learningEnabled && <Badge tone="amber">Learning paused</Badge>}
              {!s.useLearnedKnowledge && <Badge tone="amber">Learned knowledge off</Badge>}
              {s.webResearchEnabled && <Badge tone="blue">Web research on</Badge>}
              <span className="small muted">{s.activeVersion !== null ? `Learned v${s.activeVersion} · ${s.items.active} in use` : `${s.items.active} in use`}</span>
            </div>
          ) : undefined
        }
      />
      <Tabs items={items} value={tab} onChange={goTab} ariaLabel="Knowledge sections" narrowPrimary={3} />
      <div className="kn-body" role="tabpanel" id={`tabpanel-${tab}`}>
        <TabBody tab={tab} params={params} set={set} openItem={openItem} />
      </div>
      <ItemDrawer itemId={itemId} onClose={() => set({ item: undefined }, true)} onOpenItem={(id) => set({ item: id }, true)} />
    </div>
  );
}

function TabBody({ tab, params, set, openItem }: { tab: KnowledgeTab; params: URLSearchParams; set: (c: Record<string, string | undefined>, replace?: boolean) => void; openItem: (id: string) => void }) {
  switch (tab) {
    case 'week':
      return <ThisWeekTab onOpenItem={openItem} />;
    case 'approve':
      return <ApproveTab onOpenItem={openItem} />;
    case 'gaps':
      return <GapsTab gapId={params.get('gap') ?? undefined} onGap={(id) => set({ gap: id })} onOpenItem={openItem} />;
    case 'insurers':
      return <InsurersTab slug={params.get('insurer') ?? undefined} onSlug={(slug) => set({ insurer: slug })} onOpenItem={openItem} />;
    case 'library':
      return <LibraryTab onOpenItem={openItem} />;
    case 'sources':
      return <SourcesTab />;
    case 'versions':
      return <VersionsTab onOpenItem={openItem} />;
    case 'safety':
      return <SafetyTab alarmId={params.get('alarm') ?? undefined} />;
  }
}
