// owned by ap-foundation
/**
 * Migration 0013_autopilot (docs/SUPREME-AUTOPILOT.md §G.2, §J.2 "Migration"): a 0.4 database with three hires (one
 * open, one ended, and two overlapping under a past manager override) migrates; the back-fill creates one reservation
 * per hire (source 'backfill', legacy overlaps kept); the overlap triggers then refuse a new overlapping hold and accept
 * a touching one; the append-only tables refuse updates and deletes.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { migrationsFolder, runMigrations } from './migrate.js';
import { getAgentSettings, patchAgentSettings } from './repos/agentSettings.js';

const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };

const handles: DatabaseHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database migrated to the 0.4 + phase-1 state (every migration before 0013_autopilot). */
function preAutopilotDatabase(): DatabaseHandle {
  const before = journal.entries.filter((e) => e.when < 1792250000000);
  expect(before.at(-1)?.tag).toBe('0012_settlement_offers');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-ap-mig-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: before }));
  for (const e of before) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  const h = createDatabase({ path: ':memory:' });
  handles.push(h);
  runMigrations(h.db, { migrationsFolder: dir });
  return h;
}

const T = '2026-01-01T00:00:00.000Z';

function seedClaim(h: DatabaseHandle, id: string, claimant: string): void {
  h.sqlite
    .prepare(
      `INSERT INTO claims (id, reference, status, opened_at, accident, liability, claimant_id, client_vehicle_id, third_party_ids, linked_claim_ids, flags, created_at, updated_at)
       VALUES (?, ?, 'hire_active', ?, '{}', '{}', ?, 'v-' || ?, '[]', '[]', '[]', ?, ?)`,
    )
    .run(id, `CCG-2026-${id}`, T, claimant, id, T, T);
}

function seedHire(h: DatabaseHandle, id: string, claimId: string, unit: string, startAt: string, endAt: string | null, collectedAt: string | null = null, use?: string): void {
  h.sqlite
    .prepare(
      `INSERT INTO hire_agreements (id, claim_id, fleet_unit_id, agreement_number, start_at, end_at, collected_at, daily_rate_pence, vat_rate, gta_group, excess_pence,
         additional_drivers, enforceability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 4980, 0.2, 'C2', 0, '[]', '{"cca60fCompliant":false}', ?, ?)`,
    )
    .run(id, claimId, unit, `CCG-H-${id}`, startAt, endAt, collectedAt, T, T);
  if (use) {
    h.sqlite
      .prepare(`INSERT INTO claim_events (id, claim_id, type, at, recorded_at, summary, data, evidence_ids, created_by) VALUES (?, ?, 'hire_started', ?, ?, 'Hire started', ?, '[]', 'system')`)
      .run(`ev-${id}`, claimId, startAt, startAt, JSON.stringify({ hireId: id, use }));
  }
}

const ms = (iso: string): number => Date.parse(iso);

function insertReservation(h: DatabaseHandle, r: { id: string; unit: string; claimId: string; status: string; start: string; end: string | null; source?: string; overrideAuditId?: string }): void {
  h.sqlite
    .prepare(
      `INSERT INTO fleet_reservations (id, fleet_unit_id, claim_id, status, use, start_at, expected_end_at, block_start_ms, block_end_ms, hirer_party_id, daily_rate_pence, gta_group,
         source, overlap_override_audit_id, created_by, created_at, updated_at)
       VALUES (@id, @unit, @claimId, @status, 'credit_hire', @start, @end, @startMs, @endMs, 'p1', 4980, 'C2', @source, @audit, 'test', @t, @t)`,
    )
    .run({ id: r.id, unit: r.unit, claimId: r.claimId, status: r.status, start: r.start, end: r.end, startMs: ms(r.start), endMs: r.end ? ms(r.end) : null, source: r.source ?? 'autopilot', audit: r.overrideAuditId ?? null, t: T });
}

