/**
 * extractLetterContent — an HTML letter (baseLayout, kind 'letter') → LetterContent for the CCGUK Word letterhead
 * (TEMPLATES-VEHICLES-DESKTOP §C.7, §H.3, §A.10).
 *
 * The layout marks every part of a letter with `data-letter-part`, so extraction is exact rather than guessed:
 *   recipient (children data-line="name|attention|address", data-email on the element), ref-our, ref-your, ref-claim,
 *   ref-client, ref-vehicle, ref-accident, ref-date, subject (p.re or table.subject), salutation, body (main.body),
 *   reply-by, valediction, signatory-name, enclosures, cc.
 * Body: each top-level paragraph, heading or list item becomes one paragraph (the letterhead numbers them); a table
 * becomes tab-separated lines (caption first); boxes (div) are read through. The subject, salutation and reply-by
 * parts inside the body are not repeated as paragraphs.
 *
 * No DOM library: a small tag scanner is enough for the HTML our own layout produces (well-formed, escaped).
 * Returns null when the HTML has no data-letter-part="body" (not a letter, or a layout without the attributes).
 */
import type { LetterContent } from './docx/types.js';

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent?: El;
}
type Node = El | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'svg', 'template', 'title', 'textarea']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'address', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'pre', 'dl', 'dt', 'dd']);
const HEADING = /^h[1-6]$/;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©' };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name) continue;
    attrs[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Tolerant HTML → tree. Unknown/unbalanced end tags close back to the nearest matching open element or are ignored. */
export function parseHtmlTree(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  let cur = root;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      cur.children.push(html.slice(i));
      break;
    }
    if (lt > i) cur.children.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = html[lt + 1] === '/';
    const m = /^<\/?([a-zA-Z][\w:-]*)([^>]*)>/.exec(html.slice(lt, Math.min(n, lt + 4096)));
    if (!m) {
      cur.children.push('<');
      i = lt + 1;
      continue;
    }
    const tag = (m[1] ?? '').toLowerCase();
    i = lt + m[0].length;
    if (close) {
      let e: El | undefined = cur;
      while (e && e.tag !== tag) e = e.parent;
      if (e && e.parent) cur = e.parent;
      continue;
    }
    const rawAttrs = m[2] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const el: El = { tag, attrs: parseAttrs(rawAttrs.replace(/\/\s*$/, '')), children: [], parent: cur };
    // implicit close of an open <p> by a block element (HTML rule; our layout never relies on it)
    if (BLOCK.has(tag) && cur.tag === 'p' && tag !== 'p' && cur.parent) cur = cur.parent;
    if (tag === 'p' && cur.tag === 'p' && cur.parent) cur = cur.parent;
    el.parent = cur;
    cur.children.push(el);
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = end < 0 ? n : end;
      el.children.push(html.slice(i, stop));
      const gt = end < 0 ? n : html.indexOf('>', end);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    cur = el;
  }
  return root;
}

function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    yield c;
    yield* walk(c);
  }
}

function findAll(root: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  for (const e of walk(root)) if (pred(e)) out.push(e);
  return out;
}

function hasClass(e: El, cls: string): boolean {
  return (e.attrs.class ?? '').split(/\s+/).includes(cls);
}

function partOf(e: El): string | undefined {
  return e.attrs['data-letter-part'];
}

/** Text of an element: `<br>` → newline, block boundaries → newline, cells → tab; whitespace collapsed per line. */
export function elementText(node: Node): string {
  const parts: string[] = [];
  const rec = (x: Node): void => {
    if (typeof x === 'string') {
      parts.push(decodeHtmlEntities(x).replace(/\s+/g, ' '));
      return;
    }
    if (RAW.has(x.tag)) return;
    if (x.tag === 'br') {
      parts.push('\n');
      return;
    }
    if (x.tag === 'td' || x.tag === 'th') parts.push('\t');
    else if (BLOCK.has(x.tag)) parts.push('\n');
    else if (x.tag === 'span' && hasClass(x, 'note')) parts.push(' — ');
    for (const c of x.children) rec(c);
    if (BLOCK.has(x.tag)) parts.push('\n');
  };
  rec(node);
  return parts
    .join('')
    .split('\n')
    .map((l) =>
      l
        .split('\t')
        .map((c) => c.replace(/ +/g, ' ').trim())
        .filter((c, idx, arr) => c !== '' || (idx > 0 && idx < arr.length - 1))
        .join('\t'),
    )
    .filter((l) => l.trim() !== '')
    .join('\n');
}

