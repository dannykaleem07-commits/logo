// owned by knowledge-research
/**
 * robots.txt (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3): fetched, honoured, cached 24 h (the cache lives in
 * `knowledge_sources.robots`). Pure parser and matcher following RFC 9309: the most specific user-agent group wins
 * (else `*`), the longest matching rule wins, Allow wins a tie, `*` and `$` are supported. An empty or missing file
 * allows everything; a file the fetcher could not read (5xx) is treated by the caller as "disallow all".
 */

export interface RobotsRules {
  groups: { agents: string[]; allow: string[]; disallow: string[]; crawlDelaySeconds: number | null }[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules['groups'] = [];
  let current: RobotsRules['groups'][number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    else if (key === 'disallow' && value) current.disallow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySeconds = n;
    }
  }
  return { groups };
}

/** The product token of a User-Agent string ("ClaimDesk-KnowledgeBuilder/0.5 (+…)" → "claimdesk-knowledgebuilder"). */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? '').toLowerCase();
}

function groupFor(rules: RobotsRules, userAgent: string): RobotsRules['groups'][number] | undefined {
  const token = productToken(userAgent);
  let best: RobotsRules['groups'][number] | undefined;
  let bestLen = -1;
  for (const g of rules.groups) {
    for (const a of g.agents) {
      if (a === '*') continue;
      if (token && (token === a || token.startsWith(a)) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  return best ?? rules.groups.find((g) => g.agents.includes('*'));
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

const decodePath = (p: string): string => {
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
};

/** May `path` (path + query) be fetched by `userAgent`? */
export function robotsAllows(rules: RobotsRules, userAgent: string, path: string): boolean {
  const g = groupFor(rules, userAgent);
  if (!g) return true;
  const target = decodePath(path || '/');
  if (target === '/robots.txt') return true;
  let best: { len: number; allow: boolean } | null = null;
  const consider = (pattern: string, allow: boolean): void => {
    if (!patternToRegex(decodePath(pattern)).test(target)) return;
    const len = pattern.length;
    if (!best || len > best.len || (len === best.len && allow && !best.allow)) best = { len, allow };
  };
  for (const p of g.allow) consider(p, true);
  for (const p of g.disallow) consider(p, false);
  return best ? (best as { allow: boolean }).allow : true;
}

/** The crawl delay (seconds) for `userAgent`, or null. */
export function robotsCrawlDelay(rules: RobotsRules, userAgent: string): number | null {
  return groupFor(rules, userAgent)?.crawlDelaySeconds ?? null;
}
