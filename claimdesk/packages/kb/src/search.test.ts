import { describe, expect, it } from 'vitest';
import { loadAll, loadCases } from './load.js';
import { buildIndex, findByCitation, highlightsFor, search, stem, tokenise, unverifiedAmong, verificationOf, verificationStatus } from './search.js';

/** BLUEPRINT §5.1 — every case, by a distinctive citation fragment. */
const BLUEPRINT_5_1_CASES: Array<[name: string, neutral: string]> = [
  ['Giles v Thompson', '[1994] 1 AC 142'],
  ['Dimond v Lovell', '[2002] 1 AC 384'],
  ['Burdis v Livsey', '[2002] EWCA Civ 510'],
  ["Lagden v O'Connor", '[2003] UKHL 64'],
  ['Bee v Jenson', '[2007] EWCA Civ 923'],
  ['Copley v Lawn', '[2009] EWCA Civ 580'],
  ['Beechwood Birmingham', '[2010] EWCA Civ 647'],
  ['W v Veolia', '[2011] EWHC 2020 (QB)'],
  ['Pattni v First Leicester Buses', '[2011] EWCA Civ 1384'],
  ['Sayce v TNT', '[2011] EWCA Civ 1583'],
  ['Opoku v Tintas', '[2013] EWCA Civ 1299'],
  ['Coles v Hetherton', '[2013] EWCA Civ 1704'],
  ['Stevens v Equity Syndicate', '[2015] EWCA Civ 93'],
  ['McBride v UK Insurance', '[2017] EWCA Civ 144'],
  ['Irving v Morgan Sindall', '[2018] EWHC 1147 (QB)'],
  ['Hussain v EUI', '[2019] EWHC 2647 (QB)'],
  ['Irani v Duchon', '[2019] EWCA Civ 1846'],
  ['Diriye v Bojaj', '[2020] EWCA Civ 1400'],
  ['Mattocks v Mann', '[1993] RTR 13'],
  ['Darbishire v Warran', '[1963] 1 WLR 1067'],
  ['Umerji', '[2014] EWCA Civ 357'],
  ['Kindertons Ltd v Murtagh', '[2024] EWHC 471 (KB)'],
  ['Tescher v Direct Accident Management', '[2025] EWCA Civ 733'],
  ['Houston', '[2025] EWHC 3178 (KB)'],
];

describe('BLUEPRINT §5.1 coverage', () => {
  it.each(BLUEPRINT_5_1_CASES)('%s (%s) is present in cases.json', (name, neutral) => {
    const byName = findByCitation(name, loadCases());
    const byNeutral = findByCitation(neutral, loadCases());
    expect(byName.length, name).toBeGreaterThan(0);
    expect(byNeutral.length, neutral).toBeGreaterThan(0);
    expect(byName.some((e) => byNeutral.includes(e)), `${name} / ${neutral} resolve to the same entry`).toBe(true);
  });

  it('holds at least the 24 blueprint cases', () => {
    expect(loadCases().length).toBeGreaterThanOrEqual(24);
  });
});

describe('tokenise and stem', () => {
  it('collides inflections of the same word', () => {
    expect(stem('impecuniosity')).toBe(stem('impecunious'));
    expect(stem('mitigation')).toBe(stem('mitigate'));
    expect(stem('insurer')).toBe(stem('insurance'));
    expect(stem('enforceability')).toBe(stem('enforceable'));
  });

  it('drops stopwords and folds apostrophes', () => {
    expect(tokenise("Lagden v O'Connor [2003] UKHL 64")).toEqual(['lagden', 'oconnor', '2003', 'ukhl', '64']);
    expect(tokenise('the of and')).toEqual([]);
  });

  it('keeps paragraph and rule numbers whole and splits mixed section tokens', () => {
    expect(tokenise('GTA 6.8.6')).toEqual(['6.8.6', 'gta']);
    expect(tokenise('ICOBS 8.2.6R')).toEqual(expect.arrayContaining(['8.2.6r', '8.2.6', 'icob']));
    expect(tokenise('para 2.7(j)')).toContain('2.7');
    expect(tokenise('s172')).toEqual(['s172', '172']);
    expect(tokenise('s.172')).toEqual(['172']);
    expect(tokenise('reg28')).toEqual(['reg28', 'reg', '28']);
  });
});

