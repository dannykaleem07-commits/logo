/**
 * Mixed-upload sorting (docs/SMART-INTAKE.md §4.5, improvement 1): the files of a bundle → this case (`main`), other
 * new cases (`case:B`, `case:C` …), existing claims (`claim:<id>`), `unsure` and `excluded`, each with plain reasons.
 *
 *  1. Edges: two files are linked when they share ≥1 strong key, ≥2 medium keys, or 1 medium + ≥2 weak keys; a photo's
 *     plate matching another file's registration links it; a child (EML attachment, ZIP entry, segment) links to its
 *     parent — unless an EML attachment's strong client identifier contradicts its parent's. Union-find → clusters.
 *  2. A cluster with two different client VINs or name + date of birth gets a warning (never auto-split).
 *  3. Each cluster is scored against the claim index (strong 10, medium 4, weak 1): ≥ 10 and ≥ 2× the runner-up →
 *     that claim; 5–9 → a new case with a "possible match" reason.
 *  4. Files with no identifiers join the only new case, else the case whose accident day is within 2 days of the
 *     photo's date, else `unsure`.
 *  5. Main = the cluster best matching the bundle's name hint; ties → not a claim match, most documents, earliest.
 *  6. Owner moves (pins) and exclusions override everything; duplicates follow their primary.
 * Deterministic: file order is `position`.
 */
import type { BundleGroup, GroupReason, GroupReasonCode } from './types.js';
import type { FileKey, FileKeys, KeyKind } from './keys.js';
import { KEY_STRENGTH } from './keys.js';
import { daysBetween } from './text.js';

export interface ClaimKeyIndex {
  claims: Array<{ claimId: string; reference: string; clientName: string | null; status: string; keys: Array<{ kind: KeyKind; value: string }> }>;
}

export interface GroupingInput {
  files: FileKeys[];
  index: ClaimKeyIndex;
  nameHint: string;
  /** fileId → groupKey the owner moved it to. */
  pins: Record<string, string>;
  excluded: string[];
  /** Accident day per cluster seed (optional override; otherwise read from the files' accident-date keys). */
  accidentDates?: Record<string, string>;
  /** fileId → primary fileId (duplicates follow their primary). */
  duplicateOf?: Record<string, string>;
  /** Make/model words per file (name-hint scoring). */
  words?: Record<string, string[]>;
  /** AI advice for files left `unsure`: moved only when no strong key contradicts. */
  advice?: Record<string, { groupKey: string; why: string }>;
}

export interface GroupingResult {
  groups: BundleGroup[];
  fileGroup: Record<string, string>;
  warnings: string[];
}

const WEIGHT = { strong: 10, medium: 4, weak: 1 } as const;
const KIND_LABEL: Record<KeyKind, string> = {
  ccg_ref: 'ClaimDesk reference', vin: 'VIN', vrm: 'registration', insurer_ref: 'insurer reference', policy: 'policy number', licence: 'driving licence number',
  name_dob: 'name and date of birth', name: 'name', postcode: 'postcode', phone: 'phone number', email: 'email address', accident_date: 'accident date',
  police_ref: 'police reference', sha_on_claim: 'file', plate: 'number plate',
};
const REASON_CODE: Partial<Record<KeyKind, GroupReasonCode>> = {
  ccg_ref: 'shared_ccg_ref', vin: 'shared_vin', vrm: 'shared_vrm', plate: 'plate_in_photo', insurer_ref: 'shared_insurer_ref', policy: 'shared_policy', licence: 'shared_licence',
  name_dob: 'shared_name_dob', phone: 'shared_phone', email: 'shared_email', postcode: 'shared_postcode', accident_date: 'shared_accident_date', sha_on_claim: 'same_file_on_claim',
  police_ref: 'shared_insurer_ref', name: 'name_hint',
};
const HINT_STOP = new Set(['crash', 'accident', 'claim', 'car', 'the', 'and', 'van', 'collision', 'case', 'new', 'files', 'docs', 'documents', 'bundle', 'rear', 'end', 'hit', 'shunt']);

/** Plates and registrations compare as one kind. */
const matchKind = (k: KeyKind): KeyKind => (k === 'plate' ? 'vrm' : k);
const keyId = (k: Pick<FileKey, 'kind' | 'value'>): string => `${matchKind(k.kind)}|${k.value}`;

