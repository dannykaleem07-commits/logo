/**
 * Base layout and partials shared by every template.
 *
 * `baseLayout()` returns a complete, self-contained HTML document: brand CSS, logo lockup (inline SVG), the
 * reference/date block, the body, an optional signature block and a screen-only footer carrying the status
 * line and Part 6 trading disclosure. In the PDF those two lines come from `footerTemplate()` (Playwright
 * prints it on every page) and the running reference + "Page X of Y" from `headerTemplate()`.
 *
 * All partials return HTML strings and escape the data they are given. Partials that print money or dates use
 * the shared formatters only.
 *
 * Letter parts (design doc §C.7/§H.3): the elements a letter is made of carry `data-letter-part` attributes so the
 * HTML can be re-composed on the CCGUK Word letterhead exactly (extractLetterContent, templates-api slice):
 *   recipient (address; children carry data-line="name|attention|address", the address element data-email),
 *   ref-our, ref-your, ref-claim, ref-client, ref-vehicle, ref-accident, ref-date (ref table and subject table rows),
 *   subject (p.re and table.subject), salutation (the first "Dear …" paragraph of a letter body), body (main.body),
 *   reply-by (replyByLine partial), valediction (closing), signatory-name (p.sig-name), enclosures, cc.
 * Templates stay pure: the attributes come from the partials and baseLayout only.
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { brand, formatRegisteredOffice } from './brand.js';
import type { ClaimHeader, CompanySettings, FigureRow, RecipientBlock, Signatory, TemplateKind } from './common.js';
import {
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatGBP,
  formatRegistration,
  sumPence
} from './format.js';
import { logoLockup } from './logo.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Document title: the <title>, and the H1 on everything except letters. */
  title: string;
  kind: TemplateKind;
  /** Our reference (claim reference, invoice number, agreement number…). Also printed in the running header. */
  reference: string;
  theirReference?: string;
  /** Document date, from the data object. */
  date: ISODate | ISODateTime;
  recipient?: RecipientBlock;
  /** The document body (HTML built with the partials below). */
  bodyHtml: string;
  /** Full company details block alongside the logo. Default: true for invoices, otherwise a compact contact strip. */
  showCompanyBlock?: boolean;
  /** Appends a signature block ("for and on behalf of Courtesy Cars Group UK Ltd"). */
  signatory?: Signatory;
  /** Closing line before the signature (letters default to "Yours faithfully"). Pass '' for none. */
  closing?: string;
  /** Registered office / VAT / ICO for the company block and the trading disclosure. */
  settings?: Pick<CompanySettings, 'registeredOffice'> & Partial<Pick<CompanySettings, 'vatNumber' | 'icoRegistration'>>;
  /** Show the H1 title block. Default: kind !== 'letter'. */
  showTitle?: boolean;
  subtitle?: string;
  /** Extra rows in the reference block, e.g. { label: 'Invoice number', value: 'INV-0042' }. Values are escaped. */
  meta?: Array<{ label: string; value: string }>;
  landscape?: boolean;
  /** Additional CSS appended after the base stylesheet. */
  extraCss?: string;
  /** Enclosures listed after the signature (data-letter-part="enclosures"). */
  enclosures?: string[];
  /** Copy recipients listed after the signature (data-letter-part="cc"). */
  cc?: string[];
  /** Document language for the html element. Default en-GB. */
  lang?: string;
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

const c = brand.colours;
const t = brand.typography;
const m = brand.page.marginMm;