describe('search', () => {
  it("search('impecuniosity') returns Lagden and Diriye in the top 5", () => {
    const top = search('impecuniosity', { limit: 5 }).map((h) => h.entry.id);
    expect(top).toHaveLength(5);
    expect(top).toContain('lagden-v-oconnor-2003');
    expect(top).toContain('diriye-v-bojaj-2020');
  });

  it('ranks by descending score with highlights', () => {
    const hits = search('basic hire rate mainstream supplier locality');
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    expect(hits.map((h) => h.entry.id)).toContain('stevens-v-equity-syndicate-2015');
    expect(hits[0]!.highlights.length).toBeGreaterThan(0);
    expect(hits[0]!.highlights[0]).toMatch(/^(citation|title|principle|text|tags): /);
  });

  it('finds the intervention cases for an offer query', () => {
    const top = search('intervention offer replacement vehicle', { limit: 5 }).map((h) => h.entry.id);
    expect(top).toContain('copley-v-lawn-2009');
    expect(top).toContain('sayce-v-tnt-2011');
  });

  it('filters by type and topic and honours limit', () => {
    const gtaOnly = search('payment pack', { types: ['gta'] });
    expect(gtaOnly.length).toBeGreaterThan(0);
    expect(gtaOnly.every((h) => h.entry.type === 'gta')).toBe(true);
    const interest = search('interest', { topics: ['interest'], limit: 3 });
    expect(interest.length).toBeLessThanOrEqual(3);
    expect(interest.every((h) => h.entry.topics.includes('interest'))).toBe(true);
    expect(search('impecuniosity').length).toBeLessThanOrEqual(10);
  });

  it('returns nothing for an empty or stopword-only query', () => {
    expect(search('')).toEqual([]);
    expect(search('the and of')).toEqual([]);
  });

  it('works over a custom index', () => {
    const idx = buildIndex(loadCases().slice(0, 3));
    expect(idx.docs).toHaveLength(3);
    expect(search('credit hire', {}, idx).every((h) => h.entry.type === 'case')).toBe(true);
  });

  it('highlightsFor surfaces the matched field', () => {
    const lagden = loadAll().find((e) => e.id === 'lagden-v-oconnor-2003')!;
    const hl = highlightsFor(lagden, tokenise('impecunious'));
    expect(hl.some((h) => h.startsWith('principle: ') && /impecunious/i.test(h))).toBe(true);
  });
});

describe('findByCitation', () => {
  it('matches citations and titles case- and apostrophe-insensitively', () => {
    expect(findByCitation("lagden v o'connor").map((e) => e.id)).toContain('lagden-v-oconnor-2003');
    expect(findByCitation('Lagden v O’Connor').map((e) => e.id)).toContain('lagden-v-oconnor-2003');
    expect(findByCitation('GTA para 6.7').map((e) => e.id)).toEqual(['gta-6-7']);
    expect(findByCitation('ICOBS 8.2.6R').map((e) => e.id)).toContain('fca-icobs-8-2-6r');
    expect(findByCitation('')).toEqual([]);
    expect(findByCitation('Nonexistent v Nobody')).toEqual([]);
  });
});