function shortValue(k: FileKey): string {
  const d = k.display ?? k.value;
  if (k.kind === 'vin' && d.length > 10) return `${d.slice(0, 3)}…${d.slice(-3)}`;
  if (k.kind === 'name_dob' || k.kind === 'name') return k.display ?? '';
  return d;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

interface Cluster {
  seed: string;
  files: FileKeys[];
  keys: Map<string, FileKey>;
  reasons: GroupReason[];
  warnings: string[];
  claim: { claimId: string; reference: string; clientName: string | null; status: string; score: number } | null;
  possible: { reference: string; score: number } | null;
  score: number;
}

function sharedBetween(a: FileKeys, b: FileKeys): FileKey[] {
  const bKeys = new Map(b.keys.map((k) => [keyId(k), k]));
  const out: FileKey[] = [];
  for (const k of a.keys) {
    if (k.kind === 'sha_on_claim') continue;
    if (bKeys.has(keyId(k))) out.push(k);
  }
  return out;
}

function linked(a: FileKeys, b: FileKeys, shared: FileKey[]): boolean {
  const strong = shared.filter((k) => k.strength === 'strong').length;
  const medium = shared.filter((k) => k.strength === 'medium').length;
  const weak = shared.filter((k) => k.strength === 'weak').length;
  if (strong >= 1 || medium >= 2 || (medium >= 1 && weak >= 2)) return true;
  // A photo's plate matching another file's registration.
  if ((a.isPhoto || b.isPhoto) && shared.some((k) => matchKind(k.kind) === 'vrm')) return true;
  return false;
}

/** Two strong client identifiers of the same kind with different values (two different client VINs …). */
function contradicts(a: FileKeys, b: FileKeys): KeyKind | null {
  for (const kind of ['vin', 'name_dob', 'licence'] as KeyKind[]) {
    const va = new Set(a.keys.filter((k) => k.kind === kind && k.role === 'client').map((k) => k.value));
    const vb = new Set(b.keys.filter((k) => k.kind === kind && k.role === 'client').map((k) => k.value));
    if (va.size && vb.size && ![...va].some((v) => vb.has(v))) return kind;
  }
  return null;
}

const describe = (f: FileKeys): string => f.label ?? 'another file';

/** The next free `case:X` key (B, C, … Z, then AA …). */
export function nextCaseKey(existing: Iterable<string>): string {
  const used = new Set([...existing].filter((k) => k.startsWith('case:')).map((k) => k.slice(5)));
  for (let i = 1; i < 26 * 27; i += 1) {
    const letter = i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
    if (!used.has(letter)) return `case:${letter}`;
  }
  return `case:${used.size + 1}`;
}

export function groupFiles(input: GroupingInput): GroupingResult {
  const files = [...input.files].sort((a, b) => a.position - b.position || a.fileId.localeCompare(b.fileId));
  const byId = new Map(files.map((f) => [f.fileId, f]));
  const excluded = new Set(input.excluded);
  const dupOf = input.duplicateOf ?? {};
  const pinned = new Set(Object.keys(input.pins).filter((id) => byId.has(id) && !excluded.has(id)));
  const active = files.filter((f) => !excluded.has(f.fileId) && !dupOf[f.fileId] && !pinned.has(f.fileId));
  const warnings: string[] = [];

  // 1. edges
  const uf = new UnionFind();
  const edgeReasons = new Map<string, GroupReason[]>(); // by fileId (the later file of a pair)
  const addReason = (fileId: string, r: GroupReason) => edgeReasons.set(fileId, [...(edgeReasons.get(fileId) ?? []), r]);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!;
      const b = active[j]!;
      const shared = sharedBetween(a, b);
      if (!shared.length || !linked(a, b, shared)) continue;
      uf.union(a.fileId, b.fileId);
      const best = [...shared].sort((x, y) => WEIGHT[y.strength] - WEIGHT[x.strength])[0]!;
      const code = REASON_CODE[best.kind] ?? 'shared_vrm';
      const what = best.kind === 'plate' || (a.isPhoto !== b.isPhoto && matchKind(best.kind) === 'vrm') ? `Plate ${shortValue(best)} in the photo matches ${describe(a.isPhoto ? b : a)}` : `Same ${KIND_LABEL[best.kind]}${shortValue(best) ? ` ${shortValue(best)}` : ''} as ${describe(a)}`;
      addReason(b.fileId, { code: a.isPhoto || b.isPhoto ? (matchKind(best.kind) === 'vrm' ? 'plate_in_photo' : code) : code, text: what, fileId: b.fileId, key: best.kind });
    }
  }
  for (const f of active) {
    if (!f.parentFileId) continue;
    const parent = byId.get(f.parentFileId);
    if (!parent || excluded.has(parent.fileId) || pinned.has(parent.fileId) || dupOf[parent.fileId]) continue;
    if (f.role === 'attachment') {
      const c = contradicts(f, parent);
      if (c) {
        addReason(f.fileId, { code: 'conflicting_identifiers', text: `Attached to ${describe(parent)} but its ${KIND_LABEL[c]} is different`, fileId: f.fileId });
        continue;
      }
    }
    uf.union(parent.fileId, f.fileId);
    addReason(f.fileId, f.role === 'segment' ? { code: 'segment_of', text: `Part of the scanned pack ${describe(parent)}`, fileId: f.fileId } : { code: 'attachment_of', text: `Came inside ${describe(parent)}`, fileId: f.fileId });
  }

  // 2. clusters
  const clusterMap = new Map<string, Cluster>();
  for (const f of active) {
    const root = uf.find(f.fileId);
    let c = clusterMap.get(root);
    if (!c) {
      c = { seed: root, files: [], keys: new Map(), reasons: [], warnings: [], claim: null, possible: null, score: 0 };
      clusterMap.set(root, c);
    }
    c.files.push(f);
    for (const k of f.keys) if (!c.keys.has(keyId(k)) || (k.display && !c.keys.get(keyId(k))!.display)) c.keys.set(keyId(k), k);
    c.reasons.push(...(edgeReasons.get(f.fileId) ?? []));
  }
  const clusters = [...clusterMap.values()];
  const keyed = clusters.filter((c) => c.keys.size > 0);
  const unkeyed = clusters.filter((c) => c.keys.size === 0);

  for (const c of keyed) {
    for (const kind of ['vin', 'name_dob'] as KeyKind[]) {
      const values = new Set([...c.keys.values()].filter((k) => k.kind === kind && k.role === 'client').map((k) => k.value));
      if (values.size > 1) {
        const w = `These files may be two cases: they show ${values.size} different client ${KIND_LABEL[kind]}s`;
        c.warnings.push(w);
        c.reasons.push({ code: 'conflicting_identifiers', text: w });
      }
    }
    // internal evidence score: distinct keys shared by at least two files
    const counts = new Map<string, number>();
    for (const f of c.files) for (const id of new Set(f.keys.map(keyId))) counts.set(id, (counts.get(id) ?? 0) + 1);
    let s = 0;
    for (const [id, n] of counts) if (n >= 2) s += WEIGHT[c.keys.get(id)!.strength];
    c.score = c.files.length === 1 ? 10 : Math.max(10, s);
  }

  // 3. existing claims
  for (const c of keyed) {
    const scores = input.index.claims.map((cl) => {
      const claimKeys = new Set(cl.keys.map((k) => `${matchKind(k.kind)}|${k.value}`));
      let score = 0;
      const hits: FileKey[] = [];
      for (const k of c.keys.values()) {
        if (k.kind === 'sha_on_claim') {
          if (k.value === cl.claimId) {
            score += WEIGHT.strong;
            hits.push(k);
          }
          continue;
        }
        if (claimKeys.has(keyId(k))) {
          score += WEIGHT[KEY_STRENGTH[k.kind]];
          hits.push(k);
        }
      }
      return { cl, score, hits };
    });
    scores.sort((a, b) => b.score - a.score || a.cl.reference.localeCompare(b.cl.reference));
    const best = scores[0];
    const second = scores[1]?.score ?? 0;
    if (best && best.score >= 10 && best.score >= 2 * second) {
      c.claim = { claimId: best.cl.claimId, reference: best.cl.reference, clientName: best.cl.clientName, status: best.cl.status, score: best.score };
      for (const h of best.hits.slice(0, 3)) {
        c.reasons.unshift({
          code: h.kind === 'sha_on_claim' ? 'same_file_on_claim' : 'matches_claim',
          text: h.kind === 'sha_on_claim' ? `The same file is already on ${best.cl.reference}` : `${KIND_LABEL[h.kind][0]!.toUpperCase()}${KIND_LABEL[h.kind].slice(1)}${shortValue(h) ? ` ${shortValue(h)}` : ''} is on ${best.cl.reference}`,
          key: h.kind,
        });
      }
    } else if (best && best.score >= 5) {
      c.possible = { reference: best.cl.reference, score: best.score };
      c.reasons.push({ code: 'possible_claim_match', text: `Some details also appear on ${best.cl.reference} (${best.hits.map((h) => KIND_LABEL[h.kind]).join(', ')}) — check it is not the same case` });
    }
  }

  // 5. main (decided before the unkeyed files join, so they can join it)
  const hintTokens = input.nameHint
    .split(/\s[–—-]\s|[,;]/)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !HINT_STOP.has(t));
  const hintScore = (c: Cluster): number => {
    let s = 0;
    const nameTokens = new Set<string>();
    for (const k of c.keys.values()) {
      if ((k.kind === 'name' || k.kind === 'name_dob') && k.role === 'client' && k.display) for (const t of k.display.toLowerCase().split(/[^a-z]+/)) if (t) nameTokens.add(t);
      if (k.kind === 'vrm' && hintTokens.some((t) => t.toUpperCase() === k.value)) s += 5;
    }
    for (const t of hintTokens) if (nameTokens.has(t)) s += 3;
    const words = new Set(c.files.flatMap((f) => input.words?.[f.fileId] ?? []).map((w) => w.toLowerCase()));
    for (const t of hintTokens) if (words.has(t)) s += 2;
    // compact registration in the hint ("KX21ABC" or "KX21 ABC")
    const compact = input.nameHint.toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const k of c.keys.values()) if (k.kind === 'vrm' && k.value.length >= 5 && compact.includes(k.value) && !hintTokens.some((t) => t.toUpperCase() === k.value)) s += 5;
    return s;
  };
  const docs = (c: Cluster) => c.files.filter((f) => f.isDocument !== false && !f.isPhoto).length;
  const firstPos = (c: Cluster) => Math.min(...c.files.map((f) => f.position));
  const ranked = [...keyed].sort((a, b) => hintScore(b) - hintScore(a) || Number(Boolean(a.claim)) - Number(Boolean(b.claim)) || docs(b) - docs(a) || firstPos(a) - firstPos(b));
  const main: Cluster = ranked[0] ?? { seed: '__main__', files: [], keys: new Map(), reasons: [], warnings: [], claim: null, possible: null, score: 0 };
  if (ranked[0] && hintScore(ranked[0]) > 0) main.reasons.unshift({ code: 'name_hint', text: `Matches the bundle name “${input.nameHint.trim()}”` });

  // 4. unkeyed files
  const newCases = keyed.filter((c) => !c.claim || c === main);
  const accidentDay = (c: Cluster): string | null => {
    if (input.accidentDates?.[c.seed]) return input.accidentDates[c.seed]!;
    const days = [...c.keys.values()].filter((k) => k.kind === 'accident_date').map((k) => k.value);
    return days[0] ?? null;
  };
  const unsure: FileKeys[] = [];
  const unsureReasons: GroupReason[] = [];
  for (const u of unkeyed) {
    let target: Cluster | undefined;
    let reason: GroupReason | undefined;
    if (newCases.length <= 1) {
      target = newCases[0] ?? main;
      reason = { code: 'only_case_in_upload', text: `${u.files.length === 1 ? describe(u.files[0]!) : `${u.files.length} files`} ha${u.files.length === 1 ? 's' : 've'} no identifiers; this is the only case in the upload`, fileId: u.files[0]!.fileId };
    } else {
      const taken = u.files.map((f) => f.takenAt).find((t): t is string => Boolean(t));
      if (taken) {
        const near = newCases
          .map((c) => ({ c, d: accidentDay(c) }))
          .filter((x): x is { c: Cluster; d: string } => Boolean(x.d))
          .map((x) => ({ ...x, gap: Math.abs(daysBetween(x.d, taken) ?? Infinity) }))
          .filter((x) => x.gap <= 2.5)
          .sort((a, b) => a.gap - b.gap);
        if (near.length === 1 || (near.length > 1 && near[0]!.gap < near[1]!.gap)) {
          target = near[0]!.c;
          reason = { code: 'photo_date_near_accident', text: `Photo taken ${taken.slice(0, 10)}, within two days of this case's accident`, fileId: u.files[0]!.fileId };
        }
      }
    }
    if (target) {
      target.files.push(...u.files);
      if (reason) target.reasons.push(reason);
      if (target === main && !keyed.includes(main) && !clusters.includes(main)) {
        /* main created from unkeyed files only */
      }
    } else {
      unsure.push(...u.files);
      unsureReasons.push({ code: 'no_identifiers', text: `${u.files.length === 1 ? describe(u.files[0]!) : `${u.files.length} files`}: nothing in ${u.files.length === 1 ? 'it' : 'them'} names a registration, person or reference`, fileId: u.files[0]!.fileId });
    }
  }

  // AI advice: only out of `unsure`, only when no strong key contradicts (the target is a new case or main).
  for (const [fileId, adv] of Object.entries(input.advice ?? {})) {
    const i = unsure.findIndex((f) => f.fileId === fileId);
    if (i < 0) continue;
    const target = adv.groupKey === 'main' ? main : undefined;
    if (!target) continue;
    const f = unsure[i]!;
    const contra = target.files.some((t) => contradicts(f, t));
    if (contra) continue;
    unsure.splice(i, 1);
    target.files.push(f);
    target.reasons.push({ code: 'ai_advice', text: `The AI check placed it here: ${adv.why}`.slice(0, 200), fileId });
  }

  // 6. labels and keys
  const groups: BundleGroup[] = [];
  const fileGroup: Record<string, string> = {};
  const clientName = (c: Cluster): string | null => {
    const n = [...c.keys.values()].find((k) => k.kind === 'name' && k.role === 'client' && k.display) ?? [...c.keys.values()].find((k) => k.kind === 'name_dob' && k.display);
    return n?.display ? n.display.replace(/, born .*$/, '') : null;
  };
  const clientVrm = (c: Cluster): string | null => [...c.keys.values()].find((k) => k.kind === 'vrm' && k.role === 'client')?.display ?? [...c.keys.values()].find((k) => k.kind === 'vrm')?.display ?? null;
  const suggested = (c: Cluster): string | null => {
    const parts = [clientName(c), clientVrm(c)].filter(Boolean);
    return parts.length ? parts.join(' — ') : null;
  };
  const conf = (score: number) => Math.round(Math.min(1, score / 20) * 100) / 100;
  const dedupeReasons = (rs: GroupReason[]): GroupReason[] => {
    const seen = new Set<string>();
    return rs.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true))).slice(0, 5);
  };
  const ordered = (fs: FileKeys[]) => [...fs].sort((a, b) => a.position - b.position).map((f) => f.fileId);

  const mainGroup: BundleGroup = {
    key: 'main',
    kind: 'main',
    label: 'This case',
    claim: main.claim ? { id: main.claim.claimId, reference: main.claim.reference, clientName: main.claim.clientName, status: main.claim.status } : null,
    fileIds: ordered(main.files),
    reasons: dedupeReasons(main.reasons),
    confidence: conf(main.claim ? main.claim.score : main.score || (main.files.length ? 10 : 0)),
    suggestedName: suggested(main),
    warnings: main.warnings,
    defaultAction: main.claim ? 'decide' : 'register',
  };
  groups.push(mainGroup);
  const others = keyed.filter((c) => c !== main && !c.claim).sort((a, b) => firstPos(a) - firstPos(b));
  const used: string[] = [];
  for (const c of others) {
    const key = nextCaseKey(used);
    used.push(key);
    const who = clientName(c) ?? clientVrm(c);
    groups.push({
      key,
      kind: 'new_case',
      label: `New case ${key.slice(5)}${who ? ` — ${who}` : ''}`,
      claim: null,
      fileIds: ordered(c.files),
      reasons: dedupeReasons(c.reasons),
      confidence: conf(c.score),
      suggestedName: suggested(c),
      warnings: c.warnings,
      defaultAction: 'split_off',
    });
  }
  const claimClusters = new Map<string, Cluster[]>();
  for (const c of keyed.filter((x) => x !== main && x.claim)) claimClusters.set(c.claim!.claimId, [...(claimClusters.get(c.claim!.claimId) ?? []), c]);
  for (const [claimId, cs] of claimClusters) {
    const cl = cs[0]!.claim!;
    groups.push({
      key: `claim:${claimId}`,
      kind: 'existing_claim',
      label: `${cl.reference}${cl.clientName ? ` — ${cl.clientName}` : ''}`,
      claim: { id: claimId, reference: cl.reference, clientName: cl.clientName, status: cl.status },
      fileIds: ordered(cs.flatMap((c) => c.files)),
      reasons: dedupeReasons(cs.flatMap((c) => c.reasons)),
      confidence: conf(Math.max(...cs.map((c) => c.claim!.score))),
      suggestedName: null,
      warnings: cs.flatMap((c) => c.warnings),
      defaultAction: 'attach',
    });
  }
  if (unsure.length) {
    groups.push({ key: 'unsure', kind: 'unsure', label: 'Not sure', claim: null, fileIds: ordered(unsure), reasons: dedupeReasons(unsureReasons), confidence: 0, suggestedName: null, warnings: [], defaultAction: 'decide' });
  }
  for (const g of groups) for (const id of g.fileIds) fileGroup[id] = g.key;

  // pins (owner moves) override everything
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const id of [...pinned].sort((a, b) => byId.get(a)!.position - byId.get(b)!.position)) {
    const key = input.pins[id]!;
    let g = byKey.get(key);
    if (!g) {
      const claimId = key.startsWith('claim:') ? key.slice(6) : null;
      const cl = claimId ? input.index.claims.find((c) => c.claimId === claimId) : undefined;
      g = {
        key,
        kind: key === 'main' ? 'main' : key === 'unsure' ? 'unsure' : claimId ? 'existing_claim' : 'new_case',
        label: key === 'unsure' ? 'Not sure' : claimId ? `${cl?.reference ?? 'Claim'}${cl?.clientName ? ` — ${cl.clientName}` : ''}` : `New case ${key.replace(/^case:/, '')}`,
        claim: claimId ? { id: claimId, reference: cl?.reference ?? '', clientName: cl?.clientName ?? null, status: cl?.status ?? '' } : null,
        fileIds: [],
        reasons: [],
        confidence: 1,
        suggestedName: null,
        warnings: [],
        defaultAction: claimId ? 'attach' : key === 'unsure' ? 'decide' : 'split_off',
      };
      groups.push(g);
      byKey.set(key, g);
    }
    g.fileIds.push(id);
    g.reasons.push({ code: 'moved_by_owner', text: `${describe(byId.get(id)!)} was moved here by you`, fileId: id });
    g.reasons = g.reasons.slice(-5);
    fileGroup[id] = key;
  }

  // duplicates follow their primary
  for (const f of files) {
    if (excluded.has(f.fileId) || pinned.has(f.fileId)) continue;
    const p = dupOf[f.fileId];
    if (!p) continue;
    let root = p;
    for (let i = 0; i < 10 && dupOf[root]; i += 1) root = dupOf[root]!;
    const key = fileGroup[root] ?? 'main';
    const g = byKey.get(key) ?? mainGroup;
    g.fileIds.push(f.fileId);
    fileGroup[f.fileId] = g.key;
  }

  // excluded
  const ex = files.filter((f) => excluded.has(f.fileId));
  if (ex.length) {
    groups.push({ key: 'excluded', kind: 'excluded', label: 'Excluded', claim: null, fileIds: ex.map((f) => f.fileId), reasons: [], confidence: 1, suggestedName: null, warnings: [], defaultAction: 'exclude' });
    for (const f of ex) fileGroup[f.fileId] = 'excluded';
  }

  const posOf = (id: string) => byId.get(id)?.position ?? 0;
  for (const g of groups) g.fileIds.sort((a, b) => posOf(a) - posOf(b));
  for (const g of groups) warnings.push(...g.warnings);
  // stable order: main, new cases, claims, unsure, excluded
  const rank = (g: BundleGroup) => ({ main: 0, new_case: 1, existing_claim: 2, unsure: 3, excluded: 4 })[g.kind];
  groups.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  return { groups: groups.filter((g) => g.kind === 'main' || g.fileIds.length > 0), fileGroup, warnings };
}
