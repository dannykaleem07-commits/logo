// owned by intake-web
/**
 * Settings > Intake (docs/SMART-INTAKE.md §4.17, §11.5, §14): case bundles (automatic registration — off by default —
 * the missing-documents request, the quiet period, folder bundles, AI checks per day), splitting scanned packs, copies,
 * photo checks and .zip limits, in plain words. Saved with PATCH /settings/intake (changed values only; audited).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Checkbox, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { useIntakeSettings, usePatchIntakeSettings, type IntakeSettings, type IntakeSettingsPatch } from '../../../api/bundlesApi';

const GIB = 1024 ** 3;

/** Only the values that changed, grouped as the API expects (a deep-partial IntakeSettings). */
export function settingsDiff(before: IntakeSettings, after: IntakeSettings): IntakeSettingsPatch {
  const out: Record<string, Record<string, unknown>> = {};
  for (const group of Object.keys(after) as Array<keyof IntakeSettings>) {
    const a = before[group] as unknown as Record<string, unknown>;
    const b = after[group] as unknown as Record<string, unknown>;
    for (const k of Object.keys(b)) {
      if (a?.[k] !== b[k]) (out[group] ??= {})[k] = b[k];
    }
  }
  return out as IntakeSettingsPatch;
}

/** A number field that keeps what you type (so "0." or an empty box never jumps) and commits valid numbers. */
function NumberField({ label, hint, value, onChange, min, max, step = 1, scale = 1 }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; scale?: number }) {
  const shown = (n: number) => String(Math.round((n / scale) * 1000) / 1000);
  const [text, setText] = useState(shown(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);
  const n = Number(text);
  const error = text.trim() === '' || !Number.isFinite(n) ? 'Enter a number' : n * scale < min || n * scale > max ? `Between ${shown(min)} and ${shown(max)}` : undefined;
  return (
    <TextInput
      type="number"
      label={label}
      hint={hint}
      value={text}
      step={step}
      error={error}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(v) => {
        setText(v);
        const x = Number(v);
        const stored = scale === 1 ? x : Number((x * scale).toPrecision(12));
        if (v.trim() !== '' && Number.isFinite(x) && stored >= min && stored <= max) onChange(stored);
      }}
    />
  );
}

