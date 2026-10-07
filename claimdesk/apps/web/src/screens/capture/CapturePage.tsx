import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { GuidedShot } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import '../../styles/screens.css';
import { isApiError } from '../../api/client';
import { useClaim, useUploadEvidence } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Form';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { DateText } from '../../components/DateText';
import { useToast } from '../../components/Toast';
import { buildEvidenceFields, captureFileName, captureProgress, custodyState, describeDevice, formatGps, nextShot, sha256HexOf, SHOT_LABEL, shortHash, shotList, type CaptureGps, type CaptureItem } from './capture';
import { ShotOverlay } from './ShotOverlay';

type CameraState = 'idle' | 'starting' | 'live' | 'unavailable';

/**
 * Guided capture (/capture/:claimId). Mobile-first: live camera with a per-shot outline, canvas capture, SHA-256
 * in the browser before upload, EXIF-equivalent facts (time, device, GPS) in the upload fields, and the server's
 * hash compared back for chain of custody. Falls back to <input type="file" capture> where getUserMedia is absent.
 * Evidence is write-once: there is no edit or delete here, only retake-before-upload.
 */
export function CapturePage() {
  const { claimId } = useParams();
  if (!claimId) return <NoClaim />;
  return <CaptureFlow claimId={claimId} />;
}

function NoClaim() {
  return (
    <div className="page cap-page">
      <PageHeader title="Guided capture" subtitle="Open this screen from a claim file so every photo lands on the right evidence record." />
      <Card>
        <EmptyState title="No claim selected" action={<Link className="btn btn-primary" to="/claims">Choose a claim</Link>}>
          The address is <code>/capture/&lt;claim id&gt;</code>. From a claim file use Evidence → Guided capture.
        </EmptyState>
      </Card>
    </div>
  );
}

