/**
 * Upload a licensed .glb / .gltf / .zip and assign it to a make / model / generation (/ body) from the catalogue.
 * The licence box must be ticked; Audatex / Qapter models are refused here and on the server's word list.
 */
import { useMemo, useRef, useState } from 'react';
import { isApiError } from '../../../api/client';
import { useCatalogueMakes, useCatalogueModel, useCatalogueModels } from '../../../api/vehiclesApi';
import { Button } from '../../../components/Button';
import { Checkbox, Select, TextInput } from '../../../components/Form';
import { LICENCE_NOTICE, uploadModel3d, type Model3dView, type ModelBodyType } from '../../engineer/damage3d/exact/exactApi';
import { formatBytes } from '../../engineer/damage3d/exact/exactModel';
import { BODY_OPTIONS, bodyFromCatalogue, checkModelFile, DEFAULT_MAX_BYTES, MODEL_FILE_ACCEPT } from './models3dSettings';

export interface UploadModelFormProps {
  maxBytes?: number;
  onUploaded: (model: Model3dView) => void;
  onCancel?: () => void;
}

export function UploadModelForm({ maxBytes = DEFAULT_MAX_BYTES, onUploaded, onCancel }: UploadModelFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [makeSlug, setMakeSlug] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  const [generationId, setGenerationId] = useState('');
  const [bodyType, setBodyType] = useState<ModelBodyType | ''>('');
  const [title, setTitle] = useState('');
  const [licence, setLicence] = useState(false);
  const [licenceNote, setLicenceNote] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const makes = useCatalogueMakes();
  const models = useCatalogueModels(makeSlug || undefined);
  const model = useCatalogueModel(makeSlug || undefined, modelSlug || undefined);
  const generation = model.data?.generations.find((g) => g.id === generationId);
  const bodyChoices = useMemo(() => {
    const fromGen = generation ? [...new Set(generation.bodies.map((b) => bodyFromCatalogue(b.body)).filter((b): b is ModelBodyType => !!b))] : [];
    return fromGen.length ? BODY_OPTIONS.filter((o) => fromGen.includes(o.value)) : BODY_OPTIONS;
  }, [generation]);

  const fileProblem = checkModelFile(file, maxBytes);
  const problems = {
    file: fileProblem,
    make: makeSlug ? null : 'Choose the make',
    model: modelSlug ? null : 'Choose the model',
    licence: licence ? null : 'Tick to confirm you hold a licence for this model',
  };
  const ready = !Object.values(problems).some(Boolean);
  const busy = progress !== null;

  const submit = async () => {
    setTouched(true);
    setError(null);
    if (!ready || !file) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress(0);
    try {
      const view = await uploadModel3d(
        { file, makeSlug, modelSlug, ...(generationId ? { generationId } : {}), ...(bodyType ? { bodyType } : {}), ...(title.trim() ? { title } : {}), licenceConfirmed: licence, ...(licenceNote.trim() ? { licenceNote } : {}) },
        (f) => setProgress(f),
        ctl.signal
      );
      onUploaded(view);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setError('Upload cancelled');
      else setError(isApiError(e) ? e.message : (e as Error).message);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  return (
    <form
      className="m3d-upload stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="notice notice-info m3d-licence" role="note">
        <strong>Licence.</strong> {LICENCE_NOTICE}
      </div>

      <label className={`m3d-drop${file ? ' has-file' : ''}`}>
        <input
          type="file"
          accept={MODEL_FILE_ACCEPT}
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
          }}
        />
        <span className="m3d-drop-title">{file ? file.name : 'Choose a 3D model file'}</span>
        <span className="m3d-drop-sub">{file ? formatBytes(file.size) : `.glb, .gltf, or .zip with the .gltf, .bin and textures · up to ${formatBytes(maxBytes)}`}</span>
      </label>
      {touched && problems.file && <div className="field-error">{problems.file}</div>}

      <div className="form-grid">
        <Select
          label="Make"
          required
          value={makeSlug}
          placeholder={makes.isLoading ? 'Loading…' : 'Choose…'}
          options={(makes.data ?? []).map((m) => ({ value: m.slug, label: m.make }))}
          onChange={(v) => {
            setMakeSlug(v);
            setModelSlug('');
            setGenerationId('');
          }}
          error={touched ? (problems.make ?? undefined) : undefined}
          disabled={busy}
        />
        <Select
          label="Model"
          required
          value={modelSlug}
          placeholder={!makeSlug ? 'Choose the make first' : models.isLoading ? 'Loading…' : 'Choose…'}
          options={(models.data ?? []).map((m) => ({ value: m.slug, label: `${m.name} (${m.years.from}–${m.years.to ?? 'now'})` }))}
          onChange={(v) => {
            setModelSlug(v);
            setGenerationId('');
          }}
          error={touched ? (problems.model ?? undefined) : undefined}
          disabled={busy || !makeSlug}
        />
        <Select
          label="Generation"
          value={generationId}
          placeholder="All generations"
          options={(model.data?.generations ?? []).map((g) => ({ value: g.id, label: g.name }))}
          onChange={(v) => setGenerationId(v)}
          hint="Pick the generation the model shows; it is then used only for that generation."
          disabled={busy || !modelSlug}
        />
        <Select label="Body" value={bodyType} placeholder="Any body" options={bodyChoices} onChange={(v) => setBodyType(v)} hint="Decides tailgate vs boot lid, sliding doors and load-bed parts." disabled={busy} />
      </div>
      <TextInput label="Name (optional)" value={title} onChange={setTitle} placeholder="e.g. Fiesta Mk7 5-door, supplier ref 1234" disabled={busy} />
      <Checkbox label={<span>I hold a licence to use this 3D model in ClaimDesk. It is not an Audatex / Qapter model.</span>} checked={licence} onChange={setLicence} disabled={busy} />
      {touched && problems.licence && <div className="field-error">{problems.licence}</div>}
      <TextInput label="Licence details (optional)" value={licenceNote} onChange={setLicenceNote} placeholder="Supplier, order number, licence type" disabled={busy} />

      {error && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="m3d-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)} aria-label="Upload progress">
          <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          <em>{(progress ?? 0) >= 1 ? 'Checking and mapping the model…' : `Uploading ${Math.round((progress ?? 0) * 100)}%`}</em>
        </div>
      )}
      <div className="row m3d-actions">
        {busy ? (
          <Button onClick={() => abort.current?.abort()}>Cancel upload</Button>
        ) : (
          onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )
        )}
        <Button variant="primary" type="submit" loading={busy} disabled={busy}>
          Upload and map parts
        </Button>
      </div>
    </form>
  );
}
