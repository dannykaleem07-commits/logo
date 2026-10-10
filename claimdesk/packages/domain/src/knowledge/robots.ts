// owned by knowledge-research
/**
 * robots.txt (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3): fetched, honoured, cached 24 h. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 */
import { notImplemented } from './notImplemented.js';

export interface RobotsRules {
  groups: { agents: string[]; allow: string[]; disallow: string[]; crawlDelaySeconds: number | null }[];
}

export function parseRobots(_text: string): RobotsRules {
  return notImplemented('knowledge-research', 'parseRobots');
}

export function robotsAllows(_rules: RobotsRules, _userAgent: string, _path: string): boolean {
  return notImplemented('knowledge-research', 'robotsAllows');
}
