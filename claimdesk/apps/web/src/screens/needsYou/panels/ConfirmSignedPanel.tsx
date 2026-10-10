// owned by ap-paperwork
/**
 * Needs-you confirm_signed (docs/SUPREME-AUTOPILOT.md §E.4, §I.7): the returned scan beside the document we sent, page by
 * page, and the date written on it. Only a person marks a document signed: "Confirm signed" records the date chosen
 * here (POST /documents/:id/mark-signed as you, through the card); "Not signed" / "Wrong document" keep the reminders going.
 */
import { useState } from 'react';
import { api } from '../../../api/client';
import { useResolveNeedsYou } from '../../../api/needsYouApi';
import { ApiErrorNotice, Button } from '../../../components';
import type { NeedsYouPanelProps } from './types';
import '../../sign/sign.css';

interface Payload {
  signatureRequestId?: string;
  documentId?: string;
  evidenceId?: string;
  title?: string;
  filename?: string;
  suggestedSignedOn?: string;
}

export function ConfirmSignedPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  const [signedOn, setSignedOn] = useState(p.suggestedSignedOn ?? '');
  const [method, setMethod] = useState<'scan' | 'wet_ink'>('scan');
  const resolve = useResolveNeedsYou();
  return (
    <div className="stack-sm">
      <p>
        Returned copy <strong>{p.filename ?? 'scan'}</strong> — is it the signed <strong>{p.title ?? 'document'}</strong>?
      </p>
      <div className="packs-compare">
        {p.evidenceId && <iframe className="packs-compare-frame" title="Returned copy" src={api.evidenceFileUrl(p.evidenceId)} />}
        {p.documentId && <iframe className="packs-compare-frame" title="Document we sent" src={api.documentPdfUrl(p.documentId)} />}
      </div>
      {!closed && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            resolve.mutate({ id: item.id, body: { optionId: 'confirm', edits: { signedOn, method } } });
          }}
        >
          <label className="small">
            Date written on the signed copy{' '}
            <input className="input" type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} required />
          </label>
          <label className="small">
            Returned as{' '}
            <select className="select" value={method} onChange={(e) => setMethod(e.target.value as 'scan' | 'wet_ink')}>
              <option value="scan">Scan or photo</option>
              <option value="wet_ink">Paper original</option>
            </select>
          </label>
          <Button type="submit" variant="primary" loading={resolve.isPending} disabled={!signedOn}>
            Confirm signed on this date
          </Button>
        </form>
      )}
      {resolve.error != null && <ApiErrorNotice error={resolve.error} what="confirm the signature" />}
    </div>
  );
}
