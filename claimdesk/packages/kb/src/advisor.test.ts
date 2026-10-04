import { describe, expect, it } from 'vitest';
import {
  ADVICE_TOPICS,
  BENCHMARK_FIGURES_CAVEAT,
  BLUEPRINT_STEP_TITLES,
  COURT_FEES_CAVEAT,
  FORUM_NOT_OPEN,
  GTA_4_14_CAVEAT,
  GTA_BENCHMARK,
  ICOBS_SCOPE_CAVEAT,
  INJURY_PERIMETER,
  MEDIATION_CAVEAT,
  RESERVED_ACTIVITY,
  advise,
  citedEntries,
  getPaidFasterPlan,
} from './advisor.js';
import { entryIndex, loadPlaybookRules } from './load.js';
import { PLAYBOOK_ACTION_CODES } from './types.js';

describe('advise()', () => {
  it("advise('mitigation') cites Copley v Lawn and Opoku v Tintas", () => {
    const a = advise('mitigation');
    const cited = a.points.flatMap((p) => p.citations);
    expect(cited).toContain('copley-v-lawn-2009');
    expect(cited).toContain('opoku-v-tintas-2013');
    expect(a.topic).toBe('mitigation');
    expect(a.summary.length).toBeGreaterThan(20);
  });

  it.each([...ADVICE_TOPICS])('%s: every point cites at least one existing entry', (topic) => {
    const a = advise(topic);
    const index = entryIndex();
    expect(a.points.length).toBeGreaterThanOrEqual(3);
    for (const p of a.points) {
      expect(p.text.length).toBeGreaterThan(30);
      expect(p.citations.length).toBeGreaterThan(0);
      for (const c of p.citations) expect(index.has(c), `${topic} cites unknown ${c}`).toBe(true);
    }
    expect(a.caveats.length).toBeGreaterThan(0);
  });

  it('flags every cited entry whose verification is not verified', () => {
    const index = entryIndex();
    for (const topic of ADVICE_TOPICS) {
      const a = advise(topic);
      const cited = [...new Set(a.points.flatMap((p) => p.citations))];
      const expected = cited.filter((id) => index.get(id)?.verification.status !== 'verified');
      expect(a.unverifiedCitations.sort()).toEqual(expected.sort());
    }
  });

  it('includes the forum and perimeter checks where the forum is not open or the activity is reserved', () => {
    expect(advise('complaint').forumChecks).toContain(FORUM_NOT_OPEN);
    expect(advise('pav').forumChecks).toContain(FORUM_NOT_OPEN);
    expect(advise('litigation').forumChecks).toContain(RESERVED_ACTIVITY);
    expect(advise('litigation').forumChecks).toContain(INJURY_PERIMETER);
    expect(advise('payment_pack').forumChecks).toContain(GTA_BENCHMARK);
    expect(advise('bhr').forumChecks).toContain(GTA_BENCHMARK);
  });

  it('never names the FOS as a forum for a third-party claimant against the at-fault insurer', () => {
    const a = advise('complaint');
    const text = a.points.map((p) => p.text).join(' ');
    expect(text).toMatch(/not open|cannot|no .*relationship/i);
    expect(a.points.some((p) => p.citations.includes('fca-disp-2-7-6r'))).toBe(true);
  });

  it('impecuniosity advice carries the burden stance and the sign-up evidence', () => {
    const a = advise('impecuniosity');
    const text = a.points.map((p) => p.text).join(' ');
    expect(text).toMatch(/burden/i);
    expect(text).toMatch(/statement of means/i);
    expect(a.points.flatMap((p) => p.citations)).toEqual(expect.arrayContaining(['lagden-v-oconnor-2003', 'diriye-v-bojaj-2020']));
  });

  it('normalises topic spelling', () => {
    expect(advise('Total Loss').topic).toBe('total_loss');
    expect(advise('costs-exposure').points.flatMap((p) => p.citations)).toContain('tescher-v-daml-axa-v-spectra-2025');
  });

  it('falls back to search-assembled points for an unknown topic', () => {
    const a = advise('champerty');
    expect(a.summary).toMatch(/No curated playbook/);
    expect(a.points.length).toBeGreaterThan(0);
    expect(a.points[0]!.citations).toEqual(['giles-v-thompson-1994']);
    expect(a.unverifiedCitations).toContain('giles-v-thompson-1994');
    const none = advise('zzzz-qqqq');
    expect(none.points).toEqual([]);
  });

  it('citedEntries returns the cited entries in first-citation order without duplicates', () => {
    const a = advise('mitigation');
    const entries = citedEntries(a);
    expect(entries[0]!.id).toBe(a.points[0]!.citations[0]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});

describe('getPaidFasterPlan()', () => {
  it('returns every playbook rule as an ordered step with citations and template', () => {
    const plan = getPaidFasterPlan();
    expect(plan).toHaveLength(PLAYBOOK_ACTION_CODES.length);
    expect(plan.map((s) => s.step)).toEqual(plan.map((_, i) => i + 1));
    expect(plan[0]!.code).toBe('SEND_NCAF');
    expect(plan[0]!.templateId).toBe('letter.ncaf');
    expect(plan[0]!.timing).toBe('within 1 working day of hire start');
    const index = entryIndex();
    for (const s of plan) {
      expect(s.citations.length).toBeGreaterThan(0);
      for (const c of s.citations) expect(index.has(c), `${s.code} cites ${c}`).toBe(true);
      expect(s.unverifiedCitations).toEqual(s.citations.filter((c) => index.get(c)?.verification.status !== 'verified'));
      expect(BLUEPRINT_STEP_TITLES[s.blueprintStep]).toBeTruthy();
    }
  });

  it('mirrors BLUEPRINT §7: NCAF → CCTV → pack → split heads → chasers → complaint → litigation → vendor pack', () => {
    const codes = getPaidFasterPlan().map((s) => s.code);
    const pos = (c: string): number => codes.indexOf(c as (typeof codes)[number]);
    expect(pos('SEND_NCAF')).toBeLessThan(pos('REQUEST_CCTV'));
    expect(pos('REQUEST_CCTV')).toBeLessThan(pos('SEND_PAYMENT_PACK'));
    expect(pos('SEND_PAYMENT_PACK')).toBeLessThan(pos('SPLIT_HEADS_INTERIM'));
    expect(pos('CHASER_7')).toBeLessThan(pos('CHASER_14'));
    expect(pos('CHASER_14')).toBeLessThan(pos('CHASER_21'));
    expect(pos('CHASER_21')).toBeLessThan(pos('COMPLAINT_28'));
    expect(pos('COMPLAINT_28')).toBeLessThan(pos('LETTER_BEFORE_CLAIM'));
    expect(pos('LETTER_BEFORE_CLAIM')).toBeLessThan(pos('PART36_OFFER'));
    expect(pos('PART36_OFFER')).toBeLessThan(pos('DEFAULT_JUDGMENT'));
  });

  it('describes timings from the due rule', () => {
    const byCode = new Map(getPaidFasterPlan().map((s) => [s.code, s]));
    expect(byCode.get('CHASER_7')!.timing).toBe('day 7 after payment pack sent');
    expect(byCode.get('END_HIRE_NOW')!.timing).toBe('immediately on off hire trigger');
    expect(byCode.get('ICOBS_INTEREST_CLAIM')!.timing).toBe('3 calendar months after claim quantified');
    expect(byCode.get('PART36_OFFER')!.timing).toBe('on claim issued');
    expect(byCode.get('DEFAULT_JUDGMENT')!.templateId).toBeNull();
    expect(byCode.get('REFER_INJURY')!.templateId).toBeNull();
    expect(byCode.get('SEND_PAYMENT_PACK')!.benchmarkOnly).toBe(true);
  });

  it('accepts an injected rule set', () => {
    const rules = loadPlaybookRules().filter((r) => r.code.startsWith('CHASER'));
    const plan = getPaidFasterPlan(rules);
    expect(plan.map((s) => s.code)).toEqual(['CHASER_7', 'CHASER_14', 'CHASER_21']);
  });
});

describe('stance: GTA is a benchmark, the FOS is not open, and "verify" items carry caveats', () => {
  it('every topic that cites a GTA paragraph carries the GTA_CITED_AS_LAW forum check', () => {
    for (const topic of ADVICE_TOPICS) {
      const a = advise(topic);
      const citesGta = a.points.some((p) => p.citations.some((c) => c.startsWith('gta-')));
      if (citesGta) expect(a.forumChecks, topic).toContain(GTA_BENCHMARK);
    }
    expect(advise('need').forumChecks).toContain(GTA_BENCHMARK); // cites gta-6-2
  });

  it('never states a GTA term as a legal entitlement: every GTA-citing point says "benchmark"', () => {
    for (const topic of ADVICE_TOPICS) {
      for (const p of advise(topic).points) {
        if (!p.citations.some((c) => c.startsWith('gta-'))) continue;
        expect(p.text, `${topic}: ${p.text.slice(0, 80)}`).toMatch(/benchmark/i);
        expect(p.text, `${topic}: ${p.text.slice(0, 80)}`).not.toMatch(/GTA[^.]{0,80}\b(legal(ly)? (entitle|bind|enforce)|in law|statutory|as a matter of law)\b/i);
      }
    }
    for (const step of getPaidFasterPlan()) {
      if (step.citations.every((c) => c.startsWith('gta-'))) expect(step.benchmarkOnly, step.code).toBe(true);
    }
  });

  it('every topic that mentions the FOS or the ombudsman carries FORUM_NOT_OPEN', () => {
    let hits = 0;
    for (const topic of ADVICE_TOPICS) {
      const a = advise(topic);
      const text = [a.summary, ...a.points.map((p) => p.text)].join(' ');
      if (/\bFOS\b|ombudsman/i.test(text)) {
        hits++;
        expect(a.forumChecks, topic).toContain(FORUM_NOT_OPEN);
      }
    }
    expect(hits).toBeGreaterThanOrEqual(2); // complaint, pav
    expect(FORUM_NOT_OPEN).toMatch(/DISP 2\.7/);
  });

  it('carries the blueprint "verify" caveats where the topic relies on the unverified item', () => {
    expect(advise('bhr').caveats).toContain(BENCHMARK_FIGURES_CAVEAT);
    expect(advise('payment_pack').caveats).toContain(BENCHMARK_FIGURES_CAVEAT);
    expect(advise('payment_pack').caveats).toContain(ICOBS_SCOPE_CAVEAT);
    expect(advise('interest').caveats).toContain(ICOBS_SCOPE_CAVEAT);
    expect(advise('complaint').caveats).toContain(ICOBS_SCOPE_CAVEAT);
    for (const topic of ['period', 'total_loss', 'storage', 'salvage']) expect(advise(topic).caveats, topic).toContain(GTA_4_14_CAVEAT);
    expect(advise('litigation').caveats).toContain(COURT_FEES_CAVEAT);
    expect(advise('litigation').caveats).toContain(MEDIATION_CAVEAT);
    expect(advise('costs_exposure').caveats.join(' ')).toMatch(/UKSC/);
    expect(advise('pav').caveats.join(' ')).toMatch(/scrap/i);
  });

  it('any topic that cites gta-4-14 carries the 4.14 wording caveat', () => {
    for (const topic of ADVICE_TOPICS) {
      const a = advise(topic);
      if (a.points.some((p) => p.citations.includes('gta-4-14'))) expect(a.caveats, topic).toContain(GTA_4_14_CAVEAT);
    }
  });

  it('every topic ends with the common verification caveat and lists its unverified citations', () => {
    for (const topic of ADVICE_TOPICS) {
      const a = advise(topic);
      expect(a.caveats[a.caveats.length - 1]).toMatch(/verification/i);
      expect(a.unverifiedCitations.length).toBeGreaterThan(0); // nothing in the KB is verified yet
    }
  });

  it('the litigation and costs topics carry the reserved-activity perimeter and the injury referral', () => {
    expect(advise('litigation').forumChecks).toEqual(expect.arrayContaining([RESERVED_ACTIVITY, INJURY_PERIMETER]));
    expect(advise('costs_exposure').forumChecks).toContain(RESERVED_ACTIVITY);
    expect(RESERVED_ACTIVITY).toMatch(/Legal Services Act 2007/);
    expect(INJURY_PERIMETER).toMatch(/no referral fee/);
  });
});

describe('advisor aliases and keyword forum checks', () => {
  it('maps fos / ombudsman onto the complaint playbook with the forum-not-open check', () => {
    for (const t of ['fos', 'FOS', 'ombudsman', 'Financial Ombudsman']) {
      const a = advise(t);
      expect(a.topic).toBe('complaint');
      expect(a.forumChecks.some((c) => c.includes('DISP 2.7'))).toBe(true);
    }
  });
  it('adds the GTA benchmark check to free-text rate questions and the LSA check to court questions', () => {
    expect(advise('gta rates for a golf').forumChecks.some((c) => c.startsWith('GTA_CITED_AS_LAW'))).toBe(true);
    expect(advise('issue proceedings').forumChecks.some((c) => /reserved|LSA|Legal Services Act/i.test(c))).toBe(true);
  });
});
