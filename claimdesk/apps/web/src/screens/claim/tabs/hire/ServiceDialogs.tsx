/** Storage and recovery dialogs on the Hire tab. */
import { useState } from 'react';
import { useStableCallback } from './useStableCallback';
import type { RecoveryRecord, StorageRecord } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { usePostRecovery, usePostStorage, useEndStorage } from '../../../../api/hooks';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { Button } from '../../../../components/Button';
import { DateTimeInput, MoneyInput, Select, TextArea, TextInput } from '../../../../components/Form';
import { Modal } from '../../../../components/Modal';
import { useToast } from '../../../../components/Toast';
import type { ClaimView } from '../../claimFile';
import { EvidencePicker } from '../../components/EvidencePicker';
import { endStorageBodyFrom, recoveryBodyFrom, recoveryTotals, STORAGE_TRIGGERS, storageBodyFrom, type EndStorageForm, type RecoveryForm, type StorageEndTrigger, type StorageForm } from '../../lib/hire';

export function EndStorageDialog({ claimId, storage, nowIso, onClose }: { claimId: string; storage: StorageRecord | null; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<EndStorageForm>({ endTrigger: '', endAt: nowIso, reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const end = useEndStorage(claimId);
  const toast = useToast();
  const trigger = STORAGE_TRIGGERS.find((t) => t.value === form.endTrigger);
  const close = useStableCallback(() => {
    setForm({ endTrigger: '', endAt: nowIso, reason: '' });
    setErrors({});
    end.reset();
    onClose();
  });
  const submit = () => {
    if (!storage) return;
    const r = endStorageBodyFrom(form, storage, new Date().toISOString());
    if (!r.ok) return setErrors(r.errors);
    end.mutate(
      { storageId: storage.id, body: r.body },
      {
        onSuccess: () => {
          toast.success('Storage ended');
          close();
        }
      }
    );
  };
  return (
    <Modal
      open={storage !== null}
      title={`End storage at ${storage?.location ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={end.isPending} onClick={submit}>
            End storage
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select<StorageEndTrigger> label="What ended the storage" required value={form.endTrigger} onChange={(v) => setForm((f) => ({ ...f, endTrigger: v }))} options={STORAGE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))} placeholder="Choose the trigger…" error={errors.endTrigger} autoFocus />
        {trigger && <div className="notice notice-info xs">{trigger.basis}</div>}
        <DateTimeInput label="Storage ended at" required value={form.endAt} onChange={(v) => setForm((f) => ({ ...f, endAt: v }))} error={errors.endAt} />
        <TextArea label={form.endTrigger === 'manual' ? 'Reason (required)' : 'Note'} value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} rows={2} error={errors.reason} />
        <ApiErrorNotice error={end.error} what="end the storage" />
      </form>
    </Modal>
  );
}

export function AddStorageDialog({ claimId, open, nowIso, onClose }: { claimId: string; open: boolean; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<StorageForm>({ location: '', startAt: nowIso, dailyRatePence: null });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const post = usePostStorage(claimId);
  const toast = useToast();
  const close = useStableCallback(() => {
    setForm({ location: '', startAt: nowIso, dailyRatePence: null });
    setErrors({});
    post.reset();
    onClose();
  });
  const submit = () => {
    const r = storageBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success('Storage started');
        close();
      }
    });
  };
  return (
    <Modal
      open={open}
      title="Add storage"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={post.isPending} onClick={submit}>
            Start storage
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextInput label="Location" required value={form.location} onChange={(v) => setForm((f) => ({ ...f, location: v }))} error={errors.location} autoFocus placeholder="Yard name and postcode" />
        <DateTimeInput label="Storage starts" required value={form.startAt} onChange={(v) => setForm((f) => ({ ...f, startAt: v }))} error={errors.startAt} />
        <MoneyInput label="Daily rate (£ ex VAT)" value={form.dailyRatePence} onChange={(v) => setForm((f) => ({ ...f, dailyRatePence: v }))} error={errors.dailyRatePence} hint="Blank = rate card (£45/day)" />
        <ApiErrorNotice error={post.error} what="start storage" />
      </form>
    </Modal>
  );
}

export function AddRecoveryDialog({ claimId, view, open, nowIso, onClose }: { claimId: string; view: ClaimView; open: boolean; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<RecoveryForm>({ at: nowIso, fromLocation: '', toLocation: '', loadedMiles: '', evidenceIds: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const post = usePostRecovery(claimId);
  const toast = useToast();
  const close = useStableCallback(() => {
    setForm({ at: nowIso, fromLocation: '', toLocation: '', loadedMiles: '', evidenceIds: [] });
    setErrors({});
    post.reset();
    onClose();
  });
  const submit = () => {
    const r = recoveryBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success('Recovery recorded and claimed on the ledger');
        close();
      }
    });
  };
  const miles = Number(form.loadedMiles);
  const preview = Number.isFinite(miles) && miles >= 0 ? recoveryTotals({ loadedMiles: miles } as RecoveryRecord) : undefined;
  return (
    <Modal
      open={open}
      title="Add recovery"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={post.isPending} onClick={submit}>
            Record recovery
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DateTimeInput label="Recovered at" required value={form.at} onChange={(v) => setForm((f) => ({ ...f, at: v }))} error={errors.at} />
        <div className="form-grid">
          <TextInput label="From" required value={form.fromLocation} onChange={(v) => setForm((f) => ({ ...f, fromLocation: v }))} error={errors.fromLocation} autoFocus />
          <TextInput label="To" required value={form.toLocation} onChange={(v) => setForm((f) => ({ ...f, toLocation: v }))} error={errors.toLocation} />
        </div>
        <TextInput label="Loaded miles" required value={form.loadedMiles} onChange={(v) => setForm((f) => ({ ...f, loadedMiles: v }))} inputMode="decimal" error={errors.loadedMiles} hint={preview ? `Rate card: ${formatGBP(preview.netPence)} net, ${formatGBP(preview.grossPence)} gross (£90 + £3/mile + £25 + VAT)` : undefined} />
        <EvidencePicker label="Recovery sheet / photos" evidence={view.evidence} value={form.evidenceIds} onChange={(ids) => setForm((f) => ({ ...f, evidenceIds: ids }))} />
        <ApiErrorNotice error={post.error} what="record the recovery" />
      </form>
    </Modal>
  );
}