function CaptureFlow({ claimId }: { claimId: string }) {
  const claim = useClaim(claimId);
  const upload = useUploadEvidence(claimId);
  const toast = useToast();
  const shots = useMemo(() => shotList(), []);
  const [current, setCurrent] = useState<GuidedShot>(shots[0]!.shot);
  const [items, setItems] = useState<Partial<Record<GuidedShot, CaptureItem>>>({});
  const [camera, setCamera] = useState<CameraState>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [gps, setGps] = useState<CaptureGps | undefined>();
  const [gpsState, setGpsState] = useState<'idle' | 'asking' | 'granted' | 'denied' | 'unsupported'>('idle');
  const [autoUpload, setAutoUpload] = useState(true);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const device = typeof navigator !== 'undefined' ? describeDevice(navigator.userAgent) : 'unknown device';
  const progress = captureProgress(shots, items);
  const currentShot = shots.find((s) => s.shot === current) ?? shots[0]!;
  const currentItem = items[current];

  // Camera lifecycle --------------------------------------------------------
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamera('unavailable');
      setCameraError('This browser has no camera API — use "Take photo" below, which opens the device camera.');
      return;
    }
    setCamera('starting');
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => undefined);
      }
      setCamera('live');
    } catch (e) {
      stopCamera();
      setCamera('unavailable');
      setCameraError(`Camera unavailable (${(e as Error).name || 'error'}): ${(e as Error).message || 'permission denied'}. Use "Take photo" below.`);
    }
  }, [stopCamera]);

  useEffect(() => {
    void startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    return () => {
      for (const it of Object.values(itemsRef.current)) if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    };
  }, []);

  // Location (optional, asked once) ----------------------------------------
  const askLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsState('unsupported');
      return;
    }
    setGpsState('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy });
        setGpsState('granted');
      },
      () => setGpsState('denied'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  };

  // Upload ------------------------------------------------------------------
  const setItem = (shot: GuidedShot, patch: Partial<CaptureItem>) => setItems((xs) => (xs[shot] ? { ...xs, [shot]: { ...xs[shot]!, ...patch } } : xs));

  const uploadItem = async (item: CaptureItem) => {
    setItem(item.shot, { status: 'uploading', error: undefined });
    try {
      const file = new File([item.blob], item.filename, { type: item.blob.type || 'image/jpeg' });
      const evidence = await upload.mutateAsync({ file, fields: buildEvidenceFields(item) });
      setItem(item.shot, { status: 'uploaded', evidence });
      const state = custodyState(item.sha256, evidence.sha256);
      if (state === 'mismatch') toast.error(`${SHOT_LABEL[item.shot]}: server hash differs from the device hash — retake and report`);
    } catch (e) {
      setItem(item.shot, { status: 'error', error: isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message });
    }
  };

  const addCapture = async (blob: Blob, source: CaptureItem['meta']['source'], capturedAt: string, dims?: { w: number; h: number }) => {
    setBusy(true);
    try {
      const sha256 = await sha256HexOf(blob);
      const previous = itemsRef.current[current];
      if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
      const item: CaptureItem = {
        shot: current,
        blob,
        filename: captureFileName(current, capturedAt, blob.type === 'image/png' ? 'png' : 'jpg'),
        previewUrl: URL.createObjectURL(blob),
        sha256,
        status: 'ready',
        meta: { capturedAt, device, source, gps, widthPx: dims?.w, heightPx: dims?.h }
      };
      setItems((xs) => ({ ...xs, [current]: item }));
      const next = nextShot(shots, { ...itemsRef.current, [current]: item }, current);
      if (next) setCurrent(next);
      if (autoUpload) void uploadItem(item);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const captureFrame = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || camera !== 'live' || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      toast.error('Could not read the camera frame');
      return;
    }
    await addCapture(blob, 'camera', new Date().toISOString(), { w: c.width, h: c.height });
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const capturedAt = new Date(file.lastModified || Date.now()).toISOString();
    await addCapture(file, 'file', capturedAt);
  };

  const uploadPending = async () => {
    for (const s of shots) {
      const it = itemsRef.current[s.shot];
      if (it && (it.status === 'ready' || it.status === 'error')) await uploadItem(it);
    }
  };

  const retake = () => {
    const it = items[current];
    if (!it || it.status === 'uploaded' || it.status === 'uploading') return;
    URL.revokeObjectURL(it.previewUrl);
    setItems((xs) => {
      const next = { ...xs };
      delete next[current];
      return next;
    });
  };

  const pending = shots.filter((s) => items[s.shot] && (items[s.shot]!.status === 'ready' || items[s.shot]!.status === 'error')).length;
  const mismatches = shots.filter((s) => items[s.shot]?.evidence && custodyState(items[s.shot]!.sha256, items[s.shot]!.evidence!.sha256) === 'mismatch').length;

  return (
    <div className="page cap-page">
      <PageHeader
        crumbs={[{ label: 'Claims', to: '/claims' }, { label: claim.data?.claim.reference ?? claimId, to: `/claims/${claimId}` }, { label: 'Guided capture' }]}
        title="Guided capture"
        subtitle={
          claim.isLoading ? (
            'Loading claim…'
          ) : claim.data ? (
            <>
              {claim.data.claim.reference} · <span className="reg-plate" style={{ fontSize: '0.8em' }}>{formatRegistration(claim.data.vehicle.registration)}</span> · {claim.data.vehicle.make} {claim.data.vehicle.model}
            </>
          ) : (
            `Claim ${claimId}`
          )
        }
        actions={
          <Link className="btn btn-secondary" to={`/claims/${claimId}/evidence`}>
            Evidence on file
          </Link>
        }
      />
      {claim.error && <ApiErrorNotice error={claim.error} what="load the claim" />}

      <div className="stack">
        <div>
          <div className="row-between xs muted" style={{ marginBottom: 4 }}>
            <span>
              {progress.uploaded} of {progress.total} uploaded · {progress.requiredDone} of {progress.required} required
            </span>
            <span>{progress.pct}%</span>
          </div>
          <div className="cap-progress" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${progress.pct}%` }} />
          </div>
        </div>

        <Card flush>
          <div className="cap-stage">
            {currentItem ? <img src={currentItem.previewUrl} alt={`${SHOT_LABEL[current]} capture`} /> : <video ref={videoRef} playsInline muted autoPlay />}
            {!currentItem && camera === 'live' && <ShotOverlay shot={current} />}
            {!currentItem && camera !== 'live' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--media-fg)', padding: 16, textAlign: 'center' }} className="small">
                {camera === 'starting' ? <Loading label="Starting camera…" /> : cameraError ?? 'Camera idle'}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <div style={{ padding: '12px 16px' }} className="stack-sm">
            <div className="row-between">
              <div>
                <div className="strong">
                  {SHOT_LABEL[current]} {currentShot.required ? <Badge tone="red">required</Badge> : <Badge tone="grey">optional</Badge>}
                </div>
                <div className="small muted">{currentShot.instruction}</div>
              </div>
            </div>
            <div className="cap-controls">
              <Button variant="ghost" onClick={() => setCurrent(shots[(shots.findIndex((s) => s.shot === current) + shots.length - 1) % shots.length]!.shot)} aria-label="Previous shot">
                ‹ Prev
              </Button>
              {currentItem ? (
                <div className="row">
                  {currentItem.status === 'ready' || currentItem.status === 'error' ? (
                    <>
                      <Button onClick={retake}>Retake</Button>
                      <Button variant="primary" onClick={() => uploadItem(currentItem)} loading={false}>
                        Upload
                      </Button>
                    </>
                  ) : currentItem.status === 'uploading' ? (
                    <Loading label="Uploading…" />
                  ) : (
                    <Badge tone="green" dot>
                      uploaded · write-once
                    </Badge>
                  )}
                </div>
              ) : camera === 'live' ? (
                <button type="button" className="cap-shutter" onClick={captureFrame} disabled={busy} aria-label={`Capture ${SHOT_LABEL[current]}`} />
              ) : (
                <label className="btn btn-primary file-btn">
                  Take photo
                  <input type="file" accept="image/*" capture="environment" onChange={onFile} aria-label={`Take photo: ${SHOT_LABEL[current]}`} />
                </label>
              )}
              <Button variant="ghost" onClick={() => setCurrent(shots[(shots.findIndex((s) => s.shot === current) + 1) % shots.length]!.shot)} aria-label="Next shot">
                Next ›
              </Button>
            </div>
            {camera === 'live' && (
              <div className="row xs muted" style={{ justifyContent: 'center' }}>
                <label className="btn btn-ghost btn-sm file-btn">
                  Use a file instead
                  <input type="file" accept="image/*" capture="environment" onChange={onFile} />
                </label>
              </div>
            )}
            {currentItem && (
              <div className="custody">
                <span className="muted">Device SHA-256:</span>
                <span className="hash" title={currentItem.sha256}>
                  {shortHash(currentItem.sha256, 16)}
                </span>
                <CustodyBadge item={currentItem} />
                {currentItem.error && <span className="bad-mark">{currentItem.error}</span>}
              </div>
            )}
          </div>
        </Card>

        <Card title="Shots" actions={<span className="xs muted">tap a shot to jump to it</span>}>
          <div className="cap-shots">
            {shots.map((s) => {
              const it = items[s.shot];
              const cls = ['cap-shot', s.shot === current ? 'current' : '', it?.status === 'uploaded' ? 'done' : '', it?.status === 'error' ? 'error' : ''].filter(Boolean).join(' ');
              return (
                <button key={s.shot} type="button" className={cls} onClick={() => setCurrent(s.shot)} aria-pressed={s.shot === current} title={s.instruction}>
                  <div className="thumb">{it ? <img src={it.previewUrl} alt="" /> : s.required ? '•' : '○'}</div>
                  <span className="label">{SHOT_LABEL[s.shot]}</span>
                  <span className="xs muted">{it ? (it.status === 'uploaded' ? '✓ uploaded' : it.status === 'uploading' ? 'uploading…' : it.status === 'error' ? 'failed' : 'ready') : s.required ? 'required' : 'optional'}</span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title="Capture facts (EXIF-equivalent)" flush>
          <ul className="list">
            <li>
              <div className="list-main">
                <div className="list-title">Device</div>
                <div className="list-sub">{device}</div>
              </div>
            </li>
            <li>
              <div className="list-main">
                <div className="list-title">Location</div>
                <div className="list-sub">{gps ? formatGps(gps) : gpsState === 'denied' ? 'Permission refused — photos upload without GPS' : gpsState === 'unsupported' ? 'Not supported on this device' : 'Not captured yet'}</div>
              </div>
              {!gps && gpsState !== 'unsupported' && (
                <Button size="sm" onClick={askLocation} loading={gpsState === 'asking'}>
                  Use location
                </Button>
              )}
            </li>
            <li>
              <div className="list-main">
                <div className="list-title">Capture time</div>
                <div className="list-sub">Taken from the device clock at the moment of capture and sent as capturedAt; the server records uploadedAt separately (BLUEPRINT §3.8).</div>
              </div>
            </li>
            <li>
              <div className="list-main">
                <div className="list-title">Upload</div>
                <div className="list-sub">Each photo is hashed on this device before upload; the server hashes the stored bytes and the two must match.</div>
              </div>
              <Checkbox label="Upload each shot as it is taken" checked={autoUpload} onChange={setAutoUpload} />
            </li>
          </ul>
          {(pending > 0 || mismatches > 0) && (
            <div className="card-footer row-between">
              <span className="small">
                {pending > 0 && `${pending} shot${pending === 1 ? '' : 's'} waiting to upload`}
                {mismatches > 0 && (
                  <span className="bad-mark">
                    {' '}
                    {mismatches} hash mismatch{mismatches === 1 ? '' : 'es'}
                  </span>
                )}
              </span>
              {pending > 0 && (
                <Button variant="primary" onClick={uploadPending} loading={upload.isPending}>
                  Upload pending
                </Button>
              )}
            </div>
          )}
        </Card>

        {progress.uploaded > 0 && (
          <Card title="Chain of custody" flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Shot</th>
                    <th scope="col">Captured</th>
                    <th scope="col">Device hash</th>
                    <th scope="col">Server hash</th>
                    <th scope="col">Custody</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {shots
                    .filter((s) => items[s.shot]?.status === 'uploaded')
                    .map((s) => {
                      const it = items[s.shot]!;
                      return (
                        <tr key={s.shot}>
                          <td>{SHOT_LABEL[s.shot]}</td>
                          <td>
                            <DateText value={it.meta.capturedAt} time />
                          </td>
                          <td className="hash" title={it.sha256}>
                            {shortHash(it.sha256)}
                          </td>
                          <td className="hash" title={it.evidence?.sha256}>
                            {shortHash(it.evidence?.sha256)}
                          </td>
                          <td>
                            <CustodyBadge item={it} />
                          </td>
                          <td className="xs">{it.evidence ? <Link to={`/claims/${claimId}/evidence`}>{it.evidence.id}</Link> : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <div className="card-footer xs muted">Evidence is write-once: a wrong photo is superseded by a new upload, never edited or deleted.</div>
          </Card>
        )}

        {progress.requiredMissing.length > 0 && progress.captured > 0 && (
          <div className="notice notice-warn">
            <strong>Required shots still missing:</strong> {progress.requiredMissing.map((s) => SHOT_LABEL[s]).join(', ')}.
          </div>
        )}
        {progress.requiredMissing.length === 0 && progress.requiredDone === progress.required && (
          <div className="notice notice-success">
            <strong>All required shots uploaded.</strong> Odometer and damage close-ups feed the mileage-conflict and engineering modules; repeat the odometer shot at delivery and collection.
          </div>
        )}
      </div>
    </div>
  );
}

function CustodyBadge({ item }: { item: CaptureItem }) {
  if (item.status !== 'uploaded' || !item.evidence) return <Badge tone="grey">not uploaded</Badge>;
  const state = custodyState(item.sha256, item.evidence.sha256);
  if (state === 'match')
    return (
      <Badge tone="green" dot title="Server hash equals the device hash">
        hashes match
      </Badge>
    );
  if (state === 'mismatch')
    return (
      <Badge tone="red" dot title="Server hash differs — the stored bytes are not what the device hashed">
        hash mismatch
      </Badge>
    );
  return <Badge tone="amber">awaiting server hash</Badge>;
}