export const documentCss = `
:root{--navy:${c.navy};--accent:${c.accent};--gold:${c.gold};--silver:${c.silver};--tint:${c.tint};--ink:${c.ink};--rule:${c.rule};}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{font-family:${t.fontStack};font-size:${t.bodyPt}pt;line-height:1.45;color:var(--ink);background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@media screen{
  html{background:#E9EBF0;}
  body{padding:24px 0;}
  .page{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;box-shadow:0 2px 14px rgba(13,28,80,.14);}
  .page.landscape{width:297mm;min-height:210mm;}
}
@media print{
  .screen-only{display:none !important;}
  .page{width:auto;min-height:0;padding:0;box-shadow:none;}
}
h1{font-size:${t.h1Pt}pt;line-height:1.2;color:var(--navy);margin:0 0 1.5mm;font-weight:700;}
h2{font-size:${t.h2Pt}pt;line-height:1.25;color:var(--accent);margin:6mm 0 2mm;font-weight:700;break-after:avoid;page-break-after:avoid;}
h3{font-size:11pt;color:var(--navy);margin:4mm 0 1.5mm;font-weight:700;break-after:avoid;page-break-after:avoid;}
p{margin:0 0 3mm;orphans:2;widows:2;}
small,.small{font-size:${t.smallPt}pt;}
.muted{color:var(--silver);}
.navy{color:var(--navy);}
a{color:var(--accent);text-decoration:none;}
ol,ul{margin:0 0 3mm;padding-left:6mm;}
ol.numbered>li,ul.bullets>li{margin-bottom:1.8mm;}
ol.numbered>li::marker{font-weight:700;color:var(--navy);}
hr{border:0;border-top:1px solid var(--rule);margin:5mm 0;}

/* masthead */
.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;padding-bottom:3mm;border-bottom:1.5px solid var(--navy);margin-bottom:6mm;}
.logo-lockup{flex:0 0 auto;}
.logo-lockup svg{display:block;width:100%;height:auto;}
.masthead-right{text-align:right;font-size:${t.smallPt}pt;line-height:1.45;color:var(--navy);}
[data-block="letterhead"] .name{font-weight:700;font-size:${t.bodyPt}pt;letter-spacing:.04em;text-transform:uppercase;}
[data-block="letterhead"] .company-no{color:var(--silver);}
.company-block .tagline,.contact-strip .services{color:var(--gold);text-transform:uppercase;letter-spacing:.08em;font-size:7.5pt;font-weight:700;margin-bottom:.8mm;}
.letter-extras{margin-top:5mm;font-size:9.5pt;break-inside:avoid;page-break-inside:avoid;}
.letter-extras .extras-label{font-weight:700;color:var(--navy);margin:0 0 1mm;}
.letter-extras ul{list-style:none;padding-left:0;margin:0 0 2mm;}
.partner-mark{display:none;}

/* title and reference block */
.doc-title{margin-bottom:5mm;}
.doc-title .subtitle{color:var(--silver);font-size:${t.bodyPt}pt;margin:0;}
.letter-block{display:flex;justify-content:space-between;align-items:flex-start;gap:10mm;margin-bottom:6mm;}
.recipient{min-width:60mm;line-height:1.4;}
.recipient .name{font-weight:700;color:var(--navy);}
.recipient .delivery{color:var(--silver);font-size:${t.smallPt}pt;margin-bottom:1mm;}
.ref-table{border-collapse:collapse;font-size:9.5pt;}
.ref-table th{text-align:left;color:var(--silver);font-weight:400;font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;padding:0 4mm .6mm 0;white-space:nowrap;vertical-align:baseline;}
.ref-table td{padding:0 0 .6mm;font-weight:600;color:var(--navy);vertical-align:baseline;}
.re{font-weight:700;color:var(--navy);margin:0 0 4mm;}
table.subject{border-collapse:collapse;margin:0 0 5mm;font-size:9.5pt;}
table.subject th{text-align:left;color:var(--silver);font-weight:400;padding:.4mm 5mm .4mm 0;white-space:nowrap;vertical-align:top;}
table.subject td{padding:.4mm 0;font-weight:600;color:var(--navy);vertical-align:top;}

/* tables */
table.data{width:100%;border-collapse:collapse;margin:3mm 0 5mm;font-size:9.5pt;}
table.data caption{text-align:left;font-weight:700;color:var(--navy);padding:0 0 1.5mm;caption-side:top;}
table.data thead{display:table-header-group;}
table.data th{background:var(--tint);color:var(--navy);text-align:left;font-weight:700;padding:1.8mm 2.5mm;border-bottom:1px solid var(--rule);font-size:8.5pt;text-transform:uppercase;letter-spacing:.04em;}
table.data td{padding:1.6mm 2.5mm;border-bottom:1px solid var(--rule);vertical-align:top;}
table.data tr{break-inside:avoid;page-break-inside:avoid;}
table.data td.num,table.data th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
table.data td.nowrap{white-space:nowrap;}
table.data .note{display:block;font-size:${t.smallPt}pt;color:var(--silver);font-weight:400;}
table.figures td.label{width:62%;}
table.figures tr.total td{font-weight:700;color:var(--navy);border-top:1.5px solid var(--navy);border-bottom:0;}
table.figures tr.subtotal td{font-weight:600;}
table.schedule tr.total td{font-weight:700;color:var(--navy);border-top:1.5px solid var(--navy);border-bottom:0;}
table.chronology td.date{white-space:nowrap;width:34mm;}
table.kv th{width:38%;background:transparent;text-transform:none;letter-spacing:0;font-size:9.5pt;color:var(--silver);font-weight:400;}

/* callout, signature, statement of truth */
.callout{background:var(--tint);border-left:3px solid var(--gold);padding:3mm 4mm;margin:4mm 0;break-inside:avoid;page-break-inside:avoid;}
.callout .callout-title{font-weight:700;color:var(--navy);margin:0 0 1mm;}
.callout p:last-child{margin-bottom:0;}
.signature{margin-top:8mm;break-inside:avoid;page-break-inside:avoid;}
.signature .closing{margin-bottom:0;}
.signature .sig-space{height:14mm;}
.signature .sig-line{width:70mm;border-bottom:1px solid var(--ink);margin-bottom:1.5mm;}
.signature .sig-name{margin:0;line-height:1.4;}
.signature .sig-date{margin:1.5mm 0 0;}
.statement-of-truth{border:1px solid var(--navy);padding:3.5mm 4mm;margin:6mm 0;break-inside:avoid;page-break-inside:avoid;}
.statement-of-truth h3{margin-top:0;}
.statement-of-truth p:last-of-type{margin-bottom:0;}
.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm 8mm;margin-top:6mm;}
.sig-field .field-line{border-bottom:1px solid var(--ink);height:9mm;}
.sig-field .field-value{font-weight:600;}
.sig-field .field-label{font-size:${t.smallPt}pt;color:var(--silver);margin-top:1mm;}
.re-executed{font-size:${t.smallPt}pt;color:var(--navy);border-top:1px solid var(--rule);padding-top:1.5mm;margin-top:3mm;}

/* utilities */
.page-break{break-before:page;page-break-before:always;}
.avoid-break{break-inside:avoid;page-break-inside:avoid;}
.right{text-align:right;}
.center{text-align:center;}
.mt{margin-top:5mm;}
.screen-footer{margin-top:12mm;border-top:1px solid var(--rule);padding-top:2mm;font-size:7.5pt;line-height:1.4;color:var(--silver);text-align:center;}
`;

