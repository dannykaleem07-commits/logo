// owned by knowledge-ui
/**
 * Daily log ▸ Knowledge (docs/SUPREME-KNOWLEDGE-BUILDER.md §9.4): `sections.knowledge` of the daily log — the headline,
 * what was learned automatically (each with Undo), what waits for you, gaps, sources, research and alarms. Absent before
 * the knowledge migration, so the daily log renders nothing for it then.
 */
import { Link } from 'react-router-dom';
import type { KnowledgeDigest } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { DigestLines } from './ThisWeekTab';
import { knowledgeHref } from './knowledgeView';
import './knowledge.css';

/** Read `sections.knowledge` defensively (the web DailyLog type predates it). */
export function knowledgeSectionOf(sections: unknown): KnowledgeDigest | undefined {
  const k = (sections as { knowledge?: unknown } | null | undefined)?.knowledge;
  if (!k || typeof k !== 'object') return undefined;
  const d = k as Partial<KnowledgeDigest>;
  return typeof d.headline === 'string' && Array.isArray(d.learnedAutomatically) ? (d as KnowledgeDigest) : undefined;
}

export function KnowledgeDigestSection({ sections }: { sections: unknown }) {
  const d = knowledgeSectionOf(sections);
  if (!d) return null;
  return (
    <Card title={`Knowledge (${d.learnedAutomatically.length} learned, ${d.waitingForYou.count} waiting)`} actions={<Link to={knowledgeHref('week')}>Open Knowledge</Link>}>
      <div className="stack">
        <p className="daily-headline">
          <strong>{d.headline}</strong>
          {!d.learningEnabled && !/paused/i.test(d.headline) && <span className="small muted"> · learning is paused</span>}
          {d.activeVersion !== null && <span className="small muted"> · learned v{d.activeVersion}{d.publishedToday.length ? ` (published today: ${d.publishedToday.map((v) => `v${v}`).join(', ')})` : ''}</span>}
        </p>
        <div>
          <h4 className="kn-h">Learned automatically</h4>
          <DigestLines lines={d.learnedAutomatically} empty="Nothing was learned automatically." />
        </div>
        <div>
          <h4 className="kn-h">
            Waiting for you ({d.waitingForYou.count}) · <Link to={knowledgeHref('approve')}>Approve</Link>
          </h4>
          <DigestLines lines={d.waitingForYou.lines} empty="Nothing is waiting for you." limit={10} />
        </div>
        <div>
          <h4 className="kn-h">
            Gaps: {d.gaps.opened} opened, {d.gaps.filled} filled, {d.gaps.open} open
          </h4>
          <DigestLines lines={d.gaps.lines} empty="No gaps today." limit={10} />
        </div>
        {d.alarms.length > 0 && (
          <div>
            <h4 className="kn-h">Alarms</h4>
            <DigestLines lines={d.alarms} empty="" />
          </div>
        )}
        <p className="small muted">
          Sources: {d.sources.fetched} fetched, {d.sources.changed} changed, {d.sources.refused} refused · research: {d.research.runs} runs, {d.research.proposals} proposals, {d.research.ownerRejected} rejected by you
        </p>
      </div>
    </Card>
  );
}
