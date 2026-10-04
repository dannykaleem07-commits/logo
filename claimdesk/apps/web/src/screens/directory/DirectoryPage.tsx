import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import '../../styles/screens.css';
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
import { copyForCallText, DIRECTORY_FIELDS, directoryStatus, filterDirectory, hasCopycats, isHttpUrl, ivrPressLine } from './directory';

/**
 * Insurer & authority directory (BLUEPRINT §8). The third-party line is the one a handler dials, so it is the
 * loudest thing on the card; the policyholder line is there only to recognise a wrong number.
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
  const entries = useMemo(() => filterDirectory(directory.data ?? [], q).sort((a, b) => a.name.localeCompare(b.name)), [directory.data, q]);
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
        subtitle="Third-party claims lines, IVR paths and portals. Verification is data: green within 90 days, amber to 180, red after or when a number fails on a call."
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
            <EmptyState title={q ? 'No organisation matches' : 'Directory is empty'}>{q ? 'Try a brand name (e.g. Sheilas’ Wheels → esure) or part of a number.' : 'Entries load from packages/kb/data/insurer-directory.json via the API.'}</EmptyState>
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
      actions={<VerificationBadge verification={entry.verification} />}
    >
      {entry.brands?.length > 0 && <div className="dir-brands">Brands: {entry.brands.join(' · ')}</div>}
      {status.warning && (
        <div className={`notice ${status.tone === 'red' ? 'notice-danger' : 'notice-warn'}`} role="alert">
          <strong>{status.warning}</strong>
        </div>
      )}
      <div className="dir-tp">
        <div className="dir-tp-label">Third-party claims</div>
        {entry.thirdPartyClaimsPhone ? (
          <div className="dir-tp-phone">
            <a href={`tel:${entry.thirdPartyClaimsPhone.replace(/\s+/g, '')}`}>{entry.thirdPartyClaimsPhone}</a>
          </div>
        ) : (
          <div className="dir-ivr muted">No separate third-party line published{entry.policyholderClaimsPhone ? ' — use the claims line below and ask for third-party claims' : ''}.</div>
        )}
        {ivr && (
          <div className="dir-ivr">
            IVR: <strong>{ivr}</strong>
          </div>
        )}
        {entry.openingHours && <div className="dir-ivr">Hours: {entry.openingHours}</div>}
      </div>
      {entry.policyholderClaimsPhone && (
        <div className="dir-ph">
          Policyholder claims line: <span className="num">{entry.policyholderClaimsPhone}</span> <span className="xs muted">(not for third-party claims)</span>
        </div>
      )}
      <dl className="dir-meta">
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
        {entry.portalUrl && (
          <>
            <dt>Portal</dt>
            <dd>
              <a href={entry.portalUrl} target="_blank" rel="noreferrer noopener">
                {entry.portalUrl.replace(/^https?:\/\//, '')}
              </a>
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
        <dt>Verification</dt>
        <dd className="xs">
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
        </dd>
      </dl>
      {entry.verification.sourceNote && <div className="xs muted">{entry.verification.sourceNote}</div>}
      {entry.notes && <div className="small">{entry.notes}</div>}
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
      <div className="dir-actions">
        <Button variant="primary" size="sm" onClick={copy}>
          Copy for call
        </Button>
        <Button size="sm" onClick={onVerify}>
          Mark verified today
        </Button>
        <Button size="sm" variant="ghost" onClick={onFail}>
          Report failed
        </Button>
      </div>
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
      setError(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  };
  return (
    <Modal open title={`Mark ${entry.name} verified today`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!urlOk || !verifiedBy.trim()} loading={verify.isPending}>Mark verified</Button></>}>
      <div className="stack">
        <p className="basis">Only a person with the insurer's own page open can verify a number. Paste the URL you checked it on; the record keeps the URL, today's date and your name (BLUEPRINT §8).</p>
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
      setError(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  };
  return (
    <Modal open title={`Report a failed contact for ${entry.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit} loading={report.isPending}>Report failed</Button></>}>
      <div className="stack">
        <p className="basis">A number or address that fails on a live call is logged and the record goes red (BLUEPRINT §8). Say what happened so the next person knows.</p>
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