describe('0013_autopilot', () => {
  it('back-fills one reservation per hire on a 0.4 database, keeping legacy overlaps', () => {
    const h = preAutopilotDatabase();
    seedClaim(h, 'c1', 'p1');
    seedClaim(h, 'c2', 'p2');
    seedClaim(h, 'c3', 'p3');
    // Open hire on unit A (no end) — still on hire.
    seedHire(h, 'h1', 'c1', 'unit-a', '2026-09-01T09:00:00.000Z', null, null, 'self_drive');
    // Ended hire on unit B, collected two hours after the contractual end.
    seedHire(h, 'h2', 'c2', 'unit-b', '2026-03-01T09:00:00Z', '2026-03-10T09:00:00Z', '2026-03-10T11:00:00Z');
    // A second hire on unit B overlapping h2 (recorded in 0.3 under a manager override).
    seedHire(h, 'h3', 'c3', 'unit-b', '2026-03-09T09:00:00.000Z', '2026-03-20T09:00:00.000Z');

    runMigrations(h.db);

    const rows = h.sqlite.prepare('SELECT * FROM fleet_reservations ORDER BY hire_agreement_id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const [r1, r2, r3] = rows;
    expect(r1).toMatchObject({ hire_agreement_id: 'h1', status: 'on_hire', use: 'self_drive', source: 'backfill', block_end_ms: null, hirer_party_id: 'p1', agreement_number: 'CCG-H-h1', driver_party_ids: '[]' });
    expect(r1!.block_start_ms).toBe(ms('2026-09-01T09:00:00.000Z'));
    // collectedAt now counts in the occupied period; mixed …Z / ….000Z text is compared as epoch ms.
    expect(r2).toMatchObject({ hire_agreement_id: 'h2', status: 'returned', use: 'credit_hire', block_start_ms: ms('2026-03-01T09:00:00Z'), block_end_ms: ms('2026-03-10T11:00:00Z') });
    expect(r3).toMatchObject({ hire_agreement_id: 'h3', status: 'returned', source: 'backfill' });

    const hires = h.sqlite.prepare('SELECT id, reservation_id, use, hirer_party_id, driver_party_ids FROM hire_agreements ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(hires.map((x) => x.reservation_id)).toEqual([r1!.id, r2!.id, r3!.id]);
    expect(hires[0]).toMatchObject({ use: 'self_drive', hirer_party_id: 'p1', driver_party_ids: '[]' });

    // Overlap trigger: a new hold overlapping the open hire on A is refused; a touching one on B is accepted.
    expect(() => insertReservation(h, { id: 'n1', unit: 'unit-a', claimId: 'c9', status: 'held', start: '2027-01-01T09:00:00.000Z', end: '2027-01-10T09:00:00.000Z' })).toThrow(/RESERVATION_OVERLAP/);
    expect(() => insertReservation(h, { id: 'n2', unit: 'unit-b', claimId: 'c9', status: 'held', start: '2026-03-20T09:00:00.000Z', end: '2026-03-25T09:00:00.000Z' })).not.toThrow();
    expect(() => insertReservation(h, { id: 'n3', unit: 'unit-b', claimId: 'c8', status: 'held', start: '2026-03-24T09:00:00.000Z', end: '2026-03-26T09:00:00.000Z' })).toThrow(/RESERVATION_OVERLAP/);
    // A manager override (audit id) or a back-fill row passes.
    expect(() => insertReservation(h, { id: 'n4', unit: 'unit-b', claimId: 'c8', status: 'held', start: '2026-03-24T09:00:00.000Z', end: '2026-03-26T09:00:00.000Z', overrideAuditId: 'audit-1' })).not.toThrow();
    // An UPDATE into held/confirmed that would overlap is refused; physical-reality updates of on_hire rows are not.
    insertReservation(h, { id: 'n5', unit: 'unit-c', claimId: 'c7', status: 'held', start: '2026-05-01T09:00:00.000Z', end: '2026-05-05T09:00:00.000Z' });
    insertReservation(h, { id: 'n6', unit: 'unit-c', claimId: 'c6', status: 'held', start: '2026-05-05T09:00:00.000Z', end: '2026-05-08T09:00:00.000Z' });
    expect(() => h.sqlite.prepare('UPDATE fleet_reservations SET block_end_ms = ? WHERE id = ?').run(ms('2026-05-06T09:00:00.000Z'), 'n5')).toThrow(/RESERVATION_OVERLAP/);
    h.sqlite.prepare("UPDATE fleet_reservations SET status = 'confirmed' WHERE id = 'n5'").run();
    h.sqlite.prepare("UPDATE fleet_reservations SET status = 'on_hire' WHERE id = 'n5'").run();
    expect(() => h.sqlite.prepare('UPDATE fleet_reservations SET block_end_ms = ? WHERE id = ?').run(ms('2026-05-06T09:00:00.000Z'), 'n5')).not.toThrow();
  });

  it('creates the Autopilot tables, columns and append-only triggers; settlement_offers is untouched', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    const tables = new Set((h.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of [
      'claim_autopilot', 'autopilot_log', 'fleet_locations', 'fleet_readiness_tasks', 'fleet_damage', 'fleet_reservations', 'fleet_reservation_events', 'fleet_movements', 'hire_offers',
      'driver_profiles', 'claim_hire_needs', 'eligibility_assessments', 'clash_findings', 'document_packs', 'signature_requests', 'signature_request_events', 'kiosk_sessions', 'settlement_offers',
    ])
      expect(tables.has(t), t).toBe(true);
    const cols = (table: string): string[] => (h.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('fleet_units')).toEqual(expect.arrayContaining(['location_id', 'current_mileage', 'mileage_at', 'service_due_miles', 'phv_licence_number', 'phv_licence_expiry', 'turnaround_minutes']));
    expect(cols('insurance_policies')).toEqual(expect.arrayContaining(['driver_criteria', 'renews_policy_id']));
    expect(cols('hire_agreements')).toEqual(expect.arrayContaining(['use', 'hirer_party_id', 'driver_party_ids', 'reservation_id', 'expected_end_at']));
    expect(cols('signatures')).toEqual(expect.arrayContaining(['method', 'drawn_signature_sha256', 'evidence_id', 'pack_id', 'pack_sha256']));
    expect(cols('outbox')).toContain('autopilot_step_id');
    expect(cols('agent_settings')).toContain('autopilot');

    const at = '2026-10-10T09:00:00.000Z';
    h.sqlite.prepare("INSERT INTO autopilot_log (id, claim_id, step_id, to_status, actor, at) VALUES ('l1', 'c1', 'hire.search', 'due', 'agent:autopilot', ?)").run(at);
    h.sqlite.prepare("INSERT INTO fleet_reservation_events (id, reservation_id, to_status, actor, at) VALUES ('e1', 'r1', 'held', 'agent:autopilot', ?)").run(at);
    h.sqlite.prepare("INSERT INTO eligibility_assessments (id, claim_id, kind, outcome, reasons, inputs_sha256, created_by, created_at) VALUES ('a1', 'c1', 'driver', 'eligible', '[]', 'x', 'agent:autopilot', ?)").run(at);
    h.sqlite.prepare("INSERT INTO signature_request_events (id, signature_request_id, to_status, actor, at) VALUES ('s1', 'sr1', 'sent', 'owner', ?)").run(at);
    for (const [table, id] of [['autopilot_log', 'l1'], ['fleet_reservation_events', 'e1'], ['eligibility_assessments', 'a1'], ['signature_request_events', 's1']] as const) {
      expect(() => h.sqlite.prepare(`UPDATE ${table} SET id = id WHERE id = ?`).run(id), table).toThrow(/append-only/);
      expect(() => h.sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id), table).toThrow(/append-only/);
    }
    // Open clash findings are unique by dedupe key; resolved ones are not.
    const finding = h.sqlite.prepare(
      "INSERT INTO clash_findings (id, code, severity, message, dedupe_key, status, first_seen_at, last_seen_at) VALUES (?, 'UNIT_DOUBLE_BOOKED', 'block', 'm', 'k1', ?, ?, ?)",
    );
    finding.run('f1', 'open', at, at);
    expect(() => finding.run('f2', 'open', at, at)).toThrow(/UNIQUE/);
    expect(() => finding.run('f3', 'resolved', at, at)).not.toThrow();
  });

  it('stores autopilot settings in agent_settings (merged over the defaults, floors enforced)', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    expect(getAgentSettings(h.db).autopilot.booking.holdHours).toBe(24);
    const next = patchAgentSettings(h.db, { autopilot: { booking: { holdHours: 12 }, stepModes: { 'hire.offer': 'confirm', 'hire.handover': 'auto' } } }, { userId: 'owner' });
    expect(next.autopilot.booking.holdHours).toBe(12);
    expect(next.autopilot.stepModes).toEqual({ 'hire.offer': 'confirm', 'hire.handover': 'owner' });
    expect(getAgentSettings(h.db).autopilot.stepModes['hire.offer']).toBe('confirm');
    const audit = h.sqlite.prepare("select action from audit_log where action = 'autopilot.settings'").all();
    expect(audit).toHaveLength(1);
    // Clearing a step mode (null) falls back to the catalogue default.
    const cleared = patchAgentSettings(h.db, { autopilot: { stepModes: { 'hire.offer': null } } }, { userId: 'owner' });
    expect(cleared.autopilot.stepModes['hire.offer']).toBeUndefined();
  });
});
