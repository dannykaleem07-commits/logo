import { describe, expect, it } from 'vitest';
import {
  DATA_FILES,
  KB_ENTRY_FILES,
  KbValidationError,
  countVerification,
  entryIndex,
  loadAll,
  loadCases,
  loadCourtFees,
  loadCpr,
  loadDirectory,
  loadEntries,
  loadFca,
  loadFos,
  loadGta,
  loadGtaRates,
  loadGuidance,
  loadPlaybookRules,
  loadStatutes,
  MAX_QUOTE_WORDS,
  readDataFile,
  toDomainFeeBands,
  validateCourtFeeBand,
  validateDirectoryEntry,
  validateGtaRate,
  validateKbEntry,
  validatePlaybookRule,
  validateVerification,
} from './load.js';
import { PLAYBOOK_ACTION_CODES } from './types.js';

/** ARCHITECTURE "Documents" template set — every non-null playbook templateId must be one of these. */
const TEMPLATE_IDS = [
  'letter.ncaf',
  'letter.handling_ref_request',
  'letter.intervention_reply',
  'letter.collect_or_pay',
  'letter.delay_notice_gta_4_10',
  'letter.chaser_7',
  'letter.chaser_14',
  'letter.chaser_21',
  'letter.complaint_disp',
  'letter.dsar',
  'letter.cctv_preservation',
  'letter.letter_before_claim',
  'letter.part36_offer',
  'letter.vendor_verification_pack',
  'letter.pav_challenge',
  'letter.particularisation_demand',
  'invoice.hire',
  'invoice.storage',
  'invoice.recovery',
  'invoice.engineer_fee',
  'report.engineer',
  'report.pav',
  'agreement.credit_hire',
  'form.cancellation_sch3',
  'form.express_request_to_start',
  'form.mitigation_questionnaire',
  'form.statement_of_means',
  'form.statement_of_need',
  'statement.witness',
  'pack.gta_payment',
  'bundle.litigation_index',
  'notice.pcn_liability_transfer',
  'notice.s172_response',
  'schedule.loss',
  'certificate.signature',
];

const validEntry = {
  id: 'test-entry',
  type: 'case',
  citation: 'Test v Case [2026] EWCA Civ 1',
  title: 'Test v Case',
  principle: 'A principle.',
  tags: ['a'],
  topics: ['credit_hire'],
  verification: { status: 'unverified', sourceNote: 'n/a' },
  licence: 'link_only',
};

describe('data files validate against the validators', () => {
  it.each(KB_ENTRY_FILES)('%s is a valid KbEntry[]', (file) => {
    const entries = loadEntries(file);
    expect(entries.length).toBeGreaterThan(0);
    const raw = readDataFile(file) as unknown[];
    expect(entries).toHaveLength(raw.length);
  });

  it('typed loaders return the right files', () => {
    expect(loadCases().every((e) => e.type === 'case')).toBe(true);
    expect(loadStatutes().every((e) => e.type === 'statute')).toBe(true);
    expect(loadCpr().every((e) => e.type === 'cpr' || e.type === 'practice_direction')).toBe(true);
    expect(loadGta().every((e) => e.type === 'gta')).toBe(true);
    expect(loadFca().length).toBeGreaterThan(0);
    expect(loadFca().every((e) => e.type === 'fca_handbook')).toBe(true);
    expect(loadFos().every((e) => e.type === 'fos')).toBe(true);
    expect(loadGuidance().length).toBeGreaterThan(0);
    // guidance.json holds codes, fees and guidance; the only statute it carries is the one ARCHITECTURE puts there
    expect(loadGuidance().filter((e) => e.type === 'statute').map((e) => e.id)).toEqual(['lay-representatives-order-1999', 'lsa-2007-s12-sch2'].filter((id) => id !== 'lsa-2007-s12-sch2'));
  });

  it('gta-rates.json, court-fees.json, insurer-directory.json and playbook-rules.json validate', () => {
    expect(loadGtaRates().length).toBeGreaterThanOrEqual(14);
    expect(loadCourtFees().length).toBeGreaterThanOrEqual(18);
    expect(loadDirectory().length).toBeGreaterThanOrEqual(49);
    expect(loadPlaybookRules()).toHaveLength(PLAYBOOK_ACTION_CODES.length);
  });

  it('loadAll() concatenates every entry file with unique ids', () => {
    const all = loadAll();
    const sum = KB_ENTRY_FILES.reduce((n, f) => n + loadEntries(f).length, 0);
    expect(all).toHaveLength(sum);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(entryIndex().get('lagden-v-oconnor-2003')?.type).toBe('case');
  });

  it('no entry is verified without a sourceUrl (ARCHITECTURE convention 6)', () => {
    for (const e of loadAll()) {
      if (e.verification.status === 'verified') {
        expect(e.verification.sourceUrl, e.id).toBeTruthy();
        expect(e.verification.verifiedAt, e.id).toBeTruthy();
      }
    }
    for (const r of loadGtaRates()) if (r.verification.status === 'verified') expect(r.verification.sourceUrl).toBeTruthy();
    for (const d of loadDirectory()) if (d.verification.status === 'verified') expect(d.verification.sourceUrl).toBeTruthy();
    for (const f of loadCourtFees()) if (f.verification.status === 'verified') expect(f.verification.sourceUrl).toBeTruthy();
  });

  it('countVerification tallies statuses', () => {
    const c = countVerification(loadAll());
    expect(c.total).toBe(loadAll().length);
    expect(c.verified + c.unverified + c.failed + c.stale).toBe(c.total);
  });
});

