// owned by ap-autopilot
/**
 * Settings > Autopilot (docs/SUPREME-AUTOPILOT.md §I.8, §A.11, §L): the master switch and new-claims default; the step
 * modes (Auto / Ask me / I do it — modes below a step's floor are greyed with the reason, e.g. "Agreements and forms
 * always need you"); booking timings; green thresholds; ranking weights (normalised to 100); hire-period projection;
 * signing (code by email or shown to the handler, chase days, the office-network tablet with its warning); and the
 * means option. Saved with PATCH /settings/autopilot (admin / approver; audited).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { STEP_CATALOGUE, STEP_MODE_RANK, type AutopilotSettings, type StepMode } from '@ccguk/domain';
import { useAutopilotSettings, usePatchAutopilotSettings, type AutopilotSettingsPatch } from '../../../api/autopilotApi';
import { useAutonomySettings } from '../../../api/agentsApi';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Checkbox, Select, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { MODE_LABEL, TRACKS } from '../../claim/lib/autopilot';
import '../../claim/tabs/autopilot.css';

/** The Word credit hire agreement whose art 60F fit the owner confirms once (Settings > Autopilot > Signing). */
const CCGUK_03 = 'agreement.ccguk_03_credit_hire';
const MODES: StepMode[] = ['auto', 'confirm', 'owner'];
const RANK_LABEL: Record<string, string> = { likeForLike: 'Like for like', cost: 'Cost', needsFit: 'Needs', readiness: 'Readiness', compliance: 'Cover and compliance', location: 'Location' };

const num = (v: string, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The weights normalised to sum 100 (what the ranking actually uses). */
export function normalisedWeights(w: Record<string, number>): Record<string, number> {
  const total = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round((Math.max(0, v) / total) * 100)]));
}

/** The PATCH for an edited draft: whole groups, and step modes as a diff (null = back to the default). */
export function settingsPatch(before: AutopilotSettings, draft: AutopilotSettings): AutopilotSettingsPatch {
  const stepModes: Record<string, StepMode | null> = {};
  for (const id of new Set([...Object.keys(before.stepModes), ...Object.keys(draft.stepModes)])) {
    const a = before.stepModes[id as keyof AutopilotSettings['stepModes']];
    const b = draft.stepModes[id as keyof AutopilotSettings['stepModes']];
    if (a !== b) stepModes[id] = b ?? null;
  }
  return {
    enabled: draft.enabled,
    newClaims: draft.newClaims,
    ...(Object.keys(stepModes).length ? { stepModes } : {}),
    booking: draft.booking,
    green: draft.green,
    ranking: draft.ranking,
    projection: draft.projection,
    signing: draft.signing,
    eligibility: { requireMeansBeforeOffer: draft.eligibility.requireMeansBeforeOffer },
  };
}