// ---------------------------------------------------------------------------
// Masthead pieces
// ---------------------------------------------------------------------------

/** The registered office to print: the settings value when set, otherwise the brand default (never a placeholder). */
export function effectiveRegisteredOffice(settings?: { registeredOffice?: string }): string {
  return settings?.registeredOffice?.trim() || formatRegisteredOffice();
}

/** "Case handler 07425 475922 · Office 020 7052 5403" — the letterhead's telephone line (plain text). */
export function letterheadPhoneLine(): string {
  return `Case handler ${brand.company.caseHandlerPhone} \u00b7 Office ${brand.company.officePhone}`;
}

/** "claims@courtesycars.net · www.courtesycars.net" (plain text). */
export function letterheadWebLine(): string {
  return `${brand.company.claimsEmail} \u00b7 ${brand.company.website}`;
}

/** Letterhead first-page header lines: name, office, telephones, email/web, company number (+ VAT, ICO when set). */
function letterheadLines(cls: string, settings?: LayoutOptions['settings'], withTaxIds = false): string {
  const office = effectiveRegisteredOffice(settings);
  const vat = withTaxIds ? settings?.vatNumber?.trim() : undefined;
  const ico = withTaxIds ? settings?.icoRegistration?.trim() : undefined;
  return `<div class="${cls}" data-block="letterhead">
  <div class="name">${escapeHtml(brand.company.registeredName.toUpperCase())}</div>
  <div class="office">${escapeHtml(office)}</div>
  <div class="phones">${escapeHtml(letterheadPhoneLine())}</div>
  <div class="web">${escapeHtml(letterheadWebLine())}</div>
  <div class="company-no">Company no. ${escapeHtml(brand.company.companyNumber)}${vat ? ` &middot; VAT number ${escapeHtml(vat)}` : ''}${ico ? ` &middot; ICO ${escapeHtml(ico)}` : ''}</div>
</div>`;
}

/**
 * Full company details alongside the logo (invoices): the letterhead block plus VAT and ICO numbers when Settings
 * hold them. The registered office falls back to the brand default.
 */
export function companyBlock(settings?: LayoutOptions['settings']): string {
  return letterheadLines('company-block', settings, true);
}

/** Letterhead block for letters, notices and forms (same lines as the CCGUK letterhead's first-page header). */
export function contactStrip(settings?: LayoutOptions['settings']): string {
  return letterheadLines('contact-strip', settings, false);
}

/** Renders nothing while brand.partnerMarkEnabled is false (no signed partnership record uploaded). */
export function partnerMarkSlot(): string {
  if (!brand.partnerMarkEnabled) return '';
  return '<div class="partner-mark" data-slot="partner-mark"></div>';
}

// ---------------------------------------------------------------------------
// Reference / recipient block
// ---------------------------------------------------------------------------

export interface LetterBlockOptions {
  reference: string;
  theirReference?: string;
  date: ISODate | ISODateTime;
  recipient?: RecipientBlock;
  meta?: Array<{ label: string; value: string }>;
}

export type LetterRefPart = 'ref-our' | 'ref-your' | 'ref-claim' | 'ref-client' | 'ref-vehicle' | 'ref-accident' | 'ref-date';

/** Letter part for a reference / subject row, inferred from its label ("Claim number" → ref-claim). */
export function refPartForLabel(label: string): LetterRefPart | undefined {
  const l = label.trim().toLowerCase();
  if (/^our ref/.test(l)) return 'ref-our';
  if (/^your ref/.test(l)) return 'ref-your';
  if (/claim (no|number|ref)/.test(l)) return 'ref-claim';
  if (/accident/.test(l)) return 'ref-accident';
  if (/^(our client|client|claimant)\b/.test(l)) return 'ref-client';
  if (/^(vehicle|registration)\b/.test(l)) return 'ref-vehicle';
  if (l === 'date') return 'ref-date';
  return undefined;
}

