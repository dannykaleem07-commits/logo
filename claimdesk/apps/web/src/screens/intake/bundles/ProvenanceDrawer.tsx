// owned by intake-web
/**
 * Provenance drawer (docs/SMART-INTAKE.md §11.4, improvement 3): where a value came from — the file opened at that
 * page (PDF in a frame at #page=n, photos as an image), the page text with the quote highlighted, the confidence, how
 * it was read (AI / read without AI / photo data / you) and every reading of the same field across the files.
 */
import { useIntakeItem } from '../../../api/intakeApi';
import type { BundleFileView, FieldSource } from '../../../api/bundlesApi';
import { Badge } from '../../../components/Badge';
import { ConfidenceBar, Drawer } from './bundleParts';
import { ENGINE_LABEL, isImage, provenanceLabel, splitOnQuote } from './bundleModel';

export interface ProvenanceTarget {
  /** "Registration", "VIN" … */
  title: string;
  source: FieldSource;
  /** Every reading of this field across the files (value + where). */
  readings: Array<{ value: string; source: FieldSource }>;
}

function PageText({ itemId, page, quote }: { itemId: string; page: number | null; quote: string | null }) {
  const item = useIntakeItem(itemId);
  if (item.isLoading) return <p className="small muted">Loading the page text…</p>;
  if (item.error || !item.data) return <p className="small muted">The page text could not be loaded.</p>;
  const texts = item.data.pageTexts ?? [];
  const text = page ? texts[page - 1] : texts.join('\n\n');
  if (!text) return <p className="small muted">No text on this page (a photo or a scan read by the AI).</p>;
  const parts = splitOnQuote(text, quote);
  return (
    <pre className="bdl-pagetext" aria-label="Page text">
      {parts ? (
        <>
          {parts[0]}
          <mark>{parts[1]}</mark>
          {parts[2]}
        </>
      ) : (
        text
      )}
    </pre>
  );
}

export function ProvenanceDrawer({ target, files, onClose }: { target: ProvenanceTarget | null; files: BundleFileView[]; onClose: () => void }) {
  const s = target?.source;
  const file = s ? files.find((f) => f.id === s.fileId) : undefined;
  const url = s ? file?.fileUrl ?? `/api/evidence/${encodeURIComponent(s.evidenceId)}/file` : '';
  const pdf = file ? file.mime === 'application/pdf' : /\.pdf$/i.test(s?.filename ?? '');
  const image = file ? isImage(file) : /\.(png|jpe?g|gif|webp)$/i.test(s?.filename ?? '');
  return (
    <Drawer open={Boolean(target)} title={target ? `Where “${target.title}” came from` : 'Source'} onClose={onClose}>
      {target && s && (
        <div className="stack-sm">
          <div className="row">
            <strong>{provenanceLabel(s)}</strong>
            <Badge tone={s.engine === 'rules' ? 'navy' : s.engine === 'owner' ? 'green' : 'blue'}>{ENGINE_LABEL[s.engine]}</Badge>
            <ConfidenceBar value={s.confidence} />
          </div>
          <div className="small muted">
            {s.filename}
            {s.page ? ` · page ${s.page}` : ''}
            {s.quoteVerified === false ? ' · the quote was not found in the file' : ''}
          </div>
          {s.quote && <blockquote className="bdl-quote">“{s.quote}”</blockquote>}
          <div className="bdl-preview">
            {pdf ? (
              <iframe key={`${url}#${s.page ?? 1}`} className="bdl-preview-pdf" title={`Preview of ${s.filename}`} src={`${url}#page=${s.page ?? 1}`} />
            ) : image ? (
              <img className="bdl-preview-img" src={url} alt={s.filename} />
            ) : (
              <a href={url} target="_blank" rel="noreferrer">
                Open {s.filename}
              </a>
            )}
          </div>
          {s.itemId && s.engine !== 'owner' && s.engine !== 'name_hint' && <PageText itemId={s.itemId} page={s.page} quote={s.quote} />}
          {target.readings.length > 0 && (
            <div>
              <h4 className="bdl-subhead">All readings of this field</h4>
              <ul className="bdl-readings">
                {target.readings.map((r, i) => (
                  <li key={`${r.source.fileId}-${i}`}>
                    <span className="bdl-value">{r.value || '—'}</span>
                    <span className="small muted">
                      {' '}
                      — {provenanceLabel(r.source)} · {ENGINE_LABEL[r.source.engine]} · {Math.round(r.source.confidence * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
