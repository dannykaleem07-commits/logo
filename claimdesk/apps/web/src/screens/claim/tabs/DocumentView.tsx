import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ConsistencyFlag, GeneratedDocument } from '@ccguk/domain';
import { api, type SignStartResult } from '../../../api/client';
import { useApproveDocument, useClearFlag, useDocument, useSendDocument, useStartSign, useSupersedeDocument, useVerifySign } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Badge, DocumentStatusBadge, SeverityBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KeyValue } from '../../../components/KeyValue';
import { DateText } from '../../../components/DateText';
import { DateInput, Select, TextArea, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { todayISO } from '../../../lib/dates';
import type { ClaimView } from '../claimFile';
import { ReasonDialog } from '../components/ReasonDialog';
import { shortHash } from '../lib/evidence';
import { approvalBlocker, approveLabel, canSend, canSign, consistencyCodeLabel, docxValuesUsed, flagCounts, canComposeLetterhead, hasApprovedPdf, isBlocked, isDocx, isHtmlLetter, pdfConverterNote, SEND_VIA_OPTIONS, supersedeBodyFrom } from '../lib/documents';
import { templatesApi } from '../../../api/templatesApi';
import { DocxPreview } from '../components/DocxPreview';
import { useManagerMode } from '../../../app/managerMode';
import { GTA_BENCHMARK_CAVEAT, originLabel } from '../lib/fillValues';
import { KnowledgeUsedPanel } from '../../knowledge/KnowledgeUsedPanel'; // knowledge-ui

type Dialog = 'send' | 'sign' | 'supersede' | null;

/** One generated document: HTML preview, consistency report with clear-with-reason, approve / send / sign / supersede. */
export function DocumentView({ view }: { view: ClaimView }) {
  const { docId } = useParams();
  const claimId = view.claim.id;
  const docQ = useDocument(docId);
  const fallback = view.documents.find((d) => d.id === docId);
  const doc = docQ.data ?? fallback;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [clearing, setClearing] = useState<{ flag: ConsistencyFlag; index: number } | null>(null);
  const approve = useApproveDocument(docId ?? '', claimId);
  const managerOn = useManagerMode().on;
  const clear = useClearFlag(docId ?? '', claimId);
  const toast = useToast();
  // fetched (not a plain link) so a refusal — e.g. a letter made with a layout that does not mark its parts — is shown
  const downloadLetterhead = async () => {
    if (!doc) return;
    try {
      const res = await fetch(templatesApi.documentLetterheadDocxUrl(doc.id), { credentials: 'include' });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          /* not JSON */
        }
        toast.error(`The letterhead copy could not be made: ${message}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${doc.title}.docx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error(`The letterhead copy could not be made: ${(e as Error).message}`);
    }
  };

  if (!docId) return <EmptyState title="No document selected" />;
  if (docQ.isLoading && !doc) return <Loading label="Loading document…" />;
  if (!doc) {
    return (
      <Card>
        <ApiErrorNotice error={docQ.error} what="load the document" />
        <EmptyState title="Document not found" action={<Link className="btn btn-secondary btn-sm" to="../documents">Back to documents</Link>} />
      </Card>
    );
  }

  const blocked = isBlocked(doc);
  const blocker = approvalBlocker(doc, { managerOn });
  const approveText = approveLabel(doc, { managerOn });
  const counts = flagCounts(doc.consistency);
  const supersededBy = view.documents.find((d) => d.supersedesId === doc.id);
  const certificateDoc = doc.signature ? view.documents.find((d) => d.id === doc.signature?.certificateId) : undefined;
  const docx = isDocx(doc);
  const converterNote = pdfConverterNote(doc);

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn btn-ghost btn-sm" to="../documents">
              ← Documents
            </Link>
            <h2 style={{ fontSize: 'var(--fs-lg)' }}>{doc.title}</h2>
            <DocumentStatusBadge status={doc.status} />
            {doc.reExecutedOn && <Badge tone="amber">re-executed {doc.reExecutedOn}</Badge>}
            {docx && <Badge tone="blue">Word</Badge>}
            {converterNote && <Badge tone="green">{converterNote}</Badge>}
          </div>
          <div className="xs muted" style={{ marginTop: 4 }}>
            <span className="mono">
              {doc.templateId} v{doc.templateVersion}
            </span>{' '}
            · created <DateText value={doc.createdAt} time /> by {doc.createdBy} · hash{' '}
            <span className="hash" title={doc.sha256}>
              {shortHash(doc.sha256, 16)}
            </span>
            {doc.supersedesId && (
              <>
                {' '}
                · supersedes <Link to={`../documents/${doc.supersedesId}`}>{doc.supersedesId}</Link>
              </>
            )}
          </div>
        </div>
        <div className="row">
          {docx ? (
            <>
              <a className="btn btn-secondary btn-sm" href={templatesApi.documentDocxUrl(doc.id)} download>
                Download Word (.docx)
              </a>
              {hasApprovedPdf(doc) ? (
                <a className="btn btn-secondary btn-sm" href={api.documentPdfUrl(doc.id)} target="_blank" rel="noreferrer">
                  Download PDF
                </a>
              ) : (
                <span className="xs muted">The PDF is made when the document is approved</span>
              )}
            </>
          ) : hasApprovedPdf(doc) ? (
            <a className="btn btn-secondary btn-sm" href={api.documentPdfUrl(doc.id)} target="_blank" rel="noreferrer">
              PDF
            </a>
          ) : (
            <span className="xs muted">The PDF is made when the document is approved</span>
          )}
          {canComposeLetterhead(doc) && (
            <Button size="sm" variant="secondary" title="The same letter recomposed on the CCGUK letterhead as a Word file" onClick={() => void downloadLetterhead()}>
              Download on letterhead (Word)
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={Boolean(blocker)}
            title={blocker ?? (approveText !== 'Approve' ? 'Manager mode: each open block flag is cleared with your reason, then the document is approved' : undefined)}
            loading={approve.isPending}
            onClick={() =>
              approve.mutate(undefined, {
                onSuccess: () => toast.success('Approved — it can now be sent')
              })
            }
          >
            {approveText}
          </Button>
          <Button size="sm" disabled={!canSend(doc)} title={canSend(doc) ? undefined : 'Approve first'} onClick={() => setDialog('send')}>
            Send…
          </Button>
          {canSign(doc) && (
            <Button size="sm" onClick={() => setDialog('sign')}>
              Sign (OTP)…
            </Button>
          )}
          {!supersededBy && doc.status !== 'void' && (
            <Button size="sm" variant="ghost" onClick={() => setDialog('supersede')}>
              Supersede / re-execute…
            </Button>
          )}
        </div>
      </div>

      <StepList doc={doc} blocked={blocked} />
      {blocked && managerOn && !blocker && (
        <div className="manager-note" role="status">
          <strong>Manager mode.</strong> {counts.blocking} block flag{counts.blocking === 1 ? '' : 's'} will be cleared with your reason (recorded on each flag and in the audit log), then the document is approved. Read any flag about regulated status or old company details first.
        </div>
      )}
      {blocker && doc.status !== 'approved' && doc.status !== 'sent' && doc.status !== 'signed' && (
        <div className={`notice ${blocked ? 'notice-danger' : 'notice-info'}`} role={blocked ? 'alert' : undefined}>
          <strong>{blocked ? 'Approval blocked.' : 'Not yet approvable.'}</strong> {blocker}
        </div>
      )}
      {supersededBy && (
        <div className="notice notice-warn">
          This version was superseded by <Link to={`../documents/${supersededBy.id}`}>{supersededBy.title}</Link> ({supersededBy.reExecutedOn ? `re-executed ${supersededBy.reExecutedOn}` : supersededBy.createdAt.slice(0, 10)}).
        </div>
      )}
      <ApiErrorNotice error={approve.error} what="approve the document" />
      <ApiErrorNotice error={docQ.error} what="refresh the document" />

      <div className="doc-layout">
        <Card title="Preview" flush actions={<span className="xs muted">{docx ? 'Word document · the PDF is made on approval and is then the hashed artefact' : 'rendered HTML · letterhead palette · PDF is the hashed artefact'}</span>}>
          {docx ? (
            <DocxPreview docId={doc.id} title={doc.title} fallbackHtml={doc.html} />
          ) : doc.html ? (
            <iframe className="doc-frame" title={`${doc.title} preview`} srcDoc={doc.html} sandbox="" />
          ) : (
            <EmptyState title="No HTML in this response">Open the PDF, or reload: the bundle omits document bodies.</EmptyState>
          )}
        </Card>
        <div className="stack">
          <Card
            title="Consistency report"
            flush
            actions={
              <span className="row" style={{ gap: 4 }}>
                {counts.blocking > 0 && <Badge tone="red" dot>{counts.blocking} blocking</Badge>}
                {counts.warn > 0 && <Badge tone="amber">{counts.warn} warn</Badge>}
                {counts.info > 0 && <Badge tone="blue">{counts.info} info</Badge>}
                {doc.consistency && counts.total === 0 && <Badge tone="green">clean</Badge>}
              </span>
            }
          >
            {!doc.consistency ? (
              <EmptyState title="Not checked yet">The API runs the position-consistency engine when the draft is created.</EmptyState>
            ) : (
              <>
                <div className="xs muted" style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                  Checked <DateText value={doc.consistency.checkedAt} time /> against the ledger, the offers log, hire and storage records, the clocks and prior outgoing letters.
                </div>
                {doc.consistency.flags.length === 0 && <EmptyState title="No flags">Every amount, date and assertion matches the file.</EmptyState>}
                {doc.consistency.flags.map((f, i) => (
                  <div key={`${f.code}-${i}`} className={`consistency-flag ${f.severity} ${f.clearedAt ? 'cleared' : ''}`}>
                    <div className="row-between">
                      <span className="row" style={{ gap: 6 }}>
                        <SeverityBadge severity={f.severity} />
                        <strong>{consistencyCodeLabel(f.code)}</strong>
                      </span>
                      {!f.clearedAt && (
                        <Button size="sm" variant={f.severity === 'block' ? 'danger' : 'secondary'} onClick={() => setClearing({ flag: f, index: i })}>
                          Clear with reason
                        </Button>
                      )}
                    </div>
                    <div style={{ marginTop: 4 }}>{f.message}</div>
                    {(f.draftValue || f.ledgerValue) && (
                      <dl className="values">
                        <dt>Draft says</dt>
                        <dd>{f.draftValue ?? '—'}</dd>
                        <dt>Ledger / file</dt>
                        <dd>{f.ledgerValue ?? '—'}</dd>
                      </dl>
                    )}
                    {f.excerpt && <div className="excerpt">“{f.excerpt}”</div>}
                    {f.clearedAt && (
                      <div className="xs muted" style={{ marginTop: 6 }}>
                        Cleared <DateText value={f.clearedAt} time /> by {f.clearedBy}: {f.clearedReason}
                      </div>
                    )}
                    <div className="xs mono muted" style={{ marginTop: 4 }}>
                      {f.code}
                    </div>
                  </div>
                ))}
              </>
            )}
          </Card>

          {docx && <ValuesUsedCard doc={doc} />}

          <KnowledgeUsedPanel targetKind={docx ? 'docx' : 'document'} targetId={doc.id} card />

          <Card title="Record">
            <KeyValue
              items={[
                { label: 'Recipient', value: doc.recipientPartyId ? ([view.atFaultInsurer, view.claimant, view.driver, ...view.thirdParties].find((p) => p?.id === doc.recipientPartyId)?.name ?? doc.recipientPartyId) : '—' },
                { label: 'Approved', value: doc.approvedAt ? <span><DateText value={doc.approvedAt} time /> by {doc.approvedBy}</span> : 'Not yet' },
                { label: 'Sent', value: doc.sentAt ? <span><DateText value={doc.sentAt} time /> via {doc.sentVia}</span> : 'Not sent — nothing is sent automatically' },
                {
                  label: 'Signature',
                  value: doc.signature ? (
                    <div className="xs">
                      {doc.signature.signerName} · {doc.signature.otpChannel} OTP verified <DateText value={doc.signature.otpVerifiedAt} time /> · signed <DateText value={doc.signature.signedAt} time />
                      <div className="muted">
                        IP {doc.signature.ipAddress} · hash <span className="hash" title={doc.signature.documentSha256}>{shortHash(doc.signature.documentSha256)}</span>
                      </div>
                      <div>
                        {certificateDoc ? (
                          <Link to={`../documents/${certificateDoc.id}`}>Completion certificate</Link>
                        ) : (
                          <a href={api.documentPdfUrl(doc.signature.certificateId)} target="_blank" rel="noreferrer">
                            Completion certificate
                          </a>
                        )}
                      </div>
                    </div>
                  ) : canSign(doc) ? (
                    'Ready to sign'
                  ) : (
                    '—'
                  )
                }
              ]}
            />
            <details style={{ marginTop: 10 }}>
              <summary className="xs muted" style={{ cursor: 'pointer' }}>
                Data snapshot the template rendered from
              </summary>
              <pre className="xs" style={{ maxHeight: 260, overflow: 'auto', background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>{JSON.stringify(doc.dataSnapshot, null, 2)}</pre>
            </details>
          </Card>
        </div>
      </div>

      <ReasonDialog
        open={clearing !== null}
        title={`Clear ${clearing ? consistencyCodeLabel(clearing.flag.code) : ''}`}
        danger={clearing?.flag.severity === 'block'}
        busy={clear.isPending}
        error={clear.error}
        onClose={() => {
          setClearing(null);
          clear.reset();
        }}
        onConfirm={(reason) => {
          if (!clearing) return;
          clear.mutate(
            { code: clearing.flag.code, reason, index: clearing.index },
            {
              onSuccess: () => {
                toast.success('Flag cleared — reason logged');
                setClearing(null);
              }
            }
          );
        }}
      >
        {clearing && (
          <div className={`consistency-flag ${clearing.flag.severity}`} style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
            <div>{clearing.flag.message}</div>
            {(clearing.flag.draftValue || clearing.flag.ledgerValue) && (
              <dl className="values">
                <dt>Draft says</dt>
                <dd>{clearing.flag.draftValue ?? '—'}</dd>
                <dt>Ledger / file</dt>
                <dd>{clearing.flag.ledgerValue ?? '—'}</dd>
              </dl>
            )}
          </div>
        )}
        {clearing?.flag.severity === 'block' && <p className="small">If the ledger is right, fix the draft (regenerate) instead of clearing. Clear only when the file, not the letter, is wrong — and say why.</p>}
      </ReasonDialog>

      {dialog === 'send' && <SendDialog doc={doc} claimId={claimId} onClose={() => setDialog(null)} />}
      {dialog === 'sign' && <SignDialog doc={doc} view={view} onClose={() => setDialog(null)} />}
      {dialog === 'supersede' && <SupersedeDialog doc={doc} view={view} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** What the Word document printed in each blank and where each value came from (`dataSnapshot._docx.values`). */
function ValuesUsedCard({ doc }: { doc: GeneratedDocument }) {
  const values = docxValuesUsed(doc);
  const printed = values.filter((v) => v.display);
  const gta = values.some((v) => /gta/i.test(v.key ?? '') && v.display);
  return (
    <Card title="Values used" flush actions={<span className="xs muted">{printed.length} of {values.length} blanks filled</span>}>
      {values.length === 0 ? (
        <EmptyState title="No values recorded">This document carries no record of the values it was filled with.</EmptyState>
      ) : (
        <details open={values.length <= 40}>
          <summary className="xs muted" style={{ cursor: 'pointer', padding: '8px 16px' }}>
            Show every blank
          </summary>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {values.map((v) => (
              <div key={v.slotId} className="consistency-flag">
                <div className="row-between">
                  <strong className="small">{v.label}</strong>
                  <span className="row" style={{ gap: 4 }}>
                    <Badge tone={v.origin === 'none' ? 'grey' : v.origin === 'handler' ? 'blue' : 'green'}>{originLabel(v.origin)}</Badge>
                    {v.verification && <Badge tone={v.verification === 'verified' ? 'green' : 'amber'}>{v.verification}</Badge>}
                  </span>
                </div>
                <div className="mono xs" style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{v.display || <span className="muted">left blank</span>}</div>
                <div className="xs muted mono" title={v.key}>
                  {v.slotId}
                  {v.key ? ` · ${v.key}` : ''}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      {gta && (
        <div className="xs muted" style={{ padding: '8px 16px', borderTop: '1px solid var(--line)' }}>
          {GTA_BENCHMARK_CAVEAT}
        </div>
      )}
    </Card>
  );
}

function StepList({ doc, blocked }: { doc: GeneratedDocument; blocked: boolean }) {
  const approved = doc.status === 'approved' || doc.status === 'sent' || doc.status === 'signed';
  const sent = doc.status === 'sent' || doc.status === 'signed';
  const steps = [
    { label: 'Draft', cls: 'done' },
    { label: blocked ? 'Consistency check: blocked' : doc.consistency ? 'Consistency check: passed' : 'Consistency check', cls: blocked ? 'blocked' : doc.consistency ? 'done' : 'current' },
    { label: 'Approved by a person', cls: approved ? 'done' : blocked ? '' : doc.consistency ? 'current' : '' },
    { label: 'Sent', cls: sent ? 'done' : approved ? 'current' : '' },
    ...(doc.signature || canSign(doc) ? [{ label: 'Signed', cls: doc.signature ? 'done' : approved ? 'current' : '' }] : [])
  ];
  return (
    <div className="step-list" aria-label="Document workflow">
      {steps.map((s) => (
        <span key={s.label} className={`step ${s.cls}`}>
          {s.label}
        </span>
      ))}
    </div>
  );
}

function SendDialog({ doc, claimId, onClose }: { doc: GeneratedDocument; claimId: string; onClose: () => void }) {
  const [via, setVia] = useState<NonNullable<GeneratedDocument['sentVia']> | ''>('email');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const send = useSendDocument(doc.id, claimId);
  const toast = useToast();
  const submit = () => {
    if (!via) return;
    send.mutate(
      { via, to: to.trim() || undefined, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Marked as sent via ${via}`);
          onClose();
        }
      }
    );
  };
  return (
    <Modal
      open
      title={`Send ${doc.title}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={send.isPending} onClick={submit}>
            Record as sent
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
        <p className="small muted">Sending records the channel, time and the document hash on the file, and starts the clocks that run from this letter (chasers, ICOBS 8.2.6, DISP).</p>
        <Select label="Via" required value={via} onChange={setVia} options={SEND_VIA_OPTIONS} autoFocus />
        <TextInput label="To (address, email or portal reference)" value={to} onChange={setTo} />
        <TextArea label="Note" value={note} onChange={setNote} rows={2} />
        <ApiErrorNotice error={send.error} what="record the send" />
      </form>
    </Modal>
  );
}

function SignDialog({ doc, view, onClose }: { doc: GeneratedDocument; view: ClaimView; onClose: () => void }) {
  const parties = [view.claimant, view.driver, ...view.thirdParties].filter((p): p is NonNullable<typeof p> => Boolean(p));
  const [signerPartyId, setSignerPartyId] = useState(view.claimant.id);
  const signer = parties.find((p) => p.id === signerPartyId);
  const [channel, setChannel] = useState<'email' | 'sms'>(signer?.email ? 'email' : 'sms');
  const [contact, setContact] = useState(signer?.email ?? signer?.phone ?? '');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<SignStartResult | null>(null);
  const start = useStartSign(doc.id);
  const verify = useVerifySign(doc.id, view.claim.id);
  const toast = useToast();
  const [done, setDone] = useState<GeneratedDocument | null>(null);

  const begin = () => {
    if (!signerPartyId || !contact.trim()) return;
    start.mutate(
      { signerPartyId, signerName: signer?.name, contact: contact.trim(), channel },
      { onSuccess: (r) => setChallenge(r) }
    );
  };
  const confirm = () => {
    if (!challenge || code.trim().length < 4) return;
    verify.mutate(
      { challengeId: challenge.challengeId, code: code.trim() },
      {
        onSuccess: (d) => {
          setDone(d);
          toast.success('Signed — certificate issued');
        }
      }
    );
  };
  const cert = done?.signature;

  return (
    <Modal
      open
      title={`Sign ${doc.title}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {!challenge && (
            <Button variant="primary" loading={start.isPending} onClick={begin} disabled={!contact.trim()}>
              Send one-time code
            </Button>
          )}
          {challenge && !done && (
            <Button variant="primary" loading={verify.isPending} onClick={confirm} disabled={code.trim().length < 4}>
              Verify and sign
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="step-list">
          <span className={`step ${challenge ? 'done' : 'current'}`}>1 · Who signs</span>
          <span className={`step ${done ? 'done' : challenge ? 'current' : ''}`}>2 · One-time code</span>
          <span className={`step ${done ? 'done' : ''}`}>3 · Certificate</span>
        </div>
        {!challenge && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              begin();
            }}
          >
            <Select
              label="Signer"
              required
              value={signerPartyId}
              onChange={(v) => {
                setSignerPartyId(v);
                const p = parties.find((x) => x.id === v);
                setContact(p?.email ?? p?.phone ?? '');
                setChannel(p?.email ? 'email' : 'sms');
              }}
              options={parties.map((p) => ({ value: p.id, label: p.name }))}
            />
            <Select label="Code sent by" required value={channel} onChange={(v) => v && setChannel(v)} options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }]} />
            <TextInput label={channel === 'email' ? 'Email address' : 'Mobile number'} required value={contact} onChange={setContact} type={channel === 'email' ? 'email' : 'tel'} />
            <p className="xs muted">The record keeps the signer, the contact used, the IP address, the time and the document hash, and issues a completion certificate. The signature date can never be earlier than the document’s creation.</p>
            <ApiErrorNotice error={start.error} what="start the signature" />
          </form>
        )}
        {challenge && !done && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              confirm();
            }}
          >
            <div className="notice notice-info small">
              {challenge.handlerCode ? (
                <>
                  Signing code <strong className="mono">{challenge.handlerCode}</strong>: give it to the signer by phone, text or in person, then enter it below when they confirm it. Expires <DateText value={challenge.expiresAt} time />.
                </>
              ) : (
                <>
                  Code sent by {challenge.channel}; expires <DateText value={challenge.expiresAt} time />.{challenge.debugCode ? <span className="mono"> Dev code: {challenge.debugCode}</span> : null}
                </>
              )}
            </div>
            <TextInput label="One-time code" required value={code} onChange={setCode} inputMode="numeric" autoFocus autoComplete="one-time-code" />
            <ApiErrorNotice error={verify.error} what="verify the code" />
          </form>
        )}
        {done && cert && (
          <div className="notice notice-success small">
            <strong>Signed</strong> by {cert.signerName} at <DateText value={cert.signedAt} time />.{' '}
            <a href={api.documentPdfUrl(cert.certificateId)} target="_blank" rel="noreferrer">
              Completion certificate
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SupersedeDialog({ doc, view, onClose }: { doc: GeneratedDocument; view: ClaimView; onClose: () => void }) {
  const today = todayISO();
  const [form, setForm] = useState({ reExecutedOn: today, reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const supersede = useSupersedeDocument(doc.id, view.claim.id);
  const navigate = useNavigate();
  const toast = useToast();
  const submit = () => {
    const r = supersedeBodyFrom(form, today);
    if (!r.ok) return setErrors(r.errors);
    supersede.mutate(r.body, {
      onSuccess: (d) => {
        toast.success(`New version drafted — carries "re-executed on ${r.body.reExecutedOn}, supersedes v${doc.templateVersion}"`);
        onClose();
        navigate(`/claims/${view.claim.id}/documents/${d.id}`);
      }
    });
  };
  return (
    <Modal
      open
      title="Supersede / re-execute"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={supersede.isPending} onClick={submit}>
            Draft new version
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
        <p className="small muted">Lesson b: a re-executed document carries the actual signing date and the line “re-executed on [date], supersedes version [n]”. The old version stays on file as superseded; its hash is unchanged.</p>
        <DateInput label="Re-executed on" value={form.reExecutedOn} onChange={(v) => setForm((f) => ({ ...f, reExecutedOn: v }))} max={today} error={errors.reExecutedOn} hint="Never earlier than today; the API also refuses dates before creation" />
        <TextArea label="Why" required value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} rows={3} error={errors.reason} autoFocus />
        <ApiErrorNotice error={supersede.error} what="draft the new version" />
      </form>
    </Modal>
  );
}

