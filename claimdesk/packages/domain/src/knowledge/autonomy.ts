// owned by knowledge-core
/**
 * What applies itself and what waits for the owner (docs/SUPREME-KNOWLEDGE-BUILDER.md §9.1, §9.2). Pure: the first
 * matching rule (KN-01 … KN-19) decides. Learned knowledge can only make ClaimDesk more careful: anything that would
 * loosen the perimeter, the always-ask lists, offers, money, human-only steps or red lines is rejected (KN-03); rules,
 * strategies, precedents and every legal, quantum or strategy point always wait for the owner (KN-07, KN-08).
 *
 * Also here: `proposalProblems` (structural validation every proposal passes before it is stored — the API adds zod
 * twins for route bodies) and `perimeterTextFlags` (the text checks KN-03 uses).
 */
import { REGULATED_STATUS_PHRASES } from '../consistency/legacy.js';
import { effectsAllowed, validateRule } from './ruleLogic.js';
import { scopeProblems } from './scope.js';
import { isFosTagged, isGtaTagged } from './verification.js';
import {
  BUSINESSES,
  KIND_RULES,
  KNOWLEDGE_AREAS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_ORIGINS,
  KNOWLEDGE_USE_LIMITS,
  type ContactData,
  type EngineeringFigureData,
  type FactData,
  type InsurerProfileData,
  type KnowledgeDecision,
  type KnowledgeDecisionContext,
  type KnowledgeProposal,
  type KnowledgeRuleId,
  type KnowledgeSettings,
  type PrecedentData,
  type ProcedureData,
  type RuleData,
  type StrategyData,
  type TemplateSnippetData,
} from './types.js';

export const MAX_TITLE_CHARS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const numOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));
const strArr = (v: unknown): boolean => Array.isArray(v) && v.every(str);

/** Kind-specific data shape (the minimum the store relies on). */
function dataProblems(p: KnowledgeProposal): string[] {
  const d = p.data as unknown;
  if (!isObj(d)) return ['data must be an object'];
  const out: string[] = [];
  const need = (ok: boolean, msg: string): void => {
    if (!ok) out.push(`data.${msg}`);
  };
  switch (p.kind) {
    case 'fact': {
      const f = d as Partial<FactData>;
      need(str(f.statement) && f.statement.trim().length > 0, 'statement is required');
      need(f.figure === null || f.figure === undefined || (isObj(f.figure) && typeof f.figure.value === 'number' && str(f.figure.unit)), 'figure must be {value, unit} or null');
      need(f.benchmarkOnly === undefined || typeof f.benchmarkOnly === 'boolean', 'benchmarkOnly must be a boolean');
      if (f.stat) need(typeof f.stat.n === 'number' && typeof f.stat.hits === 'number' && str(f.stat.step), 'stat needs step, hits and n');
      if (f.kbCheck) need(str(f.kbCheck.entryId), 'kbCheck needs entryId');
      break;
    }
    case 'rule':
      out.push(...validateRule(d as unknown as RuleData).map((m) => `data.${m}`));
      break;
    case 'strategy': {
      const s = d as Partial<StrategyData>;
      need(str(s.situation) && str(s.goal), 'situation and goal are required');
      need(strArr(s.steps) && strArr(s.leverage) && strArr(s.counterArguments) && strArr(s.evidenceNeeded), 'steps, leverage, counterArguments and evidenceNeeded must be lists of text');
      need(Array.isArray(s.appliesTo), 'appliesTo must be a list');
      break;
    }
    case 'contact': {
      const c = d as Partial<ContactData>;
      need(str(c.insurerSlug) && c.insurerSlug.length > 0, 'insurerSlug is required');
      need(Boolean(c.name || c.phone || c.email || c.ivr), 'a contact needs a name, phone, email or IVR note');
      need(strOrNull(c.phone ?? null) && strOrNull(c.email ?? null), 'phone and email must be text or null');
      break;
    }
    case 'insurer_profile': {
      const ip = d as Partial<InsurerProfileData>;
      need(str(ip.insurerSlug), 'insurerSlug is required');
      need(ip.window === '12m' || ip.window === 'all', 'window must be 12m or all');
      need(isObj(ip.n) && isObj(ip.daysToPay), 'n and daysToPay are required');
      break;
    }
    case 'template_snippet': {
      const t = d as Partial<TemplateSnippetData>;
      need(str(t.text) && t.text.trim().length > 0, 'text is required');
      need(str(t.purpose), 'purpose is required');
      need(Array.isArray(t.tokens), 'tokens must be a list');
      break;
    }
    case 'engineering_figure': {
      const e = d as Partial<EngineeringFigureData>;
      need(isObj(e.vehicle) && str(e.vehicle.make), 'vehicle.make is required');
      need(str(e.panel) && str(e.operation) && str(e.metric), 'panel, operation and metric are required');
      need([e.median, e.p25, e.p75, e.n].every((x) => typeof x === 'number' && Number.isFinite(x)), 'median, p25, p75 and n must be numbers');
      break;
    }
    case 'precedent': {
      const pr = d as Partial<PrecedentData>;
      need(str(pr.citation) && str(pr.principle) && str(pr.url), 'citation, principle and url are required');
      need(numOrNull(pr.year ?? null), 'year must be a number or null');
      break;
    }
    case 'procedure': {
      const pc = d as Partial<ProcedureData>;
      need(strArr(pc.steps) && (pc.steps as string[]).length > 0, 'steps must be a non-empty list of text');
      need(str(pc.forWhom), 'forWhom is required');
      break;
    }
  }
  return out;
}