function partAttr(part: string | undefined): string {
  return part ? ` data-letter-part="${part}"` : '';
}

/** Recipient (left) and Our ref / Your ref / Date table (right). */
export function letterBlock(opts: LetterBlockOptions): string {
  const rows: Array<{ label: string; value: string; part?: LetterRefPart }> = [{ label: 'Our ref', value: opts.reference, part: 'ref-our' }];
  if (opts.theirReference && opts.theirReference.trim() !== '') rows.push({ label: 'Your ref', value: opts.theirReference, part: 'ref-your' });
  rows.push({ label: 'Date', value: formatDateLong(opts.date), part: 'ref-date' });
  for (const extra of opts.meta ?? []) {
    const part = refPartForLabel(extra.label);
    // a part is claimed once: a meta row never shadows Our ref / Your ref / Date
    rows.push({ ...extra, part: part && !rows.some((r) => r.part === part) ? part : undefined });
  }
  const refTable = `<table class="ref-table">${rows
    .map((r) => `<tr${partAttr(r.part)}><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`)
    .join('')}</table>`;
  return `<section class="letter-block">
  ${opts.recipient ? recipientBlock(opts.recipient) : '<div class="recipient"></div>'}
  ${refTable}
</section>`;
}

/**
 * Addressee block. `data-letter-part="recipient"`; each printed line carries `data-line` ("name", "attention",
 * "address"); the email (when the letter goes by email) is on the address element as `data-email`.
 */
export function recipientBlock(r: RecipientBlock): string {
  const lines: string[] = [];
  if (r.email) lines.push(`<div class="delivery">By email: ${escapeHtml(r.email)}</div>`);
  lines.push(`<div class="name" data-line="name">${escapeHtml(r.name)}</div>`);
  if (r.attention) lines.push(`<div data-line="attention">${escapeHtml(r.attention)}</div>`);
  for (const l of r.addressLines) if (l && l.trim() !== '') lines.push(`<div data-line="address">${escapeHtml(l)}</div>`);
  const email = r.email ? ` data-email="${escapeHtml(r.email)}"` : '';
  return `<address class="recipient" data-letter-part="recipient"${email} style="font-style:normal">${lines.join('')}</address>`;
}

/** Bold "Re:" line for letters (data-letter-part="subject"). */
export function reLine(text: string): string {
  return `<p class="re" data-letter-part="subject">${escapeHtml(text)}</p>`;
}

/** Salutation paragraph ("Dear Sirs,") — data-letter-part="salutation". */
export function salutationLine(text: string): string {
  return `<p data-letter-part="salutation">${escapeHtml(text)}</p>`;
}

/** A reply-by sentence (data-letter-part="reply-by"). `html` is not escaped: build it with escaped parts. */
export function replyByLine(html: string): string {
  return `<p data-letter-part="reply-by">${html}</p>`;
}

/** Enclosures list for a letter (data-letter-part="enclosures"). Empty list → ''. */
export function enclosuresList(items: ReadonlyArray<string>, heading = 'Enclosures'): string {
  const list = items.filter((i) => i && i.trim() !== '');
  if (list.length === 0) return '';
  return `<div class="letter-extras" data-letter-part="enclosures"><p class="extras-label">${escapeHtml(heading)}</p><ul>${list
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join('')}</ul></div>`;
}