function tableLines(table: El): string {
  const lines: string[] = [];
  for (const c of walk(table)) {
    if (c.tag === 'caption') lines.push(elementText(c));
    if (c.tag === 'tr') {
      const cells = c.children.filter((x): x is El => typeof x !== 'string' && (x.tag === 'td' || x.tag === 'th')).map((cell) => elementText(cell).replace(/[\t\n]+/g, ' ').trim());
      if (cells.some(Boolean)) lines.push(cells.join('\t'));
    }
  }
  return lines.join('\n');
}

/** Parts that never become body paragraphs (they fill their own slots on the letterhead). */
const NOT_BODY = new Set(['subject', 'salutation', 'reply-by', 'valediction', 'signatory-name', 'enclosures', 'cc', 'recipient']);

function bodyParagraphs(body: El): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t) out.push(t);
  };
  const visit = (e: El): void => {
    const part = partOf(e);
    if (part && NOT_BODY.has(part)) return;
    if (RAW.has(e.tag)) return;
    if (e.tag === 'p' || HEADING.test(e.tag) || e.tag === 'pre' || e.tag === 'blockquote' || e.tag === 'address') return push(elementText(e));
    if (e.tag === 'ul' || e.tag === 'ol' || e.tag === 'dl') {
      for (const li of e.children) if (typeof li !== 'string' && (li.tag === 'li' || li.tag === 'dt' || li.tag === 'dd')) push(elementText(li));
      return;
    }
    if (e.tag === 'table') return push(tableLines(e));
    const blockChildren = e.children.some((c) => typeof c !== 'string' && (BLOCK.has(c.tag) || (partOf(c) !== undefined && NOT_BODY.has(partOf(c)!))));
    if (!blockChildren) return push(elementText(e));
    // a box (callout, avoid-break wrapper): loose inline content between its blocks is a paragraph of its own
    let loose: Node[] = [];
    const flush = () => {
      if (loose.length) push(elementText({ tag: 'span', attrs: {}, children: loose }));
      loose = [];
    };
    for (const c of e.children) {
      if (typeof c !== 'string' && partOf(c) && NOT_BODY.has(partOf(c)!)) continue;
      if (typeof c === 'string' || !BLOCK.has(c.tag)) {
        loose.push(c);
        continue;
      }
      flush();
      visit(c);
    }
    flush();
  };
  for (const c of body.children) {
    if (typeof c === 'string') {
      push(decodeHtmlEntities(c).replace(/\s+/g, ' '));
      continue;
    }
    visit(c);
  }
  return out;
}

function rowValue(tr: El): string {
  const td = tr.children.find((c): c is El => typeof c !== 'string' && c.tag === 'td');
  return td ? elementText(td).replace(/\s*\n\s*/g, ' ').trim() : '';
}

