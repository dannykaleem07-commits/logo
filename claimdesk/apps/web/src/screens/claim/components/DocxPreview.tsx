import { useEffect, useRef, useState } from 'react';
import { templatesApi } from '../../../api/templatesApi';
import { Loading } from '../../../components/Spinner';
import '../../templates/templates.css';

type PreviewState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

/**
 * In-app preview of a stored Word document (§C.9). The .docx is fetched with the session cookie and rendered with
 * docx-preview, which is loaded on demand (its own chunk) so the main bundle stays small. If the file cannot be
 * fetched or rendered, the stored preview HTML is shown in the same sandboxed iframe as HTML documents.
 */
export function DocxPreview({ docId, title, fallbackHtml }: { docId: string; title: string; fallbackHtml?: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const [bytes, lib] = await Promise.all([templatesApi.fetchDocumentDocx(docId, controller.signal), import('docx-preview')]);
        if (cancelled || !bodyRef.current) return;
        bodyRef.current.innerHTML = '';
        if (styleRef.current) styleRef.current.innerHTML = '';
        await lib.renderAsync(bytes, bodyRef.current, styleRef.current ?? undefined, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          useBase64URL: true,
          experimental: false
        });
        if (!cancelled) setState({ status: 'ready' });
      } catch (e) {
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [docId]);

  if (state.status === 'error') {
    return (
      <div>
        <div className="notice notice-warn small" style={{ margin: 12 }}>
          The Word preview could not be shown ({state.message}). Showing the text preview instead; the Word file itself is unchanged.
        </div>
        {fallbackHtml ? <iframe className="doc-frame" title={`${title} preview`} srcDoc={fallbackHtml} sandbox="" /> : <div className="xs muted" style={{ padding: 16 }}>No text preview is stored for this document. Download the Word file to read it.</div>}
      </div>
    );
  }

  return (
    <div className="docx-paper-scroll" aria-busy={state.status === 'loading' || undefined}>
      {state.status === 'loading' && <Loading label="Opening the Word document…" />}
      <div ref={styleRef} />
      <div ref={bodyRef} className="docx-paper-body" aria-label={`${title} preview`} />
    </div>
  );
}