export function IntakeSettingsPage() {
  const q = useIntakeSettings();
  const save = usePatchIntakeSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<IntakeSettings | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data.settings));
  }, [q.data, draft]);
  if (q.isLoading || !draft) return q.error ? <ApiErrorNotice error={q.error} what="load the intake settings" /> : <Loading />;
  const set = (patch: (d: IntakeSettings) => void) =>
    setDraft((d) => {
      const next = structuredClone(d!);
      patch(next);
      return next;
    });
  const diff = settingsDiff(q.data!.settings, draft);
  const changed = Object.keys(diff).length > 0;

  const onSave = () =>
    save.mutate(diff, {
      onSuccess: (r) => {
        setDraft(structuredClone(r.settings));
        toast.success('Intake settings saved');
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    });

  return (
    <div className="page">
      <PageHeader title="Settings > Intake" crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Intake' }]} subtitle="How files dropped together are read into one claim." />
      <div className="stack">
        <Card title="Registering claims from bundles">
          <div className="stack-sm">
          <Checkbox
            label="Register automatically when there are no conflicts and every key field is confident"
            checked={draft.bundles.autoRegister}
            onChange={(v) => set((d) => void (d.bundles.autoRegister = v))}
            hint="Only when every key detail is confident, nothing conflicts, the AI has checked the bundle and nothing is worth a look. You still get a card to look it over."
          />
          <NumberField
            label="Confidence needed for automatic registration (%)"
            value={draft.bundles.autoRegisterMinConfidence}
            scale={0.01}
            min={0.8}
            max={1}
            onChange={(v) => set((d) => void (d.bundles.autoRegisterMinConfidence = v))}
            hint="Between 80 and 100. With it off, a ready bundle waits in Needs you as a prepared claim."
          />
          <Checkbox
            label="Prepare a request to the client for missing documents"
            checked={draft.bundles.prepareMissingDocsRequest}
            onChange={(v) => set((d) => void (d.bundles.prepareMissingDocsRequest = v))}
            hint="Prepared after you register; it always waits for your approval before it is sent."
          />
          <NumberField label="Quiet period before reading the bundle together (seconds)" value={draft.bundles.quietSeconds} min={0} max={600} onChange={(v) => set((d) => void (d.bundles.quietSeconds = Math.round(v)))} hint="Waits for the drop to finish so the files are read together once." />
          <Checkbox
            label="A folder in the import folder (inbox\intake\<name>\) becomes a bundle"
            checked={draft.bundles.folderBundles}
            onChange={(v) => set((d) => void (d.bundles.folderBundles = v))}
            hint="Folders named after a claim reference keep filing on that claim."
          />
          <NumberField label="AI checks per bundle per day" value={draft.bundles.aiReasoningRunsPerBundlePerDay} min={0} max={20} onChange={(v) => set((d) => void (d.bundles.aiReasoningRunsPerBundlePerDay = Math.round(v)))} hint="Your “Think again” does not count." />
          </div>
        </Card>

        <Card title="Scanned packs and copies">
          <div className="stack-sm">
          <Checkbox label="Split a PDF that holds several documents into separate documents" checked={draft.split.enabled} onChange={(v) => set((d) => void (d.split.enabled = v))} />
          <NumberField label="Smallest pack to split (pages)" value={draft.split.minPages} min={2} max={50} onChange={(v) => set((d) => void (d.split.minPages = Math.round(v)))} />
          <NumberField label="How alike two photos must be to count as the same photo (difference, 0–20)" value={draft.duplicates.nearPhotoMaxDistance} min={0} max={20} onChange={(v) => set((d) => void (d.duplicates.nearPhotoMaxDistance = Math.round(v)))} hint="Lower is stricter. A resized copy is usually 6 or less." />
          <NumberField label="How alike two letters must be to count as the same letter (%)" value={draft.duplicates.nearTextMinJaccard} scale={0.01} min={0.5} max={1} onChange={(v) => set((d) => void (d.duplicates.nearTextMinJaccard = v))} />
          </div>
        </Card>

        <Card title="Photo checks">
          <div className="stack-sm">
          <NumberField label="Allow photos taken this long before the accident time (hours)" value={draft.photos.beforeAccidentToleranceHours} min={0} max={72} onChange={(v) => set((d) => void (d.photos.beforeAccidentToleranceHours = v))} hint="Camera clocks are often wrong; earlier photos are only pointed out to you." />
          <NumberField label="Point out a photo taken this far from the others (km)" value={draft.photos.gpsOutlierKm} min={0.1} max={100} step={0.1} onChange={(v) => set((d) => void (d.photos.gpsOutlierKm = v))} />
          </div>
        </Card>

        <Card title=".zip files">
          <div className="stack-sm">
          <NumberField label="Most files in one .zip" value={draft.archives.maxEntries} min={1} max={2000} onChange={(v) => set((d) => void (d.archives.maxEntries = Math.round(v)))} />
          <NumberField label="Most unpacked size (GB)" value={draft.archives.maxTotalBytes} scale={GIB} min={0.01 * GIB} max={2 * GIB} step={0.1} onChange={(v) => set((d) => void (d.archives.maxTotalBytes = Math.round(v)))} />
          <NumberField label=".zip inside .zip, how deep" value={draft.archives.maxDepth} min={0} max={5} onChange={(v) => set((d) => void (d.archives.maxDepth = Math.round(v)))} />
          <NumberField label="Largest compression ratio for one file" value={draft.archives.maxRatio} min={10} max={1000} onChange={(v) => set((d) => void (d.archives.maxRatio = Math.round(v)))} hint="Files that unpack to far more than their packed size are skipped and listed." />
          </div>
        </Card>

        <div className="row">
          <Button variant="primary" onClick={onSave} loading={save.isPending} disabled={!changed}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setDraft(structuredClone(q.data!.defaults))}>
            Back to the defaults
          </Button>
          <Link to="/settings/ai" className="small">
            The model and effort for “read the bundle together” are in Settings &gt; AI
          </Link>
        </div>
      </div>
    </div>
  );
}
