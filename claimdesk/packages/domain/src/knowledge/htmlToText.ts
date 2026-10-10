// owned by knowledge-research
/**
 * Fetched page → text (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3, KR-9). Pure and dependency-free.
 *
 * Drops script, style, noscript, template, svg, comments and hidden elements (`display:none`, `visibility:hidden`,
 * the `hidden` attribute, `aria-hidden="true"`, zero font size) and zero-width character runs, and reports whether
 * any hidden text was present (a page that hides text is treated as a possible prompt injection, §7.7). Block
 * elements become line breaks; entities are decoded. The stored `.txt` copy is this text, so quotes are checked
 * against exactly what a person would read.
 */

export interface HtmlTextResult {
  text: string;
  title: string | null;
  hiddenText: boolean;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'iframe', 'object', 'canvas', 'select', 'button']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'caption', 'summary', 'details',
]);
/** Zero-width and invisible formatting characters. */
export const ZERO_WIDTH_RE = /[​-‍⁠﻿­᠎]/g;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€', sect: '§', copy: '©', reg: '®', middot: '·', bull: '•', para: '¶', shy: '' };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Is an opening tag (its attribute text) hidden from a reader? */
export function isHiddenAttrs(attrs: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$|\/)/i.test(attrs)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
  const style = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const css = (style?.[1] ?? style?.[2] ?? '').toLowerCase().replace(/\s+/g, '');
  if (!css) return false;
  return /display:none|visibility:hidden|font-size:0(?:px|em|rem|pt|%)?(?:;|$)|opacity:0(?:\.0+)?(?:;|$)|(?:^|;)(?:height|width):0(?:px)?;.*overflow:hidden|clip:rect\(0/.test(css);
}

export function htmlToText(html: string): HtmlTextResult {
  let hiddenText = ZERO_WIDTH_RE.test(html);
  ZERO_WIDTH_RE.lastIndex = 0;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.replace(/<[^>]*>/g, '')).replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').trim() || null : null;

  // Comments and CDATA go first (they may contain tags).
  const src = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ').replace(/<!doctype[^>]*>/gi, ' ').replace(/<\?[\s\S]*?\?>/g, ' ');

  const out: string[] = [];
  const stack: { tag: string; skip: boolean; hidden: boolean }[] = [];
  const skipping = (): boolean => stack.some((s) => s.skip);
  const inHidden = (): boolean => stack.some((s) => s.hidden);
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    const text = src.slice(at, m.index);
    if (text) {
      if (skipping()) {
        if (inHidden() && decodeHtmlEntities(text).replace(ZERO_WIDTH_RE, '').trim()) hiddenText = true;
      } else out.push(text);
    }
    at = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(attrs);
    if (closing) {
      const idx = stack.map((s) => s.tag).lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
      if (BLOCK.has(tag) && !skipping()) out.push('\n');
      continue;
    }
    if (BLOCK.has(tag) && !skipping()) out.push('\n');
    if (VOID.has(tag) || selfClosing) continue;
    const hidden = isHiddenAttrs(attrs);
    stack.push({ tag, skip: DROP.has(tag) || hidden, hidden });
    // Raw-text elements: jump to their end tag so "<" inside a script is never read as markup.
    if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'template') {
      const end = new RegExp(`</${tag}\\s*>`, 'ig');
      end.lastIndex = at;
      const e = end.exec(src);
      if (tag === 'template' && e && src.slice(at, e.index).replace(/<[^>]*>/g, '').trim()) hiddenText = true;
      if (e) {
        if (tag === 'textarea' && !skipping()) out.push(src.slice(at, e.index));
        at = e.index + e[0].length;
        tagRe.lastIndex = at;
        stack.pop();
      }
    }
  }
  const tail = src.slice(at);
  if (tail && !skipping()) out.push(tail);

  const text = decodeHtmlEntities(out.join('').replace(/<[^>]*>/g, ' '))
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, title, hiddenText };
}

/** Plain text (text/plain, JSON already rendered) → the same normalised form, with the zero-width flag. */
export function plainToText(raw: string): HtmlTextResult {
  const hiddenText = ZERO_WIDTH_RE.test(raw);
  ZERO_WIDTH_RE.lastIndex = 0;
  const text = raw.replace(ZERO_WIDTH_RE, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, title: null, hiddenText };
}