describe('verification helpers', () => {
  it('reports status for known ids and undefined for unknown ones', () => {
    expect(verificationStatus('lagden-v-oconnor-2003')).toBe('unverified');
    expect(verificationStatus('sayce-v-tnt-2011')).toBe('failed');
    expect(verificationStatus('no-such-entry')).toBeUndefined();
    expect(verificationOf('gta-6-7')?.sourceUrl).toMatch(/^https:\/\//);
  });

  it('unverifiedAmong lists everything not verified, including unknown ids, once', () => {
    expect(unverifiedAmong(['lagden-v-oconnor-2003', 'lagden-v-oconnor-2003', 'no-such-entry'])).toEqual(['lagden-v-oconnor-2003', 'no-such-entry']);
  });
});

/** Queries a handler actually types, with the entries that must be in the top 5. */
const HANDLER_QUERIES: Array<[query: string, mustContain: string[]]> = [
  ['insurer offered a courtesy car client refused', ['copley-v-lawn-2009', 'sayce-v-tnt-2011']],
  ['how long does the insurer have to pay the pack', ['gta-6-7', 'gta-6-8-6']],
  ['non party costs credit hire', ['tescher-v-daml-axa-v-spectra-2025', 'kindertons-v-murtagh-2024', 'cpr-44-16']],
  ['storage after engineer report', ['gta-6-3']],
  ['expert fee small claims', ['pd-27a-7-3', 'cpr-27-14']],
  ['cancellation rights hire agreement', ['ccr-2013-reg-29-30', 'ccr-2013-sch-3', 'w-v-veolia-2011']],
  ['pcn hire car transfer liability', ['owner-liability-regs-2000-sch-2', 'pofa-2012-sch-4-para-13-14']],
  ['s172 fleet cannot identify driver', ['rta-1988-s172', 'rtoa-1988-s1']],
  ['interest on late payment insurer', ['fca-icobs-8-2-9r-11r', 'gta-6-8-6', 'county-courts-act-1984-s69']],
  ['FOS third party', ['fos-eligibility', 'fca-disp-2-7-6r']],
];

describe('handler queries surface the right entries in the top 5', () => {
  it.each(HANDLER_QUERIES)('%s', (query, mustContain) => {
    const top5 = search(query, { limit: 5 }).map((h) => h.entry.id);
    expect(top5).toHaveLength(5);
    for (const id of mustContain) expect(top5, `${query} → ${top5.join(', ')}`).toContain(id);
  });

  it('the first hit is the obvious one', () => {
    expect(search('non party costs credit hire')[0]!.entry.id).toMatch(/kindertons|tescher/);
    expect(search('s172 fleet cannot identify driver')[0]!.entry.id).toBe('rta-1988-s172');
    expect(search('cancellation rights hire agreement')[0]!.entry.id).toMatch(/^ccr-2013/);
    expect(search('pcn hire car transfer liability')[0]!.entry.id).toBe('owner-liability-regs-2000-sch-2');
    expect(search('FOS third party')[0]!.entry.id).toBe('fos-eligibility');
    expect(search('how long does the insurer have to pay the pack')[0]!.entry.id).toBe('gta-6-7');
  });
});

/** Paragraph / rule-number lookups: the exact paragraph must be the first hit. */
const PARAGRAPH_QUERIES: Array<[query: string, top: string]> = [
  ['GTA 6.8.6', 'gta-6-8-6'],
  ['GTA 4.14', 'gta-4-14'],
  ['GTA para 6.7', 'gta-6-7'],
  ['para 2.7(j)', 'gta-2-7-j'],
  ['ICOBS 8.2.6R', 'fca-icobs-8-2-6r'],
  ['DISP 2.7.6R', 'fca-disp-2-7-6r'],
  ['CPR 27.14', 'cpr-27-14'],
  ['PD 27A 7.3', 'pd-27a-7-3'],
  ['reg 28(1)(h)', 'ccr-2013-reg-28-1-h'],
  ['s.172', 'rta-1988-s172'],
  ['art 60F', 'rao-2001-art-60f'],
];

describe('paragraph-number lookups', () => {
  it.each(PARAGRAPH_QUERIES)('%s → %s', (query, top) => {
    expect(search(query, { limit: 3 }).map((h) => h.entry.id)[0]).toBe(top);
  });

  it('topic filters now carry the retagged statutes', () => {
    expect(search('penalty charge notice', { topics: ['pcn'] }).map((h) => h.entry.id)).toContain('tma-2004-part-6');
    expect(search('driver identity', { topics: ['nip'] }).map((h) => h.entry.id)[0]).toBe('rta-1988-s172');
    expect(search('subject access', { topics: ['dsar'] }).map((h) => h.entry.id)[0]).toBe('uk-gdpr-art-15');
    expect(search('credit hire', { topics: ['dsar'] }).every((h) => h.entry.topics.includes('dsar'))).toBe(true);
  });
});