/** Structural problems with a proposal (empty = storable). Kind/origin/area/use mismatches are decided by KN-02 instead. */
export function proposalProblems(p: KnowledgeProposal): string[] {
  const out: string[] = [];
  if (!isObj(p)) return ['proposal must be an object'];
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(p.kind)) return [`unknown kind ${String(p.kind)}`];
  if (!(KNOWLEDGE_AREAS as readonly string[]).includes(p.area)) out.push(`unknown area ${String(p.area)}`);
  if (!(KNOWLEDGE_ORIGINS as readonly string[]).includes(p.origin)) out.push(`unknown origin ${String(p.origin)}`);
  if (!(KNOWLEDGE_USE_LIMITS as readonly string[]).includes(p.useLimit)) out.push(`unknown use limit ${String(p.useLimit)}`);
  if (!str(p.title) || !p.title.trim()) out.push('title is required');
  else if (p.title.length > MAX_TITLE_CHARS) out.push(`title is longer than ${MAX_TITLE_CHARS} characters`);
  if (!str(p.body)) out.push('body must be text');
  else if (p.body.length > KIND_RULES[p.kind].maxBodyChars) out.push(`body is longer than ${KIND_RULES[p.kind].maxBodyChars} characters for a ${p.kind}`);
  if (!Array.isArray(p.tags) || !p.tags.every((t) => str(t) && t.length <= 64)) out.push('tags must be short text');
  if (!Array.isArray(p.business) || p.business.length === 0 || !p.business.every((b) => (BUSINESSES as readonly string[]).includes(b))) out.push('business must list ccguk and/or fixmyfile');
  if (typeof p.confidence !== 'number' || !(p.confidence >= 0 && p.confidence <= 1)) out.push('confidence must be 0..1');
  if (typeof p.supportN !== 'number' || !Number.isInteger(p.supportN) || p.supportN < 0) out.push('supportN must be a whole number');
  if (!Array.isArray(p.provenance)) out.push('provenance must be a list');
  if (!str(p.createdBy) || !p.createdBy) out.push('createdBy is required');
  out.push(...scopeProblems(p.scope));
  out.push(...dataProblems(p));
  return out;
}

// ---------------------------------------------------------------------------
// Perimeter text checks (KN-03)
// ---------------------------------------------------------------------------

