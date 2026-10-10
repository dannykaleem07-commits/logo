import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows, robotsCrawlDelay } from './robots.js';

const UA = 'ClaimDesk-KnowledgeBuilder/0.5 (+owner)';

describe('robots.txt (§7.3)', () => {
  const rules = parseRobots(`# test
User-agent: *
Disallow: /search
Allow: /search/about
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: claimdesk-knowledgebuilder
Disallow: /private/
`);
  it('uses the most specific group', () => {
    expect(robotsAllows(rules, UA, '/private/x')).toBe(false);
    expect(robotsAllows(rules, UA, '/search')).toBe(true);
    expect(robotsAllows(rules, 'OtherBot/1', '/search?q=x')).toBe(false);
    expect(robotsCrawlDelay(rules, 'OtherBot/1')).toBe(2);
  });
  it('longest match wins, Allow wins ties, wildcards and $ anchors work', () => {
    expect(robotsAllows(rules, 'OtherBot', '/search/about')).toBe(true);
    expect(robotsAllows(rules, 'OtherBot', '/docs/a.pdf')).toBe(false);
    expect(robotsAllows(rules, 'OtherBot', '/docs/a.pdf?x=1')).toBe(true);
  });
  it('an empty file allows everything; robots.txt itself is always allowed', () => {
    expect(robotsAllows(parseRobots(''), UA, '/anything')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), UA, '/robots.txt')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), UA, '/x')).toBe(false);
  });
});
