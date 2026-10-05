import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import '../../styles/screens.css';
import './directory.css';
import { isApiError } from '../../api/client';
import { useDirectory, useReportDirectoryFailed, useVerifyDirectoryEntry } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge, VerificationBadge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Select, TextArea, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { DateText } from '../../components/DateText';
import { useToast } from '../../components/Toast';
import { todayISO } from '../../lib/dates';
import { cardBanner, copyForCallText, DIRECTORY_FIELDS, directoryStatus, filterDirectory, hasCopycats, hasMoreDetails, isHttpUrl, ivrPressLine, sortDirectory } from './directory';

/**
 * Insurer & authority directory. Compact cards (0.3 §E3): the third-party line is the one a handler dials, so it is
 * the loudest thing on the card with a Copy button; everything else sits in a closed "More about this insurer".
 */
export function DirectoryPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const directory = useDirectory(debounced);
  const today = todayISO();
  const entries = useMemo(() => sortDirectory(filterDirectory(directory.data ?? [], q)), [directory.data, q]);
  const [verifyFor, setVerifyFor] = useState<InsurerDirectoryEntry | null>(null);
  const [failFor, setFailFor] = useState<InsurerDirectoryEntry | null>(null);

  const counts = useMemo(() => {
    const c = { green: 0, amber: 0, red: 0 };
    for (const e of directory.data ?? []) {
      const t = directoryStatus(e, today).tone;
      if (t === 'green') c.green++;
      else if (t === 'red') c.red++;
      else c.amber++;
    }
    return c;
  }, [directory.data, today]);

  return (
    <div className="page">
      <PageHeader
        title="Directory"
        subtitle="Third-party claims lines, IVR paths and portals. Green: checked in the last 90 days; amber: unverified or older; red: stale or a number failed on a call."
        actions={
          <Link className="btn btn-secondary" to="/watch">
            Counterparty watch
          </Link>
        }
      />
      <Card flush>
        <div className="toolbar">
          <TextInput label="Search" type="search" value={q} onChange={setQ} placeholder="Insurer, brand or number" autoFocus />
          <span className="row xs muted" style={{ paddingBottom: 10 }}>
            <Badge tone="green">{counts.green} verified</Badge>
            <Badge tone="amber">{counts.amber} unverified / ageing</Badge>
            <Badge tone="red">{counts.red} failed / stale</Badge>
          </span>
        </div>
      </Card>
      <div style={{ marginTop: 16 }}>
        {directory.isLoading ? (
          <Loading label="Loading directory…" />
        ) : directory.error ? (
          <ApiErrorNotice error={directory.error} what="load the directory" />
        ) : entries.length === 0 ? (
          <Card>
            <EmptyState title={q ? 'No organisation matches' : 'Directory is empty'}>{q ? 'Try a brand name (e.g. Sheilas’ Wheels → esure) or part of a number.' : 'No insurers are loaded yet.'}</EmptyState>
          </Card>
        ) : (
          <div className="dir-grid">
            {entries.map((e) => (
              <DirectoryCard key={e.id} entry={e} today={today} onVerify={() => setVerifyFor(e)} onFail={() => setFailFor(e)} />
            ))}
          </div>
        )}
      </div>
      <VerifyDialog entry={verifyFor} onClose={() => setVerifyFor(null)} />
      <ReportFailedDialog entry={failFor} onClose={() => setFailFor(null)} />
    </div>
  );
}