export function AutopilotSettingsPage() {
  const q = useAutopilotSettings();
  const autonomy = useAutonomySettings();
  const save = usePatchAutopilotSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<AutopilotSettings | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data.settings));
  }, [q.data, draft]);
  const floors = useMemo(() => new Map((q.data?.floors ?? []).map((f) => [f.id, f])), [q.data]);
  if (q.isLoading || !draft) return q.error ? <ApiErrorNotice error={q.error} what="load the Autopilot settings" /> : <Loading />;
  const set = (patch: (d: AutopilotSettings) => void) => setDraft((d) => {
    const next = structuredClone(d!);
    patch(next);
    return next;
  });
  const perClaim = autonomy.data?.settings.limits.perClaimPerDay;
  const weights = normalisedWeights(draft.ranking as unknown as Record<string, number>);

  const onSave = () =>
    save.mutate(settingsPatch(q.data!.settings, draft), {
      onSuccess: (r) => {
        setDraft(structuredClone(r.settings));
        toast.success('Autopilot settings saved');
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    });

  return (
    <div className="page ap-tab">
      <PageHeader title="Settings > Autopilot" />
      <Card title="Autopilot">
        <Checkbox label="Autopilot on (master switch)" checked={draft.enabled} onChange={(v) => set((d) => void (d.enabled = v))} hint="Off: plans are still shown, nothing is done. Agents must also be switched on in Settings > AI." />
        <Select<'on' | 'paused'> label="New claims start" value={draft.newClaims} onChange={(v) => set((d) => void (d.newClaims = (v || 'on') as 'on' | 'paused'))} options={[{ value: 'on', label: 'On — fully automatic within the rules below' }, { value: 'paused', label: 'Paused — I resume each claim' }]} />
        {typeof perClaim === 'number' && perClaim < 6 && (
          <p className="ap-notice">
            Automatic sends per claim per day is {perClaim}. A booking day legitimately sends about six emails (acknowledgement, NCAF, offer, delivery confirmation, reminder) — raise it to 6 in <Link to="/settings/autonomy">Settings &gt; Autonomy</Link>.
          </p>
        )}
      </Card>

      <Card title="Step modes">
        <p className="ap-muted">Auto = the autopilot does it (every safety rule still applies); Ask me = it prepares and you confirm; I do it = a person does it. Offers, settlements, money and legal always need you.</p>
        <table className="ap-modes">
          <thead>
            <tr>
              <th>Step</th>
              <th>Mode</th>
              <th>Why it cannot go lower</th>
            </tr>
          </thead>
          <tbody>
            {TRACKS.map((t) =>
              STEP_CATALOGUE.filter((s) => s.track === t.id).map((s) => {
                const floor = floors.get(s.id);
                const current = draft.stepModes[s.id] ?? s.defaultMode;
                return (
                  <tr key={s.id}>
                    <td>
                      <span className="ap-muted">{t.label} · </span>
                      {s.title}
                    </td>
                    <td>
                      <select
                        aria-label={`Mode for ${s.title}`}
                        className="select"
                        value={current}
                        onChange={(e) => set((d) => void (d.stepModes = { ...d.stepModes, [s.id]: e.target.value as StepMode }))}
                      >
                        {MODES.map((m) => (
                          <option key={m} value={m} disabled={STEP_MODE_RANK[m] < STEP_MODE_RANK[s.floor]}>
                            {MODE_LABEL[m]}
                            {m === s.defaultMode ? ' (default)' : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="ap-muted">{floor?.reason ?? ''}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Booking timings">
        <div className="ap-grid">
          <TextInput type="number" label="Hold a car for (hours)" value={String(draft.booking.holdHours)} onChange={(v) => set((d) => void (d.booking.holdHours = num(v, d.booking.holdHours)))} />
          <TextInput type="number" label="Remind the client after (hours)" value={String(draft.booking.offerReminderHours)} onChange={(v) => set((d) => void (d.booking.offerReminderHours = num(v, d.booking.offerReminderHours)))} />
          <TextInput type="number" label="Turnaround between hires (minutes)" value={String(draft.booking.turnaroundMinutes)} onChange={(v) => set((d) => void (d.booking.turnaroundMinutes = num(v, d.booking.turnaroundMinutes)))} />
          <TextInput type="number" label="Lead time before a delivery (minutes)" value={String(draft.booking.leadMinutes)} onChange={(v) => set((d) => void (d.booking.leadMinutes = num(v, d.booking.leadMinutes)))} />
          <TextInput type="number" label="Delivery window (minutes)" value={String(draft.booking.windowMinutes)} onChange={(v) => set((d) => void (d.booking.windowMinutes = num(v, d.booking.windowMinutes)))} />
          <TextInput type="number" label="Movements per window (max)" value={String(draft.booking.maxPerWindow)} onChange={(v) => set((d) => void (d.booking.maxPerWindow = num(v, d.booking.maxPerWindow)))} />
          <TextInput label="Business hours start (HH:MM)" value={draft.booking.businessHours.start} onChange={(v) => set((d) => void (d.booking.businessHours.start = v))} />
          <TextInput label="Business hours end (HH:MM)" value={draft.booking.businessHours.end} onChange={(v) => set((d) => void (d.booking.businessHours.end = v))} />
          <TextInput type="number" label="Look ahead for the need date (days)" value={String(draft.booking.lookAheadDays)} onChange={(v) => set((d) => void (d.booking.lookAheadDays = num(v, d.booking.lookAheadDays)))} />
          <TextInput type="number" label="Alternatives listed in an offer" value={String(draft.booking.alternativesShown)} onChange={(v) => set((d) => void (d.booking.alternativesShown = num(v, d.booking.alternativesShown)))} />
        </div>
        <Checkbox label="No deliveries on bank holidays" checked={draft.booking.businessHours.skipBankHolidays} onChange={(v) => set((d) => void (d.booking.businessHours.skipBankHolidays = v))} />
      </Card>

      <Card title="When the autopilot offers a car by itself (green)">
        <div className="ap-grid">
          <TextInput type="number" label="Like-for-like minimum (0–1)" value={String(draft.green.minLikeForLike)} onChange={(v) => set((d) => void (d.green.minLikeForLike = num(v, d.green.minLikeForLike)))} />
          <TextInput type="number" label="Clear-winner gap (points)" value={String(draft.green.clearWinnerGap)} onChange={(v) => set((d) => void (d.green.clearWinnerGap = num(v, d.green.clearWinnerGap)))} />
          <TextInput type="number" label="Automatic offers per day (max)" value={String(draft.green.maxAutoOffersPerDay)} onChange={(v) => set((d) => void (d.green.maxAutoOffersPerDay = num(v, d.green.maxAutoOffersPerDay)))} />
        </div>
        <Checkbox label="Hold the top car while I choose" checked={draft.green.protectiveHold} onChange={(v) => set((d) => void (d.green.protectiveHold = v))} />
        <p className="ap-muted">Like for like is judged on GTA benchmark rates — a benchmark only (CCGUK is not a GTA subscriber).</p>
      </Card>

      <Card title="Ranking weights">
        <div className="ap-grid">
          {(Object.keys(draft.ranking) as Array<keyof AutopilotSettings['ranking']>).map((k) => (
            <label key={k} className="field">
              <span className="field-label">
                {RANK_LABEL[k] ?? k} — {weights[k]}%
              </span>
              <input type="range" min={0} max={100} value={draft.ranking[k]} aria-label={RANK_LABEL[k] ?? k} onChange={(e) => set((d) => void (d.ranking[k] = Number(e.target.value)))} />
            </label>
          ))}
        </div>
      </Card>

      <Card title="Hire period">
        <div className="ap-grid">
          <TextInput type="number" label="Default hire (days)" value={String(draft.projection.defaultHireDays)} onChange={(v) => set((d) => void (d.projection.defaultHireDays = num(v, d.projection.defaultHireDays)))} />
          <TextInput type="number" label="Parts buffer (working days)" value={String(draft.projection.partsBufferWorkingDays)} onChange={(v) => set((d) => void (d.projection.partsBufferWorkingDays = num(v, d.projection.partsBufferWorkingDays)))} />
          <TextInput type="number" label="Total loss (days)" value={String(draft.projection.totalLossDays)} onChange={(v) => set((d) => void (d.projection.totalLossDays = num(v, d.projection.totalLossDays)))} />
        </div>
      </Card>

      <Card title="Signing">
        <Select<'email' | 'handler'> label="Signing code" value={draft.signing.otpDelivery} onChange={(v) => set((d) => void (d.signing.otpDelivery = (v || 'email') as 'email' | 'handler'))} options={[{ value: 'email', label: "Emailed to the client's address" }, { value: 'handler', label: 'Shown to the handler (audited)' }]} />
        <div className="ap-grid">
          <TextInput label="Chase unsigned paperwork after (days, comma separated)" value={draft.signing.chaseAfterDays.join(', ')} onChange={(v) => set((d) => void (d.signing.chaseAfterDays = v.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0)))} />
          <TextInput type="number" label="Call the client after (days)" value={String(draft.signing.callAfterDays)} onChange={(v) => set((d) => void (d.signing.callAfterDays = num(v, d.signing.callAfterDays)))} />
          <TextInput type="number" label="Kiosk session (minutes)" value={String(draft.signing.kioskTtlMinutes)} onChange={(v) => set((d) => void (d.signing.kioskTtlMinutes = num(v, d.signing.kioskTtlMinutes)))} />
        </div>
        <Checkbox
          label="Tablet on the office network (signing kiosk over the LAN)"
          checked={draft.signing.lanKiosk}
          onChange={(v) => set((d) => void (d.signing.lanKiosk = v))}
          warning={draft.signing.lanKiosk ? 'Plain HTTP on the local network: use it only on a trusted network or the PC’s own hotspot. Takes effect after a restart.' : undefined}
        />
        <Checkbox
          label="Our CCGUK-03 credit hire agreement fits the RAO art 60F exemption"
          checked={(draft.signing.art60fTemplates ?? []).includes(CCGUK_03)}
          onChange={(v) => set((d) => void (d.signing.art60fTemplates = v ? [...new Set([...(d.signing.art60fTemplates ?? []), CCGUK_03])] : (d.signing.art60fTemplates ?? []).filter((t) => t !== CCGUK_03)))}
          hint="Tick only if the agreement's own terms allow at most 12 payments within 12 months and no interest or charges. Hires signed on it are then recorded as art 60F compliant; otherwise each hire keeps an enforceability warning until you confirm it."
        />
      </Card>

      <Card title="Eligibility">
        <Checkbox label="Require evidence of means before a car is offered" checked={draft.eligibility.requireMeansBeforeOffer} onChange={(v) => set((d) => void (d.eligibility.requireMeansBeforeOffer = v))} hint="Off: a warning about basic-hire-rate recovery is shown instead." />
        <p className="ap-muted">
          Driver criteria per policy: <Link to="/settings/fleet/criteria">Settings &gt; Fleet &gt; Driver criteria</Link>.
        </p>
      </Card>

      <div className="ap-row">
        <Button variant="primary" loading={save.isPending} onClick={onSave}>
          Save Autopilot settings
        </Button>
        <Button onClick={() => setDraft(structuredClone(q.data!.settings))}>Undo changes</Button>
      </div>
    </div>
  );
}
