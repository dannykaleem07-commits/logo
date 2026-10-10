// owned by casework
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Checkbox, TextInput } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { BUSINESS_LABEL, brainApi, useBrainMutation, type Business, type PackPreview } from '../../../api/brainApi';
import { formErrors, initialForm, needsCcgukTick } from './brainView';

/** Choose business tags, precedence and the CCGUK tick, then activate a version (§E.5 "preview → choose → activate"). */
export function ActivateForm({ preview, useForCcguk = false, label = 'Activate', onDone }: { preview: PackPreview; useForCcguk?: boolean; label?: string; onDone?: () => void }) {
  const [form, setForm] = useState(() => initialForm(preview, useForCcguk));
  const [touched, setTouched] = useState(false);
  const activate = useBrainMutation(() => brainApi.activate(preview.packId, { version: preview.version, business: form.business, precedence: Number(form.precedence), useForCcguk: form.useForCcguk }));
  const errors = touched ? formErrors(form) : {};
  const toggle = (b: Business, on: boolean) => setForm((f) => ({ ...f, business: on ? [...new Set([...f.business, b])] : f.business.filter((x) => x !== b) }));
  return (
    <div className="stack-sm">
      <div className="row">
        {(Object.keys(BUSINESS_LABEL) as Business[]).map((b) => (
          <Checkbox key={b} label={BUSINESS_LABEL[b]} checked={form.business.includes(b)} onChange={(v) => toggle(b, v)} />
        ))}
      </div>
      {errors.business && <div className="small" role="alert">{errors.business}</div>}
      <TextInput label="Precedence" hint="Lower wins: your CCGUK rules (30) come before a playbook (40)." value={form.precedence} onChange={(v) => setForm((f) => ({ ...f, precedence: v }))} error={errors.precedence} />
      {needsCcgukTick(form.business) && (
        <Checkbox
          label="Use this pack’s strategy for CCGUK claims"
          hint="Off: Fixmyfile-only strategy (for example the consumer ombudsman route) never reaches a CCGUK letter."
          checked={form.useForCcguk}
          onChange={(v) => setForm((f) => ({ ...f, useForCcguk: v }))}
        />
      )}
      <div className="row">
        <Button
          variant="primary"
          loading={activate.isPending}
          onClick={() => {
            setTouched(true);
            if (Object.keys(formErrors(form)).length) return;
            void activate
              .mutateAsync(undefined)
              .then(() => onDone?.())
              .catch(() => undefined);
          }}
        >
          {label} {preview.version}
        </Button>
      </div>
      <ApiErrorNotice error={activate.error} what="activate the pack" />
    </div>
  );
}
