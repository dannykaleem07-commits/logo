// owned by mail
/**
 * Parsing an RFC 5322 message (docs/SUPREME-DESIGN.md §F.3, §K.1): mailparser 3.9.36 → a plain structure. HTML is
 * converted to text locally (no remote content is ever fetched; images, scripts, styles and hidden elements are
 * dropped). `Authentication-Results` (SPF/DKIM/DMARC/ARC) is parsed into `auth`; a From domain that belongs to an
 * insurer in the directory but fails DMARC — or a known copycat domain — makes the message a spoof suspect.
 */
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { InsurerDirectoryEntry } from '@ccguk/domain';

export interface ParsedAttachment {
  filename: string;
  mime: string;
  content: Buffer;
  bytes: number;
  contentId?: string;
  inline: boolean;
}

export interface AuthResults {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  arc?: string;
  /** The raw Authentication-Results header values, top (newest) first. */
  raw: string[];
}

export interface ParsedMessage {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  fromAddr?: string;
  fromName?: string;
  replyTo?: string;
  to: string[];
  cc: string[];
  subject?: string;
  date?: string;
  /** Plain text: the text part, else the HTML converted to text. */
  text: string;
  /** The HTML part as received (never rendered; used only for the hidden-text heuristic). */
  html?: string;
  attachments: ParsedAttachment[];
  auth: AuthResults;
}

const addresses = (a: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value.flatMap((v) => (v.group ? v.group : [v]))).filter((v) => v.address).map((v) => ({ address: v.address!.trim().toLowerCase(), name: v.name ?? '' }));

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', pound: '£', ndash: '–', mdash: '—', hellip: '…' };

/** Plain text from HTML: no markup, no remote content, hidden elements and comments removed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z0-9]+)\b[^>]*\bstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k]!;
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text that an HTML part hides from a person (display:none / visibility:hidden / zero font) — an injection signal. */
export function hiddenHtmlText(html: string | undefined): string {
  if (!html) return '';
  const hidden: string[] = [];
  const re = /<([a-z0-9]+)\b[^>]*\bstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em)?\s*(?:;|["']))[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = htmlToText(m[3] ?? '').trim();
    if (t) hidden.push(t);
  }
  return hidden.join('\n');
}

/** `Authentication-Results` values → {spf, dkim, dmarc, arc} of the newest header. */
export function parseAuthResults(values: string[]): AuthResults {
  const out: AuthResults = { raw: values };
  const first = values[0];
  if (!first) return out;
  for (const method of ['spf', 'dkim', 'dmarc', 'arc'] as const) {
    const m = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, 'i').exec(first);
    if (m) out[method] = m[1]!.toLowerCase();
  }
  return out;
}

const domainOf = (address: string | undefined): string | undefined => address?.split('@')[1]?.trim().toLowerCase() || undefined;

/** Email domains a directory entry uses (claims, third-party and complaints addresses). */
export function directoryDomains(e: InsurerDirectoryEntry): string[] {
  return [...new Set([e.claimsEmail, e.thirdPartyEmail, e.complaintsEmail].map(domainOf).filter((d): d is string => Boolean(d)))];
}

export interface SpoofCheck {
  suspect: boolean;
  reason?: string;
  insurerId?: string;
}

/**
 * Spoof suspicion (§F.3): the From domain is a known copycat of an insurer, or it is an insurer's real domain but DMARC
 * failed. A message with no Authentication-Results is not a suspect on that ground alone.
 */
export function spoofCheck(fromAddr: string | undefined, auth: AuthResults, directory: readonly InsurerDirectoryEntry[]): SpoofCheck {
  const domain = domainOf(fromAddr);
  if (!domain) return { suspect: false };
  for (const e of directory) {
    if ((e.copycatDomains ?? []).some((c) => c.trim().toLowerCase() === domain)) return { suspect: true, reason: `${domain} is a known copycat of ${e.name}`, insurerId: e.id };
  }
  const insurer = directory.find((e) => directoryDomains(e).includes(domain));
  if (insurer && auth.dmarc && auth.dmarc !== 'pass' && auth.dmarc !== 'bestguesspass') return { suspect: true, reason: `Claims to be from ${insurer.name} (${domain}) but DMARC ${auth.dmarc}`, insurerId: insurer.id };
  return { suspect: false };
}

const header = (parsed: ParsedMail, key: string): string[] => parsed.headerLines.filter((l) => l.key.toLowerCase() === key).map((l) => l.line.replace(/^[^:]+:\s*/, '').replace(/\r?\n[ \t]+/g, ' ').trim());

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const from = addresses(parsed.from)[0];
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const text = (parsed.text && parsed.text.trim()) || (html ? htmlToText(html) : '');
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : [];
  return {
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo.trim() } : {}),
    references,
    ...(from ? { fromAddr: from.address, fromName: from.name } : {}),
    ...(addresses(parsed.replyTo)[0] ? { replyTo: addresses(parsed.replyTo)[0]!.address } : {}),
    to: addresses(parsed.to).map((a) => a.address),
    cc: addresses(parsed.cc).map((a) => a.address),
    ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
    ...(parsed.date && !Number.isNaN(parsed.date.getTime()) ? { date: parsed.date.toISOString() } : {}),
    text: text.replace(/\r\n/g, '\n'),
    ...(html ? { html } : {}),
    attachments: parsed.attachments.map((a, i) => ({
      filename: (a.filename && a.filename.trim()) || `attachment-${i + 1}${extFor(a.contentType)}`,
      mime: (a.contentType || 'application/octet-stream').toLowerCase(),
      content: a.content,
      bytes: a.size ?? a.content.length,
      ...(a.contentId ? { contentId: a.contentId } : {}),
      inline: a.contentDisposition === 'inline' || Boolean(a.related),
    })),
    auth: parseAuthResults(header(parsed, 'authentication-results')),
  };
}

function extFor(mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase();
  return m === 'application/pdf' ? '.pdf' : m === 'image/jpeg' ? '.jpg' : m === 'image/png' ? '.png' : m.startsWith('text/') ? '.txt' : '.bin';
}

/** Thread key: the first Message-ID of the References chain, else In-Reply-To, else this message's own id. */
export function threadKeyFor(p: Pick<ParsedMessage, 'messageId' | 'inReplyTo' | 'references'>, fallback: string): string {
  const norm = (s: string | undefined) => s?.trim().replace(/^<+/, '').replace(/>+$/, '').toLowerCase() || undefined;
  return norm(p.references[0]) ?? norm(p.inReplyTo) ?? norm(p.messageId) ?? fallback;
}
