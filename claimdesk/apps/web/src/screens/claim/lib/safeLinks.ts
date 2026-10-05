/**
 * Links inside a rendered Word document (docx-preview renders straight into the app page): only http, https, mailto
 * and in-document #bookmarks are kept. Anything else (javascript:, data:, file:, vbscript: …) loses its href, so a
 * click can never run script in the ClaimDesk origin.
 */
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

export function isSafeHref(href: string | null | undefined): boolean {
  if (href === null || href === undefined) return true;
  // browsers ignore ASCII whitespace and control characters inside a URL scheme ("java\tscript:")
  // eslint-disable-next-line no-control-regex
  const t = href.replace(/[\u0000-\u0020]+/g, '');
  if (t === '' || t.startsWith('#')) return true;
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(t);
  if (m) return ALLOWED.has(m[1]!.toLowerCase());
  // relative: safe only when no colon comes before the first path character
  const colon = t.indexOf(':');
  return colon < 0 || /[/?#]/.test(t.slice(0, colon));
}

/** Remove unsafe hrefs (and xlink:href on SVG links) under `root`; external links open in a new, unlinked tab. */
export function neutraliseLinks(root: ParentNode): number {
  let removed = 0;
  for (const a of Array.from(root.querySelectorAll('[href], [xlink\\:href]'))) {
    for (const attr of ['href', 'xlink:href']) {
      const v = a.getAttribute(attr);
      if (v !== null && !isSafeHref(v)) {
        a.removeAttribute(attr);
        removed += 1;
      }
    }
    const href = a.getAttribute('href');
    if (a.tagName.toLowerCase() === 'a' && href && /^(https?|mailto):/i.test(href.trim())) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return removed;
}
