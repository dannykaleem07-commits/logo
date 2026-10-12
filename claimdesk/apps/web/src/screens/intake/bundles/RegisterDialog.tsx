// owned by intake-web
/**
 * Register dialog (docs/SMART-INTAKE.md §11.4): what one click will do (creates the claim, files the documents — copies
 * not filed twice — adds the ticked chronology entries, records photo damage, prepares the request for missing
 * documents for your approval, and what happens to the other groups), the owner blockers with links, a choice per
 * other group, and Register. A refusal (409 with blockers, 400 FNOL incomplete) is shown in the dialog.
 */
import { useState } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Checkbox, Select } from '../../../components/Form';
import { Modal } from '../../../components/Modal';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { isApiError } from '../../../api/client';
import type { Blocker, BundleDetail, GroupAction, RegisterBody, RegisterResult } from '../../../api/bundlesApi';
import { BLOCKER_ANCHOR, defaultGroupActions, GROUP_ACTION_LABEL, ownerBlockers, registerTitle, willDoLines } from './bundleModel';

function blockersFromError(e: unknown): Blocker[] {
  if (!isApiError(e)) return [];
  const d = e.details as { blockers?: Blocker[] } | undefined;
  return Array.isArray(d?.blockers) ? d!.blockers : [];
}

export function RegisterDialog({
  open,
  detail,
  onClose,
  onRegister,
}: {
  open: boolean;
  detail: BundleDetail;
  onClose: () => void;
  onRegister: (body: RegisterBody) => Promise<RegisterResult>;
}) {
  const [actions, setActions] = useState<Record<string, GroupAction>>(() => defaultGroupActions(detail.groups));
  const [requestDocs, setRequestDocs] = useState(true);
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const blockers = ownerBlockers(detail.register.blockers);
  const matches = detail.register.blockers.some((b) => b.code === 'MATCHES_EXISTING_CLAIM');
  const others = detail.groups.filter((g) => g.kind !== 'main' && g.kind !== 'excluded' && g.fileIds.length > 0);
  const missing = detail.checklist.items.filter((i) => i.status === 'missing' || i.status === 'partial').length;
  const refused = blockersFromError(error);
  const canSubmit = detail.register.canRegister || (matches && confirmNew && blockers.every((b) => b.code === 'MATCHES_EXISTING_CLAIM'));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: RegisterBody = { acceptPreselected: false, requestMissingDocs: requestDocs, ...(Object.keys(actions).length ? { groups: actions } : {}), ...(matches && confirmNew ? { confirmNew: true } : {}) };
      await onRegister(body);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={registerTitle(detail)}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Not yet
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!canSubmit}>
            Register
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <ul className="bdl-willdo">
          {willDoLines(detail).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {blockers.length > 0 && (
          <div className="notice notice-warn">
            <strong>Before you can register:</strong>
            <ul>
              {blockers.map((b) => (
                <li key={b.code}>
                  {b.text}{' '}
                  {BLOCKER_ANCHOR[b.code] && (
                    <a href={BLOCKER_ANCHOR[b.code]} onClick={onClose}>
                      show me
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {matches && <Checkbox label="This is a new claim, not the one it looks like" checked={confirmNew} onChange={setConfirmNew} />}
        {others.length > 0 && (
          <div className="stack-sm">
            <h4 className="bdl-subhead">The other files</h4>
            {others.map((g) => {
              const opts: Array<{ value: GroupAction; label: string }> = [
                { value: 'split_off', label: GROUP_ACTION_LABEL.split_off },
                ...(g.kind === 'existing_claim' && g.claim ? [{ value: 'attach' as const, label: `File them on ${g.claim.reference}` }] : []),
                { value: 'exclude', label: GROUP_ACTION_LABEL.exclude },
              ];
              return (
                <Select<GroupAction>
                  key={g.key}
                  label={`${g.label} (${g.fileIds.length} ${g.fileIds.length === 1 ? 'file' : 'files'})`}
                  value={actions[g.key] ?? 'split_off'}
                  onChange={(v) => setActions((a) => ({ ...a, [g.key]: (v || 'split_off') as GroupAction }))}
                  options={opts}
                />
              );
            })}
          </div>
        )}
        {missing > 0 && (
          <Checkbox
            label={`Prepare a request to the client for the ${missing} missing ${missing === 1 ? 'document' : 'documents'}`}
            hint="It waits for your approval in Needs you; nothing is sent on its own."
            checked={requestDocs}
            onChange={setRequestDocs}
          />
        )}
        {detail.register.fnolWarnings.length > 0 && (
          <div className="small muted">
            For the first call: {detail.register.fnolWarnings.join(' ')}
          </div>
        )}
        {refused.length > 0 ? (
          <div className="notice notice-danger" role="alert">
            <strong>Not registered yet:</strong>
            <ul>
              {refused.map((b) => (
                <li key={b.code}>
                  {b.text} {b.for === 'auto' && <Badge tone="grey">automatic only</Badge>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ApiErrorNotice error={error} what="register the claim" />
        )}
      </div>
    </Modal>
  );
}