function DirectoryCard({ entry, today, onVerify, onFail }: { entry: InsurerDirectoryEntry; today: string; onVerify: () => void; onFail: () => void }) {
  const toast = useToast();
  const status = directoryStatus(entry, today);
  const banner = cardBanner(status);
  const ivr = ivrPressLine(entry.thirdPartyIvrPath);
  const copy = async () => {
    const text = copyForCallText(entry);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied for the call');
    } catch {
      window.prompt('Copy for the call:', text);
    }
  };
  return (
    <Card
      className="dir-card"
      title={
        <span className="row" style={{ gap: 8 }}>
          {entry.name}
          <Badge tone={status.tone} dot title={status.warning}>
            {status.label}
          </Badge>
        </span>
      }
    >
      {banner && (
        <div className="notice notice-danger" role="alert">
          <strong>{banner}</strong>
        </div>
      )}
      <div className="dir-tp">
        <div className="dir-tp-label">Third-party claims</div>
        <div className="dir-tp-row">
          {entry.thirdPartyClaimsPhone ? (
            <div className="dir-tp-phone">
              <a href={`tel:${entry.thirdPartyClaimsPhone.replace(/\s+/g, '')}`}>{entry.thirdPartyClaimsPhone}</a>
            </div>
          ) : (
            <div className="dir-ivr muted">No separate third-party line published{entry.policyholderClaimsPhone ? ` — ring ${entry.policyholderClaimsPhone} and ask for third-party claims` : ''}.</div>
          )}
          <Button size="sm" variant="primary" onClick={copy} title="Copy the name, number, menu options and hours for the call">
            Copy
          </Button>
        </div>
        {ivr && (
          <div className="dir-ivr">
            Menu: <strong>{ivr}</strong>
            {entry.openingHours ? <span className="muted"> · {entry.openingHours}</span> : null}
          </div>
        )}
        {!ivr && entry.openingHours && <div className="dir-ivr muted">{entry.openingHours}</div>}
      </div>
      {entry.portalUrl && (
        <div className="small">
          Portal:{' '}
          <a href={entry.portalUrl} target="_blank" rel="noreferrer noopener">
            {entry.portalUrl.replace(/^https?:\/\//, '')}
          </a>
        </div>
      )}
      {hasCopycats(entry) && (
        <div className="dir-copycat" role="note">
          <strong>Copycat warning</strong> — claims-management lookalikes. Never dial or email these:
          <ul>
            {entry.copycatNumbers.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {entry.copycatDomains.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="dir-more">
        <summary>More about this insurer</summary>
        <div className="stack-sm">
          {hasMoreDetails(entry) && (
            <dl className="dir-meta">
              {entry.brands?.length > 0 && (
                <>
                  <dt>Brands</dt>
                  <dd>{entry.brands.join(' · ')}</dd>
                </>
              )}
              {entry.policyholderClaimsPhone && (
                <>
                  <dt>Policyholder line</dt>
                  <dd>
                    <span className="num">{entry.policyholderClaimsPhone}</span> <span className="xs muted">(not for third-party claims)</span>
                  </dd>
                </>
              )}
              {entry.thirdPartyEmail && (
                <>
                  <dt>Third-party email</dt>
                  <dd>
                    <a href={`mailto:${entry.thirdPartyEmail}`}>{entry.thirdPartyEmail}</a>
                  </dd>
                </>
              )}
              {entry.claimsEmail && (
                <>
                  <dt>Claims email</dt>
                  <dd>
                    <a href={`mailto:${entry.claimsEmail}`}>{entry.claimsEmail}</a>
                  </dd>
                </>
              )}
              {entry.complaintsEmail && (
                <>
                  <dt>Complaints</dt>
                  <dd>
                    <a href={`mailto:${entry.complaintsEmail}`}>{entry.complaintsEmail}</a>
                  </dd>
                </>
              )}
              {entry.postalAddress && (
                <>
                  <dt>Address</dt>
                  <dd>{entry.postalAddress}</dd>
                </>
              )}
              {entry.group && (
                <>
                  <dt>Group</dt>
                  <dd className="xs muted">{entry.group}</dd>
                </>
              )}
            </dl>
          )}
          <div className="xs">
            Checked:{' '}
            {entry.verification.verifiedAt ? (
              <>
                <DateText value={entry.verification.verifiedAt} />
                {entry.verification.verifiedBy ? ` by ${entry.verification.verifiedBy}` : ''}
              </>
            ) : (
              'never'
            )}
            {entry.verification.sourceUrl && (
              <>
                {' · '}
                <a href={entry.verification.sourceUrl} target="_blank" rel="noreferrer noopener">
                  source
                </a>
              </>
            )}
            {entry.lastUsedOk && (
              <>
                {' · '}last worked <DateText value={entry.lastUsedOk} />
              </>
            )}
            {entry.lastFailed && (
              <>
                {' · '}
                <span className="bad-mark">
                  failed <DateText value={entry.lastFailed} />
                </span>
              </>
            )}
          </div>
          {entry.verification.sourceNote && <div className="xs muted">{entry.verification.sourceNote}</div>}
          {entry.notes && <div className="small">{entry.notes}</div>}
          <div className="dir-actions">
            <Button size="sm" onClick={onVerify}>
              Mark verified today
            </Button>
            <Button size="sm" variant="ghost" onClick={onFail}>
              Report failed
            </Button>
          </div>
        </div>
      </details>
    </Card>
  );
}

function VerifyDialog({ entry, onClose }: { entry: InsurerDirectoryEntry | null; onClose: () => void }) {
  const toast = useToast();
  const verify = useVerifyDirectoryEntry();
  const [sourceUrl, setSourceUrl] = useState('');
  const [verifiedBy, setVerifiedBy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (entry) {
      setSourceUrl(entry.verification.sourceUrl ?? '');
      setVerifiedBy('');
      setNote('');
      setError(null);
    }
  }, [entry]);
  if (!entry) return null;
  const urlOk = isHttpUrl(sourceUrl);
  const submit = async () => {
    if (!urlOk || !verifiedBy.trim()) return;
    try {
      await verify.mutateAsync({ id: entry.id, body: { sourceUrl: sourceUrl.trim(), verifiedBy: verifiedBy.trim(), note: note.trim() || undefined } });
      toast.success(`${entry.name} marked verified today`);
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : (e as Error).message);
    }
  };
  return (
    <Modal open title={`Mark ${entry.name} verified today`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!urlOk || !verifiedBy.trim()} loading={verify.isPending}>Mark verified</Button></>}>
      <div className="stack">
        <p className="basis">Only a person with the insurer's own page open can verify a number. Paste the URL you checked it on; the record keeps the URL, today's date and your name.</p>
        <TextInput label="Source URL (the insurer's own site)" type="url" value={sourceUrl} onChange={setSourceUrl} placeholder="https://www.insurer.co.uk/claims/not-a-customer" required error={sourceUrl && !urlOk ? 'Enter a full http(s) URL' : undefined} autoFocus />
        <TextInput label="Verified by" value={verifiedBy} onChange={setVerifiedBy} placeholder="Your name or initials" required />
        <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} placeholder="e.g. IVR confirmed on call 4 Oct: option 2 then 3" />
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReportFailedDialog({ entry, onClose }: { entry: InsurerDirectoryEntry | null; onClose: () => void }) {
  const toast = useToast();
  const report = useReportDirectoryFailed();
  const [field, setField] = useState<string>('thirdPartyClaimsPhone');
  const [note, setNote] = useState('');
  const [reportedBy, setReportedBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (entry) {
      setField('thirdPartyClaimsPhone');
      setNote('');
      setReportedBy('');
      setError(null);
    }
  }, [entry]);
  if (!entry) return null;
  const submit = async () => {
    try {
      await report.mutateAsync({ id: entry.id, body: { field, note: note.trim() || undefined, reportedBy: reportedBy.trim() || undefined } });
      toast.warn(`${entry.name} marked failed — record is red until re-verified`);
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : (e as Error).message);
    }
  };
  return (
    <Modal open title={`Report a failed contact for ${entry.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit} loading={report.isPending}>Report failed</Button></>}>
      <div className="stack">
        <p className="basis">A number or address that fails on a live call is logged and the record goes red until someone re-checks it. Say what happened so the next person knows.</p>
        <Select label="What failed" value={field} onChange={(v) => v && setField(v)} options={DIRECTORY_FIELDS.map((f) => ({ value: String(f.value), label: f.label }))} />
        <TextArea label="What happened" value={note} onChange={setNote} rows={3} placeholder="e.g. number unobtainable 4 Oct 14:10; or menu has changed — option 3 is now home claims" autoFocus />
        <TextInput label="Reported by" value={reportedBy} onChange={setReportedBy} placeholder="Your name or initials" />
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
