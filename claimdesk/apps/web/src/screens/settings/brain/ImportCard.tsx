// owned by casework
import { useRef, useState } from 'react';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { TextInput } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { DateText } from '../../../components/DateText';
import { brainApi, useBrainMutation, type ImportResult, type ImportSource, type StagedPackFile } from '../../../api/brainApi';
import { sizeText, uploadInChunks } from '../../../api/uploads';
import { ActivateForm } from './ActivateForm';
import { PackPreviewView } from './PackPreviewView';
import { pathError } from './brainView';

/**
 * Import a pack (§E.5, §L.10): from the import folder (brain-packs), a .ccbrain file, or a folder / skill path on this
 * PC. The import is stored inactive; the preview shows what it holds, then the owner chooses the business tags and
 * precedence and activates it.
 */
export function ImportCard({ staged }: { staged: StagedPackFile[] }) {
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imp = useBrainMutation((src: ImportSource) => brainApi.import(src));
  const run = (src: ImportSource) => {
    setResult(null);
    void imp
      .mutateAsync(src)
      .then(setResult)
      .catch(() => undefined);
  };
  const pick = async (file: File | null) => {
    if (!file) return;
    setUploadError(null);
    setUploading(`Uploading ${file.name}…`);
    try {
      const up = await uploadInChunks(file, { purpose: 'brain-packs', onProgress: (s, total) => setUploading(`Uploading ${file.name}: ${Math.round((s / Math.max(total, 1)) * 100)}%`) });
      if (up.importId) run({ importId: up.importId });
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const pending = staged.filter((s) => s.status !== 'consumed');
  const pErr = pathTouched ? pathError(path) : undefined;
  return (
    <Card title="Import a pack">
      <div className="stack">
        <p className="small muted">Packs stay on this computer (in the data folder). Importing never activates a pack: you see what it holds first.</p>
        {pending.length > 0 && (
          <div className="stack-sm">
            <strong className="small">In the import folder (brain-packs)</strong>
            {pending.map((s) => (
              <div key={s.id} className="row-between">
                <span className="small">
                  {s.filename} · {sizeText(s.bytes)} · <DateText value={s.receivedAt} time />
                  {s.error ? ` · ${s.error}` : ''}
                </span>
                <Button size="sm" onClick={() => run({ importId: s.id })} loading={imp.isPending}>
                  Import
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <input ref={fileRef} className="input" type="file" accept=".ccbrain,.zip" aria-label="Choose a .ccbrain file" disabled={Boolean(uploading)} onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
          {uploading && <span className="small muted">{uploading}</span>}
        </div>
        <div className="row">
          <TextInput label="Or a folder / skill path on this PC" hint="A pack folder with manifest.json, a skill folder with SKILL.md, or a .ccbrain file." value={path} onChange={setPath} error={pErr} />
          <Button
            loading={imp.isPending}
            onClick={() => {
              setPathTouched(true);
              if (!pathError(path)) run({ path: path.trim() });
            }}
          >
            Import from path
          </Button>
        </div>
        <ApiErrorNotice error={imp.error ?? uploadError} what="import the pack" />
        {result && (
          <div className="stack-sm" aria-live="polite">
            <strong>
              {result.preview.name} {result.preview.version}
              {result.duplicate ? ' (already imported)' : ''}
            </strong>
            <PackPreviewView preview={result.preview} />
            <ActivateForm preview={result.preview} useForCcguk={result.pack.useForCcguk} onDone={() => setResult(null)} />
          </div>
        )}
      </div>
    </Card>
  );
}