const LONG_DATE = /\b\d{1,2}(?:st|nd|rd|th)? (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/;

/**
 * Re-compose an HTML letter's content for the Word letterhead. Pure. Returns null when the HTML carries no
 * data-letter-part="body" (not a letter from baseLayout).
 */
export function extractLetterContent(html: string): LetterContent | null {
  const root = parseHtmlTree(html);
  const parts = findAll(root, (e) => partOf(e) !== undefined);
  const first = (p: string): El | undefined => parts.find((e) => partOf(e) === p);
  const body = first('body');
  if (!body) return null;

  // Recipient
  const rec = first('recipient');
  const lines = (kind: string): string[] => (rec ? findAll(rec, (e) => e.attrs['data-line'] === kind).map((e) => elementText(e).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean) : []);
  const name = lines('name')[0] ?? '';
  const attention = lines('attention')[0];
  const email = rec?.attrs['data-email']?.trim();
  const recipient: LetterContent['recipient'] = { name, addressLines: lines('address') };
  if (attention) recipient.attention = attention;
  if (email) recipient.email = email;

  // Reference rows: the first occurrence of each part wins (the ref table comes before the subject table)
  const ref = (p: string): string | undefined => {
    const e = first(p);
    if (!e) return undefined;
    const v = e.tag === 'tr' ? rowValue(e) : elementText(e);
    return v.trim() || undefined;
  };
  const titleEl = findAll(root, (e) => e.tag === 'title')[0];
  const titleText = titleEl ? decodeHtmlEntities(String(titleEl.children[0] ?? '')).trim() : '';
  const metaRef = findAll(root, (e) => e.tag === 'meta' && e.attrs.name === 'ccguk:reference')[0]?.attrs.content;
  const refs: LetterContent['refs'] = { ourRef: ref('ref-our') ?? metaRef ?? '', date: ref('ref-date') ?? '' };
  const yourRef = ref('ref-your');
  const claimNo = ref('ref-claim');
  const client = ref('ref-client');
  const vehicle = ref('ref-vehicle');
  const accident = ref('ref-accident');
  if (yourRef) refs.yourRef = yourRef;
  if (claimNo) refs.claimNo = claimNo;
  if (client) refs.client = client;
  if (vehicle) refs.vehicle = vehicle;
  if (accident) refs.dateOfAccident = accident;

  // Subject: a "Re:" line prints as written; a subject table gives the document title + client + registration
  const subjectEl = first('subject');
  const docTitle = titleText.replace(/\s+—\s+[^—]*$/, '').trim();
  let subject = '';
  if (subjectEl && subjectEl.tag !== 'table') subject = elementText(subjectEl).replace(/\s*\n\s*/g, ' ').replace(/^re\s*:\s*/i, '').trim();
  if (!subject) subject = docTitle || 'Your claim';
  const subjectReg = vehicle ? vehicle.split(/\s+[—–-]\s+/)[0]?.trim() : undefined;

  // Salutation "Dear Sirs," → "Sirs"
  const salEl = first('salutation');
  const salutation = salEl ? elementText(salEl).replace(/^\s*dear\s+/i, '').replace(/[,\s]+$/, '').trim() : 'Sir or Madam';

  // Reply by: the date in the reply-by sentence
  const replyEl = first('reply-by');
  const replyBy = replyEl ? LONG_DATE.exec(elementText(replyEl))?.[0] : undefined;

  const valEl = first('valediction');
  const valText = valEl ? elementText(valEl).toLowerCase() : '';
  const valediction: LetterContent['valediction'] = /sincerely/.test(valText) ? 'sincerely' : /faithfully/.test(valText) ? 'faithfully' : undefined;

  const sigEl = first('signatory-name');
  const strong = sigEl ? findAll(sigEl, (e) => e.tag === 'strong' || e.tag === 'b')[0] : undefined;
  const signatoryName = (strong ? elementText(strong) : sigEl ? (elementText(sigEl).split('\n')[0] ?? '') : '').trim();

  const listItems = (p: string): string[] | undefined => {
    const e = first(p);
    if (!e) return undefined;
    const items = findAll(e, (x) => x.tag === 'li').map((li) => elementText(li).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    return items.length ? items : undefined;
  };

  // A reply-by sentence whose date could not be read stays in the body (never silently dropped)
  const paragraphs = bodyParagraphs(body);
  if (replyEl && !replyBy) paragraphs.push(elementText(replyEl));

  const out: LetterContent = {
    recipient,
    refs,
    salutation: salutation || 'Sir or Madam',
    subject,
    paragraphs,
    replaceFixedOpening: true,
    signatory: { name: signatoryName },
  };
  if (client) out.subjectClient = client;
  if (subjectReg) out.subjectReg = subjectReg;
  if (replyBy) out.replyBy = replyBy;
  if (valediction) out.valediction = valediction;
  const enclosures = listItems('enclosures');
  const cc = listItems('cc');
  if (enclosures) out.enclosures = enclosures;
  if (cc) out.cc = cc;
  return out;
}