const PERIMETER_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: 'GTA_CITED_AS_LAW', re: /\b(?:the\s+)?GTA\s+(?:requires|obliges|entitles|mandates|compels|is\s+(?:binding|law|legally\s+binding))\b|\b(?:entitled|obliged|bound|required)\s+(?:to\s+[^.]{0,40}?\s+)?(?:by|under)\s+the\s+GTA\b|\bpursuant\s+to\s+(?:the\s+)?GTA\b/i },
  { code: 'PI_HANDLED_IN_HOUSE', re: /\b(?:we|ccguk|claimdesk)\s+(?:will|can|should|may)\s+(?:handle|run|pursue|settle|value|negotiate)\s+(?:the\s+|your\s+|any\s+)?(?:personal\s+)?injury\b|\b(?:handle|pursue|settle|value)\s+(?:the\s+)?(?:personal\s+)?injury\s+claims?\s+(?:ourselves|in[-\s]house)\b/i },
  { code: 'OFFER_DECIDED_WITHOUT_OWNER', re: /\b(?:auto(?:matically)?[-\s]?(?:accept|reject|counter|decline)|accept\s+(?:the\s+|any\s+|all\s+)?offers?\s+(?:automatically|without\s+(?:asking|the\s+owner|approval))|(?:accept|reject|counter)\s+(?:offers?\s+)?without\s+(?:asking|the\s+owner|approval)|no\s+need\s+to\s+ask\s+(?:the\s+)?owner)\b/i },
  { code: 'ALWAYS_ASK_AUTO_SENT', re: /\b(?:auto(?:matically)?[-\s]?send|send\s+(?:it\s+|them\s+)?(?:automatically|without\s+(?:approval|review|asking))|skip\s+(?:the\s+)?(?:review|approval|reviewer)|no\s+(?:owner\s+)?approval\s+(?:is\s+)?needed|bypass\s+(?:the\s+)?(?:perimeter|review|approval|always[-\s]ask))\b/i },
  { code: 'MONEY_MOVED', re: /\b(?:write[-\s]?off|reduce|waive|refund|pay\s+out|release)\s+(?:the\s+)?(?:balance|invoice|ledger|payment|money)\s+(?:automatically|without\s+(?:asking|approval))\b/i },
];

/**
 * Perimeter-loosening text in a proposal (KN-03): regulated legal status, GTA as law, in-house PI handling, offers
 * decided without the owner, auto-sending an always-ask item, moving money unasked. Returns codes (deduplicated, sorted).
 */
export function perimeterTextFlags(text: string, tags: readonly string[] = []): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const phrase of REGULATED_STATUS_PHRASES) if (lower.includes(phrase.toLowerCase())) out.add('REGULATED_STATUS_IMPLIED');
  for (const { code, re } of PERIMETER_PATTERNS) if (re.test(text)) out.add(code);
  // A GTA item is a benchmark: stating it without the benchmark wording as an entitlement is GTA-as-law (KR-3).
  if (tags.some((t) => /^gta$/i.test(t)) && /\b(?:entitle[sd]?|must\s+pay|legally)\b/i.test(text) && !/benchmark|industry\s+(?:practice|standard)/i.test(text)) out.add('GTA_CITED_AS_LAW');
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// decideKnowledge (§9.1)
// ---------------------------------------------------------------------------

export type AutoApplyCategory = keyof KnowledgeSettings['autoApply'];

/** Which owner-switchable auto-apply category a proposal falls in (KN-13), or null when none applies. */
export function autoApplyCategory(p: Pick<KnowledgeProposal, 'kind' | 'area' | 'origin'>): AutoApplyCategory | null {
  if (p.kind === 'contact') return 'contacts';
  if (p.kind === 'engineering_figure' || p.area === 'engineering') return 'engineering';
  if (p.origin === 'computed' || p.area === 'statistics') return 'statistics';
  if (p.kind === 'template_snippet' && p.origin !== 'curated') return 'snippets';
  if (p.origin === 'curated' && (p.kind === 'template_snippet' || p.area === 'style')) return 'curatedStyle';
  if (p.area === 'procedural') return 'procedures';
  return null;
}

