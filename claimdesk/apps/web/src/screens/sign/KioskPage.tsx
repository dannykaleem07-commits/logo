// owned by ap-paperwork
/**
 * Signing kiosk (docs/SUPREME-AUTOPILOT.md §E.2, §I.6): full screen, outside the app shell, large type, one document at
 * a time ("2 of 5") with "I have read this" enabled at the end of the document, then typed name, a signature pad, the
 * one code for the whole pack, and Sign. "Hand back to the Claims Team" needs the handler's password; after 5 minutes
 * without a touch the screen blanks and asks for the Claims Team. No navigation and no other claim data. It talks only
 * to /api/kiosk/:token/* (token auth).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiError } from '../../api/client';
import { kioskApi, type KioskOtp, type KioskSummary } from '../../api/signingApi';
import { Button } from '../../components';
import { FATAL_KIOSK_CODES, KIOSK_IDLE_MS, SIGNATURE_MAX_BYTES, base64Bytes, kioskMessage, kioskStage, progressLabel, signBlocker } from './kiosk';
import { SignaturePad } from './SignaturePad';
import './sign.css';

function errorText(e: unknown): { code?: string; text: string } {
  if (isApiError(e)) return { code: e.code, text: kioskMessage(e.code, e.message) };
  return { text: e instanceof Error ? e.message : String(e) };
}

function HandBack({ token, onClosed }: { token: string; onClosed: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Hand back to the Claims Team
      </Button>
    );
  return (
    <form
      className="kiosk-handback"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        kioskApi
          .close(token, password)
          .then(onClosed)
          .catch((err: unknown) => setError(errorText(err).text))
          .finally(() => setBusy(false));
      }}
    >
      <label className="kiosk-label" htmlFor="kiosk-handler-password">
        Claims Team password
      </label>
      <input id="kiosk-handler-password" className="input kiosk-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      {error && <p className="kiosk-error" role="alert">{error}</p>}
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={!password}>
          Close the signing screen
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DocumentStep({ token, doc, label, onRead }: { token: string; doc: KioskSummary['documents'][number]; label: string; onRead: () => Promise<void> }) {
  const [atEnd, setAtEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAtEnd(false);
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setAtEnd(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) setAtEnd(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [doc.id]);
  return (
    <section className="kiosk-doc" aria-labelledby="kiosk-doc-title">
      <p className="kiosk-progress">{label}</p>
      <h2 id="kiosk-doc-title" className="kiosk-title">
        {doc.title}
      </h2>
      <p className="kiosk-hint">{doc.purpose === 'sign' ? 'Please read this document. You will sign it at the end.' : 'This document is for you to keep. Please read it.'}</p>
      <div className="kiosk-doc-scroll">
        <iframe className="kiosk-pdf" title={doc.title} src={kioskApi.pdfUrl(token, doc.id)} />
        <div ref={sentinel} className="kiosk-doc-end">
          End of {doc.title}
        </div>
      </div>
      <Button
        variant="primary"
        size="lg"
        block
        loading={busy}
        disabled={!atEnd}
        onClick={() => {
          setBusy(true);
          onRead().finally(() => setBusy(false));
        }}
      >
        {atEnd ? 'I have read this' : 'Scroll to the end of the document'}
      </Button>
    </section>
  );
}

function SignStep({ token, summary, onSigned }: { token: string; summary: KioskSummary; onSigned: () => void }) {
  const [typedName, setTypedName] = useState('');
  const [signaturePng, setSignaturePng] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [otp, setOtp] = useState<KioskOtp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocker = signBlocker({ typedName, signaturePng, code, consent, codeRequested: Boolean(otp) });
  const toSign = summary.documents.filter((d) => d.purpose === 'sign');
  return (
    <section className="kiosk-sign" aria-labelledby="kiosk-sign-title">
      <h2 id="kiosk-sign-title" className="kiosk-title">
        Sign your documents
      </h2>
      <p className="kiosk-hint">You are signing {toSign.length === 1 ? 'this document' : `these ${toSign.length} documents`}:</p>
      <ul className="kiosk-list">
        {toSign.map((d) => (
          <li key={d.id}>{d.title}</li>
        ))}
      </ul>
      <label className="kiosk-label" htmlFor="kiosk-name">
        Your full name
      </label>
      <input id="kiosk-name" className="input kiosk-input" autoComplete="off" value={typedName} onChange={(e) => setTypedName(e.target.value)} />
      <p className="kiosk-label">Your signature</p>
      <SignaturePad
        onChange={(png) => {
          if (png && base64Bytes(png) > SIGNATURE_MAX_BYTES) {
            setError('Please draw your signature a little smaller');
            setSignaturePng(null);
            return;
          }
          setSignaturePng(png);
        }}
      />
      <label className="kiosk-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I have read these documents and I agree to sign them electronically. My typed name, drawn signature and the one-time code are my signature.
      </label>
      {!otp ? (
        <Button
          variant="secondary"
          size="lg"
          loading={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            kioskApi
              .otp(token)
              .then(setOtp)
              .catch((e: unknown) => setError(errorText(e).text))
              .finally(() => setBusy(false));
          }}
        >
          {summary.otp.delivery === 'email' ? `Email me my code${summary.otp.contactMasked ? ` (${summary.otp.contactMasked})` : ''}` : 'Get my code'}
        </Button>
      ) : (
        <>
          <p className="kiosk-hint" role="status">
            {otp.channel === 'email' ? `We have emailed a 6-digit code to ${otp.contactMasked ?? 'your email address'}.` : 'Please ask the Claims Team member for your 6-digit code.'}
          </p>
          {otp.handlerCode && (
            <details className="kiosk-handler-code">
              <summary>For the Claims Team member: show the code</summary>
              <p>
                Code: <strong>{otp.handlerCode}</strong> (give it to the signer in person; this is recorded)
              </p>
            </details>
          )}
          <label className="kiosk-label" htmlFor="kiosk-code">
            Your code
          </label>
          <input id="kiosk-code" className="input kiosk-input kiosk-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ''))} />
        </>
      )}
      {error && (
        <p className="kiosk-error" role="alert">
          {error}
        </p>
      )}
      <Button
        variant="primary"
        size="lg"
        block
        loading={busy && Boolean(otp)}
        disabled={blocker !== null}
        title={blocker ?? undefined}
        onClick={() => {
          if (!signaturePng) return;
          setBusy(true);
          setError(null);
          kioskApi
            .sign(token, { typedName: typedName.trim(), drawnSignaturePngBase64: signaturePng, code: code.replace(/\s/g, ''), consent: true })
            .then(onSigned)
            .catch((e: unknown) => setError(errorText(e).text))
            .finally(() => setBusy(false));
        }}
      >
        Sign
      </Button>
      {blocker && <p className="muted kiosk-blocker">{blocker}</p>}
    </section>
  );
}

export function KioskPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [summary, setSummary] = useState<KioskSummary | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [idle, setIdle] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    kioskApi
      .summary(token)
      .then((s) => {
        setSummary(s);
        setFatal(null);
      })
      .catch((e: unknown) => {
        const { code, text } = errorText(e);
        if (!code || FATAL_KIOSK_CODES.has(code) || !summary) setFatal(text);
        else setNotice(text);
      });
  }, [token, summary]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per token
  }, [token]);

  useEffect(() => {
    if (closed || fatal) return;
    let timer = window.setTimeout(() => setIdle(true), KIOSK_IDLE_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), KIOSK_IDLE_MS);
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [closed, fatal]);

  if (closed)
    return (
      <main className="kiosk kiosk-centre">
        <h1 className="kiosk-heading">Signing closed</h1>
        <p className="kiosk-hint">Thank you. The Claims Team can now use this device again.</p>
      </main>
    );

  if (idle)
    return (
      <main className="kiosk kiosk-centre kiosk-idle">
        <h1 className="kiosk-heading">Please hand the device back to the Claims Team</h1>
        <p className="kiosk-hint">The screen was left for a while, so it has been hidden.</p>
        <HandBack token={token} onClosed={() => setClosed(true)} />
      </main>
    );

  if (fatal)
    return (
      <main className="kiosk kiosk-centre">
        <h1 className="kiosk-heading">Signing</h1>
        <p className="kiosk-error" role="alert">
          {fatal}
        </p>
      </main>
    );

  if (!summary)
    return (
      <main className="kiosk kiosk-centre">
        <p className="kiosk-hint">Loading your documents…</p>
      </main>
    );

  const stage = kioskStage(summary, readIds);
  return (
    <main className="kiosk">
      <header className="kiosk-header">
        <div>
          <p className="kiosk-brand">Courtesy Cars Group UK Ltd</p>
          <h1 className="kiosk-heading">{summary.packLabel}</h1>
          <p className="kiosk-hint">For {summary.signer.name}</p>
        </div>
        <HandBack token={token} onClosed={() => setClosed(true)} />
      </header>
      {notice && (
        <p className="kiosk-error" role="alert">
          {notice}
        </p>
      )}
      {stage.kind === 'read' && (
        <DocumentStep
          token={token}
          doc={summary.documents[stage.index]!}
          label={progressLabel(stage)}
          onRead={async () => {
            const id = summary.documents[stage.index]!.id;
            try {
              await kioskApi.read(token, id);
              setReadIds((s) => new Set([...s, id]));
              setNotice(null);
            } catch (e) {
              setNotice(errorText(e).text);
            }
          }}
        />
      )}
      {stage.kind === 'sign' && <SignStep token={token} summary={summary} onSigned={() => setSummary({ ...summary, completed: true })} />}
      {stage.kind === 'done' && (
        <section className="kiosk-centre">
          <h2 className="kiosk-title">Thank you — your documents are signed</h2>
          <p className="kiosk-hint">Please hand the device back to the Claims Team. Copies of your documents will be sent to you.</p>
        </section>
      )}
    </main>
  );
}