/** Copy recipients for a letter (data-letter-part="cc"). Empty list → ''. */
export function ccList(items: ReadonlyArray<string>): string {
  const list = items.filter((i) => i && i.trim() !== '');
  if (list.length === 0) return '';
  return `<div class="letter-extras" data-letter-part="cc"><p class="extras-label">Copy to</p><ul>${list.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
}

/**
 * Marks the first "Dear …," paragraph of a letter body as the salutation, so letters whose templates write the
 * salutation inline are still extractable. Only a plain `<p>` whose whole text starts with "Dear " is marked.
 */
export function markSalutation(bodyHtml: string): string {
  if (bodyHtml.includes('data-letter-part="salutation"')) return bodyHtml;
  return bodyHtml.replace(/<p>(\s*Dear [^<]{1,200})<\/p>/, '<p data-letter-part="salutation">$1</p>');
}

export interface SubjectBlockOptions {
  /** Show the third-party driver and registration ("Your insured"). Default: when claim.thirdPartyName is set. */
  showThirdParty?: boolean;
  /** Label for the claimant row. Default "Our client". */
  claimantLabel?: string;
}

/** The claim facts table that opens a letter: claimant, vehicle, accident date, your insured, your reference. */
export function subjectBlock(claim: ClaimHeader, opts: SubjectBlockOptions = {}): string {
  const rows: Array<[string, string]> = [];
  rows.push([opts.claimantLabel ?? 'Our client', claim.claimantName]);
  const veh = `${formatRegistration(claim.vehicleRegistration)}${claim.vehicleDescription ? ` — ${claim.vehicleDescription}` : ''}`;
  rows.push(['Vehicle', veh]);
  rows.push(['Date of accident', formatDateLong(claim.accidentDate)]);
  const showTp = opts.showThirdParty ?? Boolean(claim.thirdPartyName);
  if (showTp && (claim.thirdPartyName || claim.thirdPartyRegistration)) {
    const tp = [claim.thirdPartyName, claim.thirdPartyRegistration ? `(${formatRegistration(claim.thirdPartyRegistration)})` : '']
      .filter(Boolean)
      .join(' ');
    rows.push(['Your insured', tp]);
  }
  if (claim.policyNumber) rows.push(['Policy number', claim.policyNumber]);
  if (claim.theirReference) rows.push(['Your reference', claim.theirReference]);
  const parts: Record<number, LetterRefPart | undefined> = {};
  rows.forEach(([k], i) => {
    // the first row is the claimant whatever its label ("Our client", "Claimant", a custom label)
    parts[i] = i === 0 ? 'ref-client' : k === 'Your insured' || k === 'Policy number' ? undefined : refPartForLabel(k);
  });
  return `<table class="subject" data-letter-part="subject">${rows
    .map(([k, v], i) => `<tr${partAttr(parts[i])}><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;
}

/**
 * Perimeter-safe opening sentence (perimeter.md): "instructed to correspond on behalf of", never "we act for".
 * Claims management, not legal services.
 */
export function standardOpener(claim: ClaimHeader): string {
  const vehicle = `${claim.vehicleDescription ? `${claim.vehicleDescription}, ` : ''}registration ${formatRegistration(claim.vehicleRegistration)}`;
  return `<p>We are instructed to correspond on behalf of ${escapeHtml(claim.claimantName)} in connection with the road traffic accident on ${escapeHtml(
    formatDateLong(claim.accidentDate)
  )} involving the vehicle ${escapeHtml(vehicle)}.</p>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface FiguresTableOptions {
  caption?: string;
  /** Column headings; omit for a headerless table. */
  headings?: [string, string];
}

/** Label / amount table. Rows with `emphasis` are totals (bold, rule above). Amounts via formatGBP only. */
export function figuresTable(rows: ReadonlyArray<FigureRow>, opts: FiguresTableOptions = {}): string {
  if (rows.length === 0) return '';
  const head = opts.headings
    ? `<thead><tr><th>${escapeHtml(opts.headings[0])}</th><th class="num">${escapeHtml(opts.headings[1])}</th></tr></thead>`
    : '';
  const body = rows
    .map((r) => {
      const value = r.valuePence !== undefined ? formatGBP(r.valuePence) : (r.text ?? '');
      const note = r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : '';
      return `<tr${r.emphasis ? ' class="total"' : ''}><td class="label">${escapeHtml(r.label)}${note}</td><td class="num">${escapeHtml(value)}</td></tr>`;
    })
    .join('\n');
  return `<table class="data figures">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

export interface ChronologyEvent {
  date: ISODate | ISODateTime;
  description: string;
  /** "insurer", "CCGUK", "repairer"… printed when any event has one. */
  attributableTo?: string;
  /** Document or evidence reference. */
  source?: string;
}

const ATTRIBUTION_LABELS: Record<string, string> = {
  insurer: 'Insurer',
  client: 'Client',
  ccguk: 'CCGUK',
  repairer: 'Repairer',
  engineer: 'Engineer',
  third_party: 'Third party',
  court: 'Court',
  other: 'Other',
  none: '\u2014'
};

/** ClaimEvent.attributableTo / Clock.attributableTo codes → labels; anything else prints as given. */
export function attributionLabel(code: string | undefined): string {
  if (!code) return '';
  return ATTRIBUTION_LABELS[code.toLowerCase()] ?? code;
}

/** Dated chronology (the period argument lives or dies on this). Events render in the order given. */
export function chronologyTable(events: ReadonlyArray<ChronologyEvent>, caption?: string): string {
  if (events.length === 0) return '';
  const showAttr = events.some((e) => e.attributableTo);
  const showSource = events.some((e) => e.source);
  const head = `<thead><tr><th>Date</th><th>Event</th>${showAttr ? '<th>Attributable to</th>' : ''}${showSource ? '<th>Source</th>' : ''}</tr></thead>`;
  const body = events
    .map(
      (e) =>
        `<tr><td class="date">${escapeHtml(e.date.includes('T') ? formatDateTime(e.date) : formatDateLong(e.date))}</td><td>${escapeHtml(e.description)}</td>${
          showAttr ? `<td>${escapeHtml(attributionLabel(e.attributableTo))}</td>` : ''
        }${showSource ? `<td>${escapeHtml(e.source ?? '')}</td>` : ''}</tr>`
    )
    .join('\n');
  return `<table class="data chronology">${caption ? `<caption>${escapeHtml(caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

export interface ScheduleLine {
  description: string;
  /** Second line under the description (period, basis, GTA group…). */
  detail?: string;
  /** Printed as given, e.g. "24 days", "31 loaded miles". */
  quantity?: string;
  ratePence?: Pence;
  netPence: Pence;
  vatPence?: Pence;
  grossPence?: Pence;
  /** Source document / evidence reference for the line. */
  source?: string;
}

export interface ScheduleTableOptions {
  caption?: string;
  /** Show VAT and gross columns. Default: when any line carries vatPence. */
  showVat?: boolean;
  /**
   * Totals as held in the ledger. When omitted they are summed from the lines (integer pence) — pass them when the
   * ledger holds its own total so the two can never differ.
   */
  totals?: { netPence: Pence; vatPence?: Pence; grossPence?: Pence };
  totalLabel?: string;
}

/** Invoice / schedule-of-loss line table with totals. */
export function scheduleTable(lines: ReadonlyArray<ScheduleLine>, opts: ScheduleTableOptions = {}): string {
  if (lines.length === 0) return '';
  const showVat = opts.showVat ?? lines.some((l) => l.vatPence !== undefined);
  const showQty = lines.some((l) => l.quantity);
  const showRate = lines.some((l) => l.ratePence !== undefined);
  const showSource = lines.some((l) => l.source);
  const grossOf = (l: ScheduleLine): Pence => l.grossPence ?? l.netPence + (l.vatPence ?? 0);
  const totals = {
    netPence: opts.totals?.netPence ?? sumPence(lines.map((l) => l.netPence)),
    vatPence: opts.totals?.vatPence ?? sumPence(lines.map((l) => l.vatPence)),
    grossPence: opts.totals?.grossPence ?? (opts.totals ? opts.totals.netPence + (opts.totals.vatPence ?? 0) : sumPence(lines.map(grossOf)))
  };
  const head = `<thead><tr><th>Item</th>${showQty ? '<th class="num">Quantity</th>' : ''}${showRate ? '<th class="num">Rate</th>' : ''}<th class="num">${
    showVat ? 'Net' : 'Amount'
  }</th>${showVat ? '<th class="num">VAT</th><th class="num">Gross</th>' : ''}${showSource ? '<th>Source</th>' : ''}</tr></thead>`;
  const body = lines
    .map((l) => {
      const desc = `${escapeHtml(l.description)}${l.detail ? `<span class="note">${escapeHtml(l.detail)}</span>` : ''}`;
      return `<tr><td>${desc}</td>${showQty ? `<td class="num">${escapeHtml(l.quantity ?? '')}</td>` : ''}${
        showRate ? `<td class="num">${l.ratePence !== undefined ? formatGBP(l.ratePence) : ''}</td>` : ''
      }<td class="num">${formatGBP(l.netPence)}</td>${
        showVat ? `<td class="num">${formatGBP(l.vatPence ?? 0)}</td><td class="num">${formatGBP(grossOf(l))}</td>` : ''
      }${showSource ? `<td>${escapeHtml(l.source ?? '')}</td>` : ''}</tr>`;
    })
    .join('\n');
  const span = 1 + (showQty ? 1 : 0) + (showRate ? 1 : 0);
  const totalRow = `<tr class="total"><td colspan="${span}">${escapeHtml(opts.totalLabel ?? 'Total')}</td><td class="num">${formatGBP(totals.netPence)}</td>${
    showVat ? `<td class="num">${formatGBP(totals.vatPence)}</td><td class="num">${formatGBP(totals.grossPence)}</td>` : ''
  }${showSource ? '<td></td>' : ''}</tr>`;
  return `<table class="data schedule">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n${totalRow}\n</tbody></table>`;
}

/** Two-column label/value table for particulars (vehicle details, bank details, policy details). */
export function keyValueTable(rows: ReadonlyArray<{ label: string; value: string }>, caption?: string): string {
  if (rows.length === 0) return '';
  const body = rows.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`).join('\n');
  return `<table class="data kv">${caption ? `<caption>${escapeHtml(caption)}</caption>` : ''}<tbody>\n${body}\n</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Callout, signature, statement of truth
// ---------------------------------------------------------------------------

/** Tinted box with a gold rule — deadlines, payment details, "what we require". `html` is not escaped. */
export function callout(html: string, title?: string): string {
  return `<div class="callout">${title ? `<div class="callout-title">${escapeHtml(title)}</div>` : ''}${html}</div>`;
}

export interface SignatureBlockOptions {
  /** "Yours faithfully" etc. Omit for none. */
  closing?: string;
  /** Default "for and on behalf of Courtesy Cars Group UK Ltd". Pass '' to omit (e.g. a claimant signing). */
  onBehalfOf?: string;
  /** Leave space for a wet or electronic signature. Default true. */
  signatureSpace?: boolean;
  /** When the document was electronically signed (from the signature record). */
  signedAt?: ISODateTime;
}

/** Signature block for CCGUK staff. */
export function signatureBlock(signatory: Signatory, date?: ISODate | ISODateTime, opts: SignatureBlockOptions = {}): string {
  const onBehalf = opts.onBehalfOf === undefined ? `for and on behalf of ${brand.company.registeredName}` : opts.onBehalfOf;
  const parts: string[] = ['<div class="signature">'];
  if (opts.closing) parts.push(`<p class="closing" data-letter-part="valediction">${escapeHtml(opts.closing)}</p>`);
  if (opts.signatureSpace !== false) parts.push('<div class="sig-space"></div>');
  parts.push('<div class="sig-line"></div>');
  parts.push(
    `<p class="sig-name" data-letter-part="signatory-name"><strong>${escapeHtml(signatory.name)}</strong><br>${escapeHtml(signatory.role)}${onBehalf ? `<br>${escapeHtml(onBehalf)}` : ''}</p>`
  );
  if (opts.signedAt) parts.push(`<p class="sig-date small">Signed electronically ${escapeHtml(formatDateTime(opts.signedAt))}</p>`);
  else if (date) parts.push(`<p class="sig-date">Date: ${escapeHtml(formatDateLong(date))}</p>`);
  parts.push('</div>');
  return parts.join('\n');
}

export type StatementOfTruthKind = 'claimant' | 'witness' | 'expert';

export interface StatementOfTruthOptions {
  kind: StatementOfTruthKind;
  /** Printed name of the person who will sign. The claimant signs their own documents (litigant in person). */
  signatoryName?: string;
  /** Noun for the document: "statement", "questionnaire", "schedule". Defaults by kind. */
  documentNoun?: string;
  /** Signature date, when already signed (e-sign). Otherwise the line is left blank for signing. */
  date?: ISODate | ISODateTime;
}

/**
 * Statement of truth in the CPR wording: PD 22 para 2.1 (statements of case, questionnaires, schedules),
 * PD 32 para 20.2 (witness statements), PD 35 para 3.3 (expert reports). CCGUK staff never sign these; the
 * claimant, witness or expert does.
 */
export function statementOfTruth(opts: StatementOfTruthOptions): string {
  const contempt =
    'I understand that proceedings for contempt of court may be brought against anyone who makes, or causes to be made, a false statement in a document verified by a statement of truth without an honest belief in its truth.';
  let text: string;
  switch (opts.kind) {
    case 'witness':
      text = `I believe that the facts stated in this ${escapeHtml(opts.documentNoun ?? 'witness statement')} are true. ${contempt}`;
      break;
    case 'expert':
      text = `I confirm that I have made clear which facts and matters referred to in this ${escapeHtml(
        opts.documentNoun ?? 'report'
      )} are within my own knowledge and which are not. Those that are within my own knowledge I confirm to be true. The opinions I have expressed represent my true and complete professional opinions on the matters to which they refer. ${contempt}`;
      break;
    default:
      text = `I believe that the facts stated in this ${escapeHtml(opts.documentNoun ?? 'document')} are true. ${contempt}`;
  }
  const fields = [
    { label: 'Signed', value: '' },
    { label: 'Full name', value: opts.signatoryName ?? '' },
    { label: 'Date', value: opts.date ? formatDateLong(opts.date) : '' }
  ];
  const grid = fields
    .map(
      (f) =>
        `<div class="sig-field">${f.value ? `<div class="field-line field-value">${escapeHtml(f.value)}</div>` : '<div class="field-line"></div>'}<div class="field-label">${escapeHtml(
          f.label
        )}</div></div>`
    )
    .join('');
  return `<section class="statement-of-truth"><h3>Statement of truth</h3><p>${text}</p><div class="sig-grid">${grid}</div></section>`;
}

/** BLUEPRINT §3.8: re-executed documents carry the actual signing date and the version they supersede. */
export function reExecutionLine(reExecutedOn: ISODate | ISODateTime, supersedesVersion: string | number): string {
  return `<p class="re-executed">Re-executed on ${escapeHtml(formatDateLong(reExecutedOn))}; supersedes version ${escapeHtml(String(supersedesVersion))}.</p>`;
}

export function pageBreak(): string {
  return '<div class="page-break"></div>';
}

// ---------------------------------------------------------------------------
// Playwright header / footer templates (rendered in the page margins on every page)
// ---------------------------------------------------------------------------

const hfFont = `font-family:${t.fontStack.replace(/"/g, "'")};`;

/** Running header, as the letterhead's continuation pages: "COURTESY CARS GROUP UK LTD | Our ref <ref>" left, "PAGE n OF N" right. */
export function headerTemplate(reference: string): string {
  return `<div style="width:100%;box-sizing:border-box;padding:6mm ${m.right}mm 0 ${m.left}mm;${hfFont}font-size:7.5pt;line-height:1.3;color:${c.silver};display:flex;justify-content:space-between;align-items:baseline;letter-spacing:.04em;">
  <span><span style="color:${c.navy};font-weight:700;">${escapeHtml(brand.company.registeredName.toUpperCase())}</span> | Our ref <span style="color:${c.navy};font-weight:600;">${escapeHtml(reference)}</span></span>
  <span>PAGE <span class="pageNumber"></span> OF <span class="totalPages"></span></span>
</div>`;
}

/** The letterhead contact line printed in every footer (plain text). */
export function footerContactLine(): string {
  return `${letterheadPhoneLine()} \u00b7 ${letterheadWebLine()}`;
}

/** Footer: status line, Part 6 trading disclosure and the letterhead contact line, centred, on every page. */
export function footerTemplate(
  statusLine: string = brand.company.statusLine,
  tradingDisclosure: string = brand.tradingDisclosure(''),
  contactLine: string = footerContactLine()
): string {
  return `<div style="width:100%;box-sizing:border-box;padding:0 ${m.right}mm 5mm ${m.left}mm;${hfFont}font-size:7pt;line-height:1.35;color:${c.silver};text-align:center;">
  <div style="text-wrap:balance;">${escapeHtml(statusLine)}</div>
  <div style="text-wrap:balance;">${escapeHtml(tradingDisclosure)}</div>${contactLine ? `\n  <div style="text-wrap:balance;">${escapeHtml(contactLine)}</div>` : ''}
</div>`;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Full HTML document. See LayoutOptions. */
export function baseLayout(opts: LayoutOptions): string {
  const isLetter = opts.kind === 'letter';
  const showCompany = opts.showCompanyBlock ?? opts.kind === 'invoice';
  const showTitle = opts.showTitle ?? !isLetter;
  const registeredOffice = effectiveRegisteredOffice(opts.settings);
  const tradingDisclosure = brand.tradingDisclosure(registeredOffice);
  const closing = opts.closing ?? (isLetter ? 'Yours faithfully' : '');

  const titleBlock = showTitle
    ? `<section class="doc-title"><h1>${escapeHtml(opts.title)}</h1>${opts.subtitle ? `<p class="subtitle">${escapeHtml(opts.subtitle)}</p>` : ''}</section>`
    : '';

  const signature = opts.signatory ? signatureBlock(opts.signatory, undefined, { closing: closing || undefined }) : '';
  const extras = `${enclosuresList(opts.enclosures ?? [])}${ccList(opts.cc ?? [])}`;
  const bodyHtml = isLetter ? markSalutation(opts.bodyHtml) : opts.bodyHtml;

  return `<!DOCTYPE html>
<html lang="${escapeHtml(opts.lang ?? 'en-GB')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} — ${escapeHtml(opts.reference)}</title>
<meta name="ccguk:kind" content="${escapeHtml(opts.kind)}">
<meta name="ccguk:reference" content="${escapeHtml(opts.reference)}">
<meta name="ccguk:date" content="${escapeHtml(opts.date)}">
<meta name="ccguk:registered-office" content="${escapeHtml(registeredOffice)}">
<style>${documentCss}${opts.extraCss ? `\n${opts.extraCss}` : ''}</style>
</head>
<body class="doc doc-${escapeHtml(opts.kind)}">
<div class="page${opts.landscape ? ' landscape' : ''}">
<header class="masthead">
  ${logoLockup()}
  <div class="masthead-right">${showCompany ? companyBlock(opts.settings) : contactStrip(opts.settings)}</div>
</header>
${partnerMarkSlot()}
${titleBlock}
${letterBlock({ reference: opts.reference, theirReference: opts.theirReference, date: opts.date, recipient: opts.recipient, meta: opts.meta })}
<main class="body" data-letter-part="body">
${bodyHtml}
</main>
${signature}${extras ? `\n${extras}` : ''}
<footer class="screen-footer screen-only">
  <div>${escapeHtml(brand.company.statusLine)}</div>
  <div>${escapeHtml(tradingDisclosure)}</div>
  <div>${escapeHtml(footerContactLine())}</div>
</footer>
</div>
</body>
</html>`;
}

/** Read the values baseLayout embeds as <meta> tags, so renderPdf can default its header/footer from the HTML. */
export function readDocumentMeta(html: string): { kind?: string; reference?: string; date?: string; registeredOffice?: string } {
  const get = (name: string): string | undefined => {
    const re = new RegExp(`<meta\\s+name="ccguk:${name}"\\s+content="([^"]*)"`, 'i');
    const mm = re.exec(html);
    return mm ? decodeEntities(mm[1] ?? '') : undefined;
  };
  return { kind: get('kind'), reference: get('reference'), date: get('date'), registeredOffice: get('registered-office') };
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
