import { describe, expect, it } from 'vitest';
import { isSafeHref } from './safeLinks';

describe('links in a rendered Word document', () => {
  it('keeps http, https, mailto and #bookmarks', () => {
    for (const h of ['https://www.courtesycars.net', 'http://example.test/a?b#c', 'mailto:claims@courtesycars.net', '#_Toc1', '', 'page.html', 'a/b:c']) expect(isSafeHref(h), h).toBe(true);
  });
  it('drops javascript:, data:, vbscript:, file: and disguised schemes', () => {
    for (const h of ['javascript:fetch("/api/claims")', 'JavaScript:alert(1)', ' java\tscript:alert(1)', 'java\nscript:x', 'data:text/html,<script>x</script>', 'vbscript:msgbox', 'file:///C:/x', 'x:y']) expect(isSafeHref(h), h).toBe(false);
  });
});