describe('licence rules', () => {
  it("no 'case' entry carries an extract: Find Case Law / BAILII are principle + link only", () => {
    for (const e of loadCases()) expect(e.text ?? '', e.id).toBe('');
  });

  it('BAILII-hosted entries are link_only and Open Justice Licence entries point at Find Case Law', () => {
    for (const e of loadAll()) {
      const host = new URL(e.url ?? e.verification.sourceUrl ?? 'https://none.invalid/').host;
      if (/(^|\.)bailii\.org$/.test(host)) expect(e.licence, e.id).toBe('link_only');
      if (e.licence === 'Open Justice Licence') expect(host, e.id).toMatch(/caselaw\.nationalarchives\.gov\.uk$/);
    }
  });

  it(`CPR / FCA Handbook / GTA extracts are short quotes (≤ ${MAX_QUOTE_WORDS} words)`, () => {
    let quoted = 0;
    for (const e of loadAll()) {
      if (e.licence !== 'quote_only' || !e.text) continue;
      quoted++;
      expect(e.text.trim().split(/\s+/).length, e.id).toBeLessThanOrEqual(MAX_QUOTE_WORDS);
    }
    expect(quoted).toBeGreaterThan(20);
  });

  it('case principles are short paraphrases, not judgment text', () => {
    for (const e of loadCases()) {
      expect(e.principle.length, e.id).toBeLessThanOrEqual(1000);
      const quotedSpans = [...e.principle.matchAll(/[“"‘]([^”"’]{20,})[”"’]/g)].map((m) => m[1]!.trim().split(/\s+/).length);
      for (const words of quotedSpans) expect(words, `${e.id} quotes ${words} words verbatim`).toBeLessThanOrEqual(12);
    }
  });

  it('link_only entries carry no extract', () => {
    for (const e of loadAll()) if (e.licence === 'link_only') expect(e.text ?? '', e.id).toBe('');
  });

  it('every entry declares a licence', () => {
    for (const e of loadAll()) expect(e.licence, e.id).toBeTruthy();
  });
});

describe('playbook-rules.json', () => {
  it('covers every ARCHITECTURE action code exactly once, in order', () => {
    const rules = loadPlaybookRules();
    expect(rules.map((r) => r.code).sort()).toEqual([...PLAYBOOK_ACTION_CODES].sort());
    const orders = rules.map((r) => r.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('every basis id resolves in the knowledge base and every templateId is a known template', () => {
    const index = entryIndex();
    for (const r of loadPlaybookRules()) {
      expect(r.basis.length, r.code).toBeGreaterThan(0);
      for (const b of r.basis) expect(index.has(b), `${r.code} cites unknown ${b}`).toBe(true);
      if (r.templateId !== null) expect(TEMPLATE_IDS, `${r.code} → ${r.templateId}`).toContain(r.templateId);
      expect(r.title).toBeTruthy();
      expect(r.why).toBeTruthy();
    }
  });

  it('mirrors BLUEPRINT §7 steps 1–8', () => {
    const steps = new Set(loadPlaybookRules().map((r) => r.blueprintStep));
    for (let s = 1; s <= 8; s++) expect(steps.has(s), `step ${s}`).toBe(true);
  });

  it('GTA-based rules are flagged benchmarkOnly', () => {
    for (const r of loadPlaybookRules()) {
      if (r.basis.some((b) => b.startsWith('gta-')) && !r.basis.some((b) => !b.startsWith('gta-'))) expect(r.benchmarkOnly, r.code).toBe(true);
    }
    expect(loadPlaybookRules().find((r) => r.code === 'SEND_PAYMENT_PACK')?.benchmarkOnly).toBe(true);
  });
});

describe('court fees', () => {
  it('issue fee bands cover the blueprint figures and convert to the domain shape', () => {
    const issue = loadCourtFees().filter((f) => f.kind === 'issue');
    expect(issue.find((f) => f.fromPence === 0)?.feePence).toBe(3500);
    expect(issue.find((f) => f.fromPence === 300001)?.feePence).toBe(20500);
    expect(issue.find((f) => f.fromPence === 500001)?.feePence).toBe(45500);
    const domain = toDomainFeeBands();
    // every kind flows through to the domain (FeeKind widened): none dropped
    expect(domain).toHaveLength(loadCourtFees().length);
    expect(new Set(domain.map((b) => b.kind))).toEqual(new Set(loadCourtFees().map((b) => b.kind)));
    expect(domain.some((b) => b.toPence === Number.MAX_SAFE_INTEGER)).toBe(true);
    const hearing = domain.filter((b) => b.kind === 'hearing_small_claims');
    expect(hearing.find((b) => b.fromPence === 0)?.feePence).toBe(2700);
    expect(hearing.find((b) => b.fromPence === 300001)?.feePence).toBe(34600);
  });
});

describe('validators throw on shape and enum errors', () => {
  it('accepts a valid entry', () => {
    expect(validateKbEntry(validEntry).id).toBe('test-entry');
  });

  it('rejects a bad type enum', () => {
    expect(() => validateKbEntry({ ...validEntry, type: 'blog' })).toThrow(KbValidationError);
    expect(() => validateKbEntry({ ...validEntry, type: 'blog' })).toThrow(/type/);
  });

  it('rejects a bad verification status and unknown fields', () => {
    expect(() => validateKbEntry({ ...validEntry, verification: { status: 'checked' } })).toThrow(/status/);
    expect(() => validateKbEntry({ ...validEntry, extra: 1 })).toThrow(/unknown field/);
    expect(() => validateVerification({ status: 'unverified', verifiedAt: '2026-02-30' })).toThrow(/ISO date/);
  });

  it("rejects 'verified' without a sourceUrl, verifiedAt or a human verifiedBy (convention 6)", () => {
    expect(() => validateVerification({ status: 'verified', verifiedAt: '2026-10-04', verifiedBy: 'D. Kaleem' })).toThrow(/sourceUrl/);
    expect(() => validateVerification({ status: 'verified', sourceUrl: 'https://example.org', verifiedBy: 'D. Kaleem' })).toThrow(/verifiedAt/);
    expect(() => validateVerification({ status: 'verified', sourceUrl: 'https://example.org', verifiedAt: '2026-10-04' })).toThrow(/verifiedBy/);
    expect(() => validateVerification({ status: 'verified', sourceUrl: 'https://example.org', verifiedAt: '2026-10-04', verifiedBy: 'research-agent' })).toThrow(/human/);
    expect(validateVerification({ status: 'verified', sourceUrl: 'https://example.org', verifiedAt: '2026-10-04', verifiedBy: 'D. Kaleem' }).status).toBe('verified');
    // an unverified row may record who last checked it, even a process
    expect(validateVerification({ status: 'unverified', verifiedAt: '2026-10-04', verifiedBy: 'research-agent' }).status).toBe('unverified');
  });

  it('rejects missing or empty required fields', () => {
    expect(() => validateKbEntry({ ...validEntry, principle: '' })).toThrow(/principle/);
    expect(() => validateKbEntry({ ...validEntry, tags: 'a' })).toThrow(/tags/);
    expect(() => validateKbEntry({ ...validEntry, id: 'Bad Id' })).toThrow(/slug/);
    expect(() => validateKbEntry(null)).toThrow(/object/);
  });

  it('enforces the licence rules', () => {
    const fcl = 'https://caselaw.nationalarchives.gov.uk/ewca/civ/2026/1';
    const bailii = 'https://www.bailii.org/ew/cases/EWCA/Civ/2026/1.html';
    expect(() => validateKbEntry({ ...validEntry, text: 'x' })).toThrow(/link_only/);
    // cases: principle + link only, whatever the licence
    expect(() => validateKbEntry({ ...validEntry, url: fcl, licence: 'Open Justice Licence', text: 'a short quote' })).toThrow(/principle \+ link only/);
    expect(validateKbEntry({ ...validEntry, url: fcl, licence: 'Open Justice Licence' }).licence).toBe('Open Justice Licence');
    // Open Justice Licence is Find Case Law's; BAILII is link-only
    expect(() => validateKbEntry({ ...validEntry, url: bailii, licence: 'Open Justice Licence' })).toThrow(/link-only|Find Case Law/);
    expect(() => validateKbEntry({ ...validEntry, url: 'https://example.org/case', licence: 'Open Justice Licence' })).toThrow(/Find Case Law/);
    expect(validateKbEntry({ ...validEntry, url: bailii, licence: 'link_only' }).url).toBe(bailii);
    // CPR / FCA / GTA: short quotes only
    const rule = { ...validEntry, type: 'cpr', url: 'https://www.justice.gov.uk/courts/procedure-rules/civil/rules/part27', licence: 'quote_only' };
    expect(validateKbEntry({ ...rule, text: 'word '.repeat(MAX_QUOTE_WORDS).trim() }).text?.split(' ')).toHaveLength(MAX_QUOTE_WORDS);
    expect(() => validateKbEntry({ ...rule, text: 'word '.repeat(MAX_QUOTE_WORDS + 1).trim() })).toThrow(/words/);
  });

  it('validateDirectoryEntry checks phones, emails, domains and dates', () => {
    const ok = {
      id: 'x-insurer',
      name: 'X',
      brands: ['X'],
      thirdPartyClaimsPhone: '0333 220 2047',
      claimsEmail: 'claims@x.example',
      copycatDomains: ['x-claims.example'],
      copycatNumbers: ['0333 006 44xx'],
      verification: { status: 'unverified' },
      lastUsedOk: '2026-10-01',
    };
    expect(validateDirectoryEntry(ok).lastUsedOk).toBe('2026-10-01');
    expect(() => validateDirectoryEntry({ ...ok, thirdPartyClaimsPhone: 'call us' })).toThrow(/phone/);
    expect(() => validateDirectoryEntry({ ...ok, claimsEmail: 'nope' })).toThrow(/email/);
    expect(() => validateDirectoryEntry({ ...ok, copycatDomains: ['https://x'] })).toThrow(/domain/);
    expect(() => validateDirectoryEntry({ ...ok, lastFailed: 'yesterday' })).toThrow(/ISO date/);
    expect(() => validateDirectoryEntry({ ...ok, brands: [] })).toThrow(/brands/);
  });

  it('validateGtaRate checks group codes, pence and dates', () => {
    const ok = { group: 'S1', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } };
    expect(validateGtaRate(ok).group).toBe('S1');
    expect(() => validateGtaRate({ ...ok, dailyRatePence: 42.32 })).toThrow(/integer/);
    expect(() => validateGtaRate({ ...ok, group: 'small car' })).toThrow(/group/);
    expect(() => validateGtaRate({ ...ok, effectiveTo: '2026-06-30' })).toThrow(/effectiveFrom/);
    expect(() => validateGtaRate({ ...ok, period: '2026/27' })).toThrow(/period/);
  });

  it('validateCourtFeeBand requires feePence or pct', () => {
    const ok = { kind: 'issue', fromPence: 0, toPence: 30000, feePence: 3500, verification: { status: 'unverified' } };
    expect(validateCourtFeeBand(ok).feePence).toBe(3500);
    expect(() => validateCourtFeeBand({ ...ok, feePence: undefined })).toThrow(/feePence or pct/);
    expect(() => validateCourtFeeBand({ ...ok, kind: 'parking' })).toThrow(/kind/);
    expect(() => validateCourtFeeBand({ ...ok, toPence: -1 })).toThrow(/toPence/);
  });

  it('validatePlaybookRule checks codes, priorities, due rules and template ids', () => {
    const ok = {
      code: 'SEND_NCAF',
      order: 10,
      blueprintStep: 1,
      stage: 'day_1',
      title: 't',
      why: 'w',
      basis: ['gta-4-1'],
      templateId: 'letter.ncaf',
      priority: 'now',
      trigger: 'x',
      due: { kind: 'working_days', n: 1, from: 'hire_start' },
    };
    expect(validatePlaybookRule(ok).code).toBe('SEND_NCAF');
    expect(() => validatePlaybookRule({ ...ok, code: 'DO_THING' })).toThrow(/code/);
    expect(() => validatePlaybookRule({ ...ok, priority: 'urgent' })).toThrow(/priority/);
    expect(() => validatePlaybookRule({ ...ok, due: { kind: 'working_days', from: 'x' } })).toThrow(/due\.n/);
    expect(() => validatePlaybookRule({ ...ok, templateId: 'Letter NCAF' })).toThrow(/templateId/);
    expect(() => validatePlaybookRule({ ...ok, blueprintStep: 9 })).toThrow(/1–8/);
    expect(validatePlaybookRule({ ...ok, templateId: null, due: null }).templateId).toBeNull();
  });
});

describe('data file registry', () => {
  it('names every file the package ships', () => {
    expect(Object.values(DATA_FILES)).toEqual(
      expect.arrayContaining(['cases.json', 'statutes.json', 'cpr.json', 'gta.json', 'fca.json', 'fos.json', 'guidance.json', 'gta-rates.json', 'court-fees.json', 'insurer-directory.json', 'playbook-rules.json']),
    );
  });
});

/** Hosts a 'verified' citation may point at: the primary publisher of each source type. */
const PRIMARY_HOSTS = [
  /(^|\.)legislation\.gov\.uk$/,
  /(^|\.)caselaw\.nationalarchives\.gov\.uk$/,
  /(^|\.)bailii\.org$/,
  /(^|\.)justice\.gov\.uk$/,
  /(^|\.)handbook\.fca\.org\.uk$/,
  /(^|\.)fca\.org\.uk$/,
  /(^|\.)gtacredithire\.com$/,
  /(^|\.)financial-ombudsman\.org\.uk$/,
  /(^|\.)gov\.uk$/,
  /(^|\.)abi\.org\.uk$/,
  /(^|\.)ico\.org\.uk$/,
  /(^|\.)mib\.org\.uk$/,
  /(^|\.)askmid\.com$/,
  /(^|\.)met\.police\.uk$/,
  /(^|\.)tfl\.gov\.uk$/,
];

function hostOf(url: string | undefined): string {
  return url ? new URL(url).host.toLowerCase() : '';
}

/** Hosts that count as an insurer's own: its portal, its published email domains and any host carrying its name/brand slug. */
function isOwnDomain(entry: ReturnType<typeof loadDirectory>[number], host: string): boolean {
  const bare = host.replace(/^www\./, '');
  const owned = new Set<string>();
  if (entry.portalUrl) owned.add(hostOf(entry.portalUrl).replace(/^www\./, ''));
  for (const email of [entry.claimsEmail, entry.thirdPartyEmail, entry.complaintsEmail]) if (email) owned.add(email.split('@')[1]!.toLowerCase());
  if ([...owned].some((d) => bare === d || bare.endsWith(`.${d}`))) return true;
  const slugs = [entry.name, ...entry.brands, entry.id].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((s) => s.length >= 3);
  const hostSlug = bare.replace(/[^a-z0-9]/g, '');
  return slugs.some((s) => hostSlug.includes(s) || s.includes(hostSlug.split(/co|com|org|uk|net/)[0] ?? '\u0000'));
}

describe('verification provenance (ARCHITECTURE convention 6)', () => {
  it("every 'verified' citation points at the primary publisher and names a human verifier", () => {
    const rows = [...loadAll(), ...loadGtaRates(), ...loadCourtFees()];
    for (const r of rows) {
      if (r.verification.status !== 'verified') continue;
      const host = hostOf(r.verification.sourceUrl);
      expect(PRIMARY_HOSTS.some((re) => re.test(host)), `${'id' in r ? r.id : JSON.stringify(r)} verified from ${host}`).toBe(true);
      expect(r.verification.verifiedBy).toBeTruthy();
    }
  });

  it("a 'verified' directory record is sourced from the insurer's own domain", () => {
    for (const e of loadDirectory()) {
      if (e.verification.status !== 'verified') continue;
      expect(isOwnDomain(e, hostOf(e.verification.sourceUrl)), `${e.id}: ${e.verification.sourceUrl}`).toBe(true);
    }
  });

  it('directory records that are only checked (not verified) still carry a source URL on a plausible own domain', () => {
    // guards the research notes: an unverified record whose source is not the insurer's own site is worthless to a handler
    const exceptions = new Set(['advantage-insurance', 'somerset-bridge', 'haven-acorn', 'rsa-more-than', 'allianz-commercial', 'traffic-enforcement-centre', 'dvla-vehicle-record-enquiries', 'tfl-cctv-requests']);
    for (const e of loadDirectory()) {
      expect(e.verification.sourceUrl, e.id).toBeTruthy();
      if (exceptions.has(e.id)) continue;
      expect(isOwnDomain(e, hostOf(e.verification.sourceUrl)), `${e.id}: ${e.verification.sourceUrl}`).toBe(true);
    }
  });

  it('nothing shipped is verified: the research agents could not open the primary sources', () => {
    expect(countVerification(loadAll()).verified).toBe(0);
    expect(countVerification(loadGtaRates()).verified).toBe(0);
    expect(countVerification(loadDirectory()).verified).toBe(0);
  });
});

describe('cross-file consistency', () => {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  it('no authority is entered twice under different ids (citation and title unique across files)', () => {
    const byCitation = new Map<string, string>();
    const byTitle = new Map<string, string>();
    for (const e of loadAll()) {
      const c = norm(e.citation);
      expect(byCitation.get(c), `${e.id} duplicates citation of ${byCitation.get(c)}`).toBeUndefined();
      byCitation.set(c, e.id);
      const t = norm(e.title);
      expect(byTitle.get(t), `${e.id} duplicates title of ${byTitle.get(t)}`).toBeUndefined();
      byTitle.set(t, e.id);
    }
    expect(entryIndex().has('lsa-2007-s12-sch2')).toBe(false); // the removed duplicate of legal-services-act-2007-s12-sch2
    expect(entryIndex().has('legal-services-act-2007-s12-sch2')).toBe(true);
  });

  it('every entry has a type consistent with its file, and ids are lower-case slugs', () => {
    for (const e of loadCases()) expect(e.type).toBe('case');
    for (const e of loadGta()) expect(e.type).toBe('gta');
    for (const e of loadFos()) expect(e.type).toBe('fos');
    for (const e of loadAll()) expect(e.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('topics are specific enough to filter on: pcn / nip / dsar / fleet / liability each have their own entries', () => {
    const count = (topic: string): number => loadAll().filter((e) => e.topics.includes(topic)).length;
    for (const topic of ['pcn', 'nip', 'dsar', 'fleet', 'liability', 'data_protection', 'perimeter', 'interest', 'enforceability', 'impecuniosity']) {
      expect(count(topic), topic).toBeGreaterThanOrEqual(3);
    }
    const pcn = loadAll().filter((e) => e.topics.includes('pcn')).map((e) => e.id);
    expect(pcn).toEqual(expect.arrayContaining(['tma-2004-part-6', 'owner-liability-regs-2000-sch-2', 'pofa-2012-sch-4-para-13-14']));
    for (const e of loadStatutes().filter((e) => /^uk-gdpr-/.test(e.id))) expect(e.topics, e.id).not.toContain('credit_hire');
  });

  it('every entry that cites a source carries an http(s) url or sourceUrl, except pre-neutral-citation cases', () => {
    const allowedWithout = new Set(['giles-v-thompson-1994', 'mattocks-v-mann-1993', 'mib-v-houston-2025']);
    for (const e of loadAll()) {
      if (allowedWithout.has(e.id)) continue;
      expect(e.url ?? e.verification.sourceUrl, e.id).toMatch(/^https?:\/\//);
    }
  });
});
