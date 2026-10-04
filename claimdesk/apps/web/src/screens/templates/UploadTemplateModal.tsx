import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../../api/client';
import { useUploadDocxTemplate, type DocxTemplateDetail } from '../../api/templatesApi';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Field, Select, TextArea, TextInput } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { emptyUploadForm, RECIPIENT_ROLE_OPTIONS, TEMPLATE_KIND_OPTIONS, titleFromFileName, validateUpload, type UploadForm } from './templates';

/** Settings → Document templates → "Upload a Word template" (multipart POST /docx-templates). */
export function UploadTemplateModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: (detail: DocxTemplateDetail) => void }) {
  const [form, setForm] = useState<Omit<UploadForm, 'file'>>(() => {
    const { file: _file, ...rest } = emptyUploadForm();
    return rest;
  });
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const upload = useUploadDocxTemplate();
  const toast = useToast();
  const fileId = useId();

  const set = <K extends keyof Omit<UploadForm, 'file'>>(k: K) => (v: Omit<UploadForm, 'file'>[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const e = validateUpload({ ...form, file: file ? { name: file.name, size: file.size } : null });
    setErrors(e);
    if (Object.keys(e).length > 0 || !file) return;
    upload.mutate(
      { file, fileName: file.name, title: form.title, kind: form.kind, description: form.description || undefined, recipientRole: form.recipientRole || undefined },
      {
        onSuccess: (detail) => {
          toast.success(`${detail.title} uploaded — check the mapping, then save it`);
          onUploaded(detail);
        }
      }
    );
  };

  const err = upload.error;
  const duplicateId = isApiError(err) && err.code === 'TEMPLATE_DUPLICATE' ? (err.details as { id?: string } | undefined)?.id : undefined;
  const issues = isApiError(err) && err.code === 'INVALID_DOCX' ? issueMessages(err.details) : [];

  return (
    <Modal
      open
      size="lg"
      title="Upload a Word template"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={upload.isPending} onClick={submit}>
            Upload
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
        <div className="notice notice-info small">
          Put <code>{'{{claim.reference}}'}</code>-style fields, <code>[brackets]</code>, <code>____</code> blanks or empty cells next to labels where values should go. Signature and date-signed lines are always left blank.
        </div>
        <Field label="Word file" required error={errors.file} hint="A .docx or .dotx file, up to 15 MB. Tracked changes and comments are reported for review." htmlFor={fileId}>
          <input
            id={fileId}
            type="file"
            className="input"
            accept=".docx,.dotx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.wordprocessingml.template"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !form.title.trim()) setForm((s) => ({ ...s, title: titleFromFileName(f.name) }));
            }}
          />
        </Field>
        <div className="form-grid">
          <TextInput label="Title" required value={form.title} onChange={set('title')} error={errors.title} maxLength={200} />
          <Select label="Kind" required value={form.kind} onChange={(v) => set('kind')(v)} options={TEMPLATE_KIND_OPTIONS} error={errors.kind} />
          <Select label="Usual recipient" value={form.recipientRole} onChange={(v) => set('recipientRole')(v)} options={RECIPIENT_ROLE_OPTIONS} placeholder="— none —" />
        </div>
        <TextArea label="Description" value={form.description} onChange={set('description')} rows={2} hint="Shown on the template card when a handler fills it" />
        <ApiErrorNotice error={err} what="upload the template" />
        {duplicateId && (
          <div className="small">
            This file is already in the library: <Link to={`/settings/templates/${encodeURIComponent(duplicateId)}`}>open the existing template</Link>.
          </div>
        )}
        {issues.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {issues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </form>
    </Modal>
  );
}

function issueMessages(details: unknown): string[] {
  const list = Array.isArray(details) ? details : Array.isArray((details as { issues?: unknown[] } | undefined)?.issues) ? (details as { issues: unknown[] }).issues : [];
  return list.map((i) => (i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string' ? (i as { message: string }).message : String(i)));
}