const LEGAL_OR_QUANTUM_TERMS = /(?:\b(?:statute|section\s+\d|s\.\s?\d|act\s+\d{4}|cpr|part\s+36|practice\s+direction|judgment|court|liabilit\w*|negligen\w*|quantum|damages|interest|indemnit\w*|mitigat\w*|pav|valuation)\b|£\s?\d|\d+\s?%)/i;
const AGENT_FETCH_HINT = 'agent_fetch';

function decision(outcome: KnowledgeDecision['outcome'], ruleId: KnowledgeRuleId, reasons: string[], priority: KnowledgeDecision['priority'] = 'low'): KnowledgeDecision {
  return { outcome, ruleIds: [ruleId], reasons, priority };
}

/** The first matching rule decides (KN-01 … KN-19). Pure. */
export function decideKnowledge(p: KnowledgeProposal, c: KnowledgeDecisionContext): KnowledgeDecision {
  const s = c.settings;
  const rules = KIND_RULES[p.kind];
  const text = `${p.title}\n${p.body}`;

  // KN-01 learning off (owner-authored items excepted)
  if (!s.learningEnabled && p.origin !== 'owner') return decision('hold', 'KN-01', ['Learning is paused: stored, nothing applied']);

  // KN-02 kind and origin invalid
  if (!rules) return decision('reject', 'KN-02', [`unknown kind ${String(p.kind)}`]);
  const kindProblems: string[] = [];
  if (!rules.allowedOrigins.includes(p.origin)) kindProblems.push(`a ${p.kind} cannot come from ${p.origin}`);
  if (!rules.allowedAreas.includes(p.area)) kindProblems.push(`a ${p.kind} cannot be in area ${p.area}`);
  if (!rules.allowedUse.includes(p.useLimit)) kindProblems.push(`a ${p.kind} cannot be ${p.useLimit}`);
  if (kindProblems.length) return decision('reject', 'KN-02', kindProblems);

  // KN-03 perimeter loosening
  const perimeter: string[] = [...c.perimeterFlags, ...perimeterTextFlags(text, p.tags)];
  if (p.kind === 'rule') {
    const problems = validateRule(p.data);
    const effects = Array.isArray((p.data as RuleData)?.then) ? (p.data as RuleData).then : [];
    if (problems.length || !effectsAllowed(effects)) perimeter.push(...(problems.length ? problems : ['rule effect outside the restrictive or advisory vocabulary']));
  }
  if (p.area === 'legal' && isGtaTagged(p.tags, p.provenance)) perimeter.push('GTA material is a benchmark only and can never be a legal point (KR-3)');
  if ((p.tags.some((t) => /^(injury|personal_injury|pi)$/i.test(t))) && p.kind !== 'procedure') perimeter.push('personal injury is referred out, never learned as handling knowledge (KR-4)');
  if (isFosTagged(p.tags, p.provenance) && !p.business.every((b) => b === 'fixmyfile')) perimeter.push('FOS-derived knowledge must be tagged business fixmyfile only (KR-4)');
  if (perimeter.length) return decision('reject', 'KN-03', [...new Set(perimeter)]);

  // KN-04 directive text on researched or observed content
  if (c.directiveFlags.length && (p.origin === 'researched' || p.origin === 'observed')) return decision('reject', 'KN-04', c.directiveFlags.map((f) => `instruction-like text: ${f}`));

  // KN-05 copycat
  if (c.contact?.domainCheck === 'copycat') return decision('reject', 'KN-05', ['the contact or domain matches a known copycat (payment-diversion risk)']);

  // KN-06 conflicts with KB, packs, red lines or directory
  if (c.conflicts.length) return decision('queue', 'KN-06', c.conflicts.map((f) => `${f.kind}: ${f.detail}`), 'high');

  // KN-07 always-queue kind
  if (p.kind === 'rule' || p.kind === 'strategy' || p.kind === 'precedent') return decision('queue', 'KN-07', [`every ${p.kind} waits for the owner`]);

  // KN-08 always-queue area
  if (p.area === 'legal' || p.area === 'quantum' || p.area === 'strategy') return decision('queue', 'KN-08', [`${p.area} points wait for the owner`]);

  // KN-09 outbound use
  if (p.useLimit === 'outbound_ok') return decision('queue', 'KN-09', ['knowledge that may be cited outbound waits for the owner']);

  // KN-10 replaces confirmed knowledge
  if (c.replaces && (c.replaces.verification !== 'unverified' || c.replaces.origin === 'owner')) return decision('queue', 'KN-10', ['it would replace knowledge the owner confirmed or wrote']);

  // KN-11 web-discovered
  if (p.provenance.some((pr) => pr.kind === 'url') || c.snapshot?.policy === AGENT_FETCH_HINT) return decision('queue', 'KN-11', ['found through web research: the owner checks it first']);

  // KN-12 low confidence or support
  if (p.confidence < s.thresholds.autoApplyConfidence) return decision('queue', 'KN-12', [`confidence ${p.confidence} is below ${s.thresholds.autoApplyConfidence}`]);
  const minSupport = p.kind === 'contact' ? Math.max(rules.minSupportForAuto, s.thresholds.contactObservations) : p.kind === 'engineering_figure' ? Math.max(rules.minSupportForAuto, s.thresholds.engineeringMinN) : p.kind === 'insurer_profile' ? Math.max(rules.minSupportForAuto, s.thresholds.statsMinN) : rules.minSupportForAuto;
  if (p.supportN < minSupport) return decision('queue', 'KN-12', [`support ${p.supportN} is below ${minSupport} for a ${p.kind}`]);

  // KN-13 category switched off
  const category = autoApplyCategory(p);
  if (category && !s.autoApply[category]) return decision('queue', 'KN-13', [`the owner switched off automatic ${category}`]);

  // KN-14 statistics
  if (p.origin === 'computed' && (p.area === 'statistics' || p.area === 'engineering')) return decision('auto_apply', 'KN-14', ['computed from ClaimDesk’s own records; internal only']);

  // KN-15 contact from verified mail
  if (p.kind === 'contact' && c.contact && c.contact.domainCheck === 'own_domain' && c.contact.dmarc === 'pass' && c.contact.independentThreads >= s.thresholds.contactObservations) {
    return decision('auto_apply', 'KN-15', [`seen in ${c.contact.independentThreads} separate email threads from the insurer’s own domain (DMARC pass)`]);
  }

  // KN-16 low-risk procedure
  if (p.area === 'procedural' && p.useLimit === 'internal') {
    const observed = p.origin === 'observed' && p.supportN >= 2;
    const official = c.snapshot !== null && (c.snapshot.policy === 'api' || c.snapshot.policy === 'code_fetch') && c.snapshot.quoteMatch === 'exact';
    if (observed || official) return decision('auto_apply', 'KN-16', [observed ? `observed ${p.supportN} times` : 'quoted exactly from an official source']);
  }

  // KN-17 owner's own snippet, fully generalised
  if (p.kind === 'template_snippet' && (p.origin === 'observed' || p.origin === 'owner') && c.snippet?.ownerAuthored && c.snippet.fullyGeneralised) {
    return decision('auto_apply', 'KN-17', ['the owner’s own wording, with every figure, date, reference and name generalised']);
  }

  // KN-18 curated style
  if (p.origin === 'curated' && (p.kind === 'template_snippet' || (p.kind === 'fact' && p.area === 'style')) && p.supportN >= s.thresholds.styleSupport && !LEGAL_OR_QUANTUM_TERMS.test(text)) {
    return decision('auto_apply', 'KN-18', [`the owner made the same edit ${p.supportN} times`]);
  }

  // KN-19 default
  return decision('queue', 'KN-19', ['waits for the owner']);
}
