/**
 * Zone-tagging tool for one imported model: click a part on the model (or in the list), choose its damage zone, save.
 * The automatic map (by name, then by position) is shown with its source so doubtful guesses can be checked; tags win
 * over it and are saved with the model. Also: orientation (front/rear, left/right), which materials are body paint
 * (recoloured to the vehicle's colour), which meshes are number plates, and the thumbnail.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../../api/client';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { TextInput } from '../../../components/Form';
import { useToast } from '../../../components/Toast';
import type { ViewPreset } from '../../engineer/damage3d/ThreeViewport';
import { paintFor } from '../../engineer/damage3d/paint';
import { getZone } from '../../engineer/damage3d/zones';
import { apiUrl, LICENCE_NOTICE, models3dApi, type Model3dView, type PartPos } from '../../engineer/damage3d/exact/exactApi';
import { AREA_COLOURS, formatBytes, tagPartStyle, tagsBodyFor, UNMAPPED_COLOUR, zonesWithPending } from '../../engineer/damage3d/exact/exactModel';
import { clearExactModelCache } from '../../engineer/damage3d/exact/useExactModel';
import { assignmentLabel, FORWARD_LABEL, mappingSummary, partRows, reverseForward, SOURCE_LABEL, turnForward, zoneOptionGroups, type PartFilter } from './models3dSettings';
import '../../engineer/damage3d/exact/exact.css';

const ExactViewport = lazy(() => import('../../engineer/damage3d/exact/ExactViewport'));

const VIEWS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'iso', label: '3/4' },
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'top', label: 'Top' },
];

const FILTERS: Array<{ id: PartFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unmapped', label: 'Not mapped' },
  { id: 'check', label: 'To check' },
  { id: 'tagged', label: 'Tagged' },
];

const ROW_LIMIT = 400;

export interface ModelEditorProps {
  model: Model3dView;
  canEdit: boolean;
  onChanged: (model: Model3dView) => void;
  onClose: () => void;
}

export function ModelEditor({ model, canEdit, onChanged, onClose }: ModelEditorProps) {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, string | null | 'auto'>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [filter, setFilter] = useState<PartFilter>('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewPreset>('iso');
  const [viewNonce, setViewNonce] = useState(0);
  const [previewColour, setPreviewColour] = useState('');
  const [previewReg, setPreviewReg] = useState('AB12 CDE');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ triangles: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const capture = useRef<(() => string | null) | null>(null);
  const autoThumb = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  // a different model, or the server answered with a new version: drop edits that are now saved
  useEffect(() => {
    setPending({});
  }, [model.id, model.updatedAt]);

  const zones = useMemo(() => zonesWithPending(model, pending), [model, pending]);
  const rows = useMemo(() => partRows(model, pending, filter, search), [model, pending, filter, search]);
  const summary = useMemo(() => mappingSummary(model, pending), [model, pending]);
  const groups = useMemo(() => zoneOptionGroups(model.assignment.bodyType), [model.assignment.bodyType]);
  const changes = Object.keys(pending).length;
  const selectedRow = selected ? partRows(model, pending).find((r) => r.key === selected) : undefined;
  const selectedPart = selected ? model.parts.find((p) => p.key === selected) : undefined;
  const paint = useMemo(() => (previewColour.trim() ? paintFor(previewColour) : null), [previewColour]);

  const styleFor = useCallback((key: string) => tagPartStyle(zones[key], { selected: key === selected, hovered: key === hovered, showUnmapped: true }), [zones, selected, hovered]);
  const styleKey = `${selected ?? ''}|${hovered ?? ''}|${Object.entries(pending).map(([k, v]) => `${k}=${v}`).join(',')}|${model.updatedAt}`;

  const pick = useCallback((key: string) => {
    setSelected(key);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.scrollIntoView?.({ block: 'nearest' }));
  }, []);

  const setZone = (key: string, value: string) => {
    setPending((p) => {
      const next = { ...p };
      const saved = model.tags[key];
      const v: string | null | 'auto' = value === '__none' ? null : value === '__auto' ? 'auto' : value;
      // back to what is saved → no pending edit
      if ((v === 'auto' && saved === undefined) || (v !== 'auto' && saved !== undefined && saved === v)) delete next[key];
      else next[key] = v;
      return next;
    });
  };

  const save = async () => {
    if (!changes) return;
    setSaving(true);
    try {
      const updated = await models3dApi.saveTags(model.id, tagsBodyFor(pending));
      clearExactModelCache();
      onChanged(updated);
      toast.success(`Saved ${changes} part ${changes === 1 ? 'tag' : 'tags'}`);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const patch = async (body: Parameters<typeof models3dApi.patch>[1], done: string) => {
    try {
      const updated = await models3dApi.patch(model.id, body);
      clearExactModelCache();
      onChanged(updated);
      toast.success(done);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : (e as Error).message);
    }
  };

  const saveThumbnail = useCallback(
    async (quiet: boolean) => {
      const data = capture.current?.();
      if (!data) {
        if (!quiet) toast.error('The view could not be captured');
        return;
      }
      try {
        await models3dApi.saveThumbnail(model.id, data);
        onChanged({ ...model, thumbnail: true, thumbnailUrl: `/models3d/${model.id}/thumbnail.png?t=${Date.now()}` });
        if (!quiet) toast.success('Thumbnail saved');
      } catch (e) {
        if (!quiet) toast.error(isApiError(e) ? e.message : (e as Error).message);
      }
    },
    [model, onChanged, toast]
  );

  const plateKeys = new Map(model.plateParts.map((p) => [p.key, p.position]));
  const setPlate = (key: string, position: PartPos | null) => {
    const next = model.plateParts.filter((p) => p.key !== key);
    if (position) next.push({ key, position });
    void patch({ plateParts: next }, position ? 'Number plate set' : 'Number plate removed');
  };

  const visibleRows = showAll ? rows : rows.slice(0, ROW_LIMIT);
  const currentValue = selected ? (pending[selected] !== undefined ? (pending[selected] === null ? '__none' : pending[selected] === 'auto' ? '__auto' : (pending[selected] as string)) : model.tags[selected] === null ? '__none' : model.tags[selected] !== undefined ? (model.tags[selected] as string) : '__auto') : '__auto';
  const autoZone = selected ? model.autoZones[selected] : undefined;

  return (
    <div className="m3d-editor">
      <div className="m3d-editor-head">
        <div>
          <h3 className="m3d-title">{model.title}</h3>
          <div className="xs muted">
            {assignmentLabel(model.assignment)} · {model.stats.parts} parts · {model.stats.triangles.toLocaleString('en-GB')} triangles · {formatBytes(model.bytes)} · {model.fileName}
          </div>
        </div>
        <div className="row">
          {!model.active && <Badge tone="amber">switched off</Badge>}
          <Button variant="ghost" onClick={onClose}>
            ← All models
          </Button>
        </div>
      </div>
      {model.warnings.length > 0 && (
        <div className="notice notice-warn xs" role="status">
          {model.warnings.join(' ')}
        </div>
      )}

      <div className="m3d-editor-grid">
        <div className="m3d-stage">
          <div className="m3d-toolbar">
            <div className="m3d-seg" role="group" aria-label="Camera view">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={view === v.id}
                  onClick={() => {
                    setView(v.id);
                    setViewNonce((n) => n + 1);
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <span className="xs muted">{loaded ? `${loaded.triangles.toLocaleString('en-GB')} triangles shown` : ''}</span>
          </div>
          <div className="dmx-wrap m3d-viewport">
            {loadError ? (
              <div className="dmx-loading dmx-error" role="alert">
                {loadError}
              </div>
            ) : (
              <Suspense fallback={<div className="dmx-loading">Loading 3D viewer…</div>}>
                <ExactViewport
                  url={apiUrl(model.fileUrl)}
                  record={model}
                  styleFor={styleFor}
                  styleKey={styleKey}
                  view={view}
                  viewNonce={viewNonce}
                  paint={paint}
                  registration={previewReg}
                  onHoverPart={(k) => setHovered(k)}
                  onPickPart={(k) => pick(k)}
                  onError={(m) => setLoadError(m)}
                  onLoaded={(info) => {
                    setLoaded({ triangles: info.triangles });
                    if (canEdit && !model.thumbnail && !autoThumb.current) {
                      autoThumb.current = true;
                      setTimeout(() => void saveThumbnail(true), 300);
                    }
                  }}
                  captureRef={(c) => {
                    capture.current = c;
                  }}
                />
              </Suspense>
            )}
            {!loaded && !loadError && <div className="dmx-loading">Loading model…</div>}
            {hovered && (
              <div className="dmx-badge m3d-hover" role="status">
                {model.parts.find((p) => p.key === hovered)?.name} → {zones[hovered] ? getZone(zones[hovered]!)?.label : 'not mapped'}
              </div>
            )}
          </div>
          <ul className="m3d-legend" aria-label="Colours">
            {Object.entries(AREA_COLOURS).map(([area, colour]) => (
              <li key={area}>
                <span className="m3d-swatch" style={{ background: colour }} />
                {groups.find((g) => g.area === area)?.label ?? area}
              </li>
            ))}
            <li>
              <span className="m3d-swatch" style={{ background: UNMAPPED_COLOUR }} />
              Not mapped
            </li>
          </ul>
          <div className="form-grid m3d-preview">
            <TextInput label="Preview colour" value={previewColour} onChange={setPreviewColour} placeholder="e.g. Magnetic Grey, BLUE" hint={paint ? `${paint.name} · ${paint.finish}${paint.fallback ? ' (not recognised — model colours kept)' : ''}` : 'Blank = the model’s own colours'} />
            <TextInput label="Preview registration" value={previewReg} onChange={setPreviewReg} placeholder="AB12 CDE" hint={model.plateParts.length ? 'Shown on the number-plate meshes' : 'No number-plate mesh is set (see below)'} />
          </div>
        </div>

        <aside className="m3d-parts" aria-label="Parts">
          <div className="m3d-summary">
            <span>
              <strong>{summary.mapped}</strong> of {summary.parts} parts mapped
            </span>
            {summary.unmapped > 0 && <Badge tone="red">{summary.unmapped} not mapped</Badge>}
            {summary.check > 0 && <Badge tone="amber">{summary.check} to check</Badge>}
            {summary.tagged > 0 && <Badge tone="blue">{summary.tagged} tagged</Badge>}
          </div>

          {selected && selectedRow && (
            <div className="m3d-selected">
              <div className="m3d-selected-name">{selectedRow.name}</div>
              <div className="xs muted">{selectedRow.detail || selected}</div>
              <div className="xs">
                Now: <strong>{selectedRow.zoneLabel}</strong> · {SOURCE_LABEL[selectedRow.source]}
              </div>
              {canEdit ? (
                <label className="m3d-zone-pick">
                  <span className="sr-only">Damage zone for {selectedRow.name}</span>
                  <select className="select" value={currentValue} onChange={(e) => setZone(selected, e.target.value)} aria-label={`Damage zone for ${selectedRow.name}`}>
                    <option value="__auto">Automatic{autoZone?.zone ? ` (${getZone(autoZone.zone)?.label ?? autoZone.zone})` : ' (not mapped)'}</option>
                    <option value="__none">Not a damage part</option>
                    {groups.map((g) => (
                      <optgroup key={g.area} label={g.label}>
                        {g.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : null}
              {canEdit && selectedPart && (
                <div className="row xs">
                  <span className="muted">Number plate:</span>
                  {(['front', 'rear'] as const).map((pos) => (
                    <button key={pos} type="button" className="m3d-link" aria-pressed={plateKeys.get(selected) === pos} onClick={() => setPlate(selected, plateKeys.get(selected) === pos ? null : pos)}>
                      {plateKeys.get(selected) === pos ? `✓ ${pos}` : pos}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="m3d-filters">
            <div className="m3d-seg" role="group" aria-label="Show parts">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input className="input" type="search" placeholder="Search parts" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search parts" />
          </div>
          <div className="m3d-rows" ref={listRef}>
            {visibleRows.length === 0 ? (
              <p className="xs muted m3d-empty">No parts here.</p>
            ) : (
              <ul>
                {visibleRows.map((r) => (
                  <li key={r.key} data-key={r.key} className={`${r.key === selected ? 'is-active' : ''} m3d-src-${r.source.replace('+', '-')}`.trim()}>
                    <button type="button" onClick={() => setSelected(r.key)} onMouseEnter={() => setHovered(r.key)} onMouseLeave={() => setHovered(null)}>
                      <span className="m3d-row-name">
                        {r.name}
                        {r.pending && <span className="m3d-pending" title="Not saved yet"> •</span>}
                      </span>
                      <span className="m3d-row-zone">{r.zoneLabel}</span>
                      <span className="m3d-row-src">{SOURCE_LABEL[r.source]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!showAll && rows.length > ROW_LIMIT && (
              <button type="button" className="m3d-link m3d-more" onClick={() => setShowAll(true)}>
                Show all {rows.length} parts
              </button>
            )}
          </div>
          {canEdit && (
            <div className="m3d-savebar">
              <span className="xs muted">{changes ? `${changes} unsaved ${changes === 1 ? 'change' : 'changes'}` : 'Click a part on the model to tag it'}</span>
              <div className="row">
                <Button variant="ghost" size="sm" disabled={!changes || saving} onClick={() => setPending({})}>
                  Discard
                </Button>
                <Button variant="primary" size="sm" disabled={!changes} loading={saving} onClick={() => void save()}>
                  Save tags
                </Button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {canEdit && (
        <details className="m3d-advanced">
          <summary>Orientation, paint, plates, thumbnail and licence</summary>
          <div className="m3d-advanced-grid">
            <section>
              <h4>Orientation</h4>
              <p className="xs muted">
                The nose points along <strong>{FORWARD_LABEL[model.frame.forward]}</strong>
                {model.frame.mirror ? ', left and right swapped' : ''} ({model.frame.source === 'auto' ? 'worked out from the part names' : 'set here'}). If the Front view shows the back of the car, turn it. Parts placed by position are re-mapped.
              </p>
              <div className="row">
                <Button size="sm" onClick={() => void patch({ frame: { forward: reverseForward(model.frame.forward), mirror: model.frame.mirror } }, 'Turned 180°')}>
                  Turn 180° (front ↔ rear)
                </Button>
                <Button size="sm" onClick={() => void patch({ frame: { forward: turnForward(model.frame.forward), mirror: model.frame.mirror } }, 'Turned 90°')}>
                  Turn 90°
                </Button>
                <Button size="sm" onClick={() => void patch({ frame: { forward: model.frame.forward, mirror: !model.frame.mirror } }, 'Left and right swapped')}>
                  Swap left / right
                </Button>
              </div>
            </section>
            <section>
              <h4>Body paint</h4>
              <p className="xs muted">Ticked materials take the vehicle&apos;s colour on a claim.</p>
              <ul className="m3d-materials">
                {model.materials.map((m) => {
                  const on = model.paintMaterials.includes(m.index);
                  return (
                    <li key={m.index}>
                      <label>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => void patch({ paintMaterials: on ? model.paintMaterials.filter((i) => i !== m.index) : [...model.paintMaterials, m.index] }, on ? `${m.name} is no longer paint` : `${m.name} is body paint`)}
                        />
                        {m.name} <span className="xs muted">({m.role})</span>
                      </label>
                    </li>
                  );
                })}
                {model.materials.length === 0 && <li className="xs muted">This model has no materials.</li>}
              </ul>
            </section>
            <section>
              <h4>Number plates</h4>
              {model.plateParts.length ? (
                <ul className="m3d-materials">
                  {model.plateParts.map((p) => (
                    <li key={p.key}>
                      {model.parts.find((x) => x.key === p.key)?.name ?? p.key} · {p.position}{' '}
                      <button type="button" className="m3d-link" onClick={() => setPlate(p.key, null)}>
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="xs muted">None found by name. Select the plate part on the model and choose front or rear.</p>
              )}
            </section>
            <section>
              <h4>Thumbnail and use</h4>
              <div className="row">
                <Button size="sm" onClick={() => void saveThumbnail(false)}>
                  Use this view as the thumbnail
                </Button>
                <Button size="sm" onClick={() => void patch({ active: !model.active }, model.active ? 'Switched off: claims use the generated model' : 'Switched on for matching claims')}>
                  {model.active ? 'Switch off' : 'Switch on'}
                </Button>
              </div>
              <p className="xs muted">
                Licence confirmed by {model.licence.confirmedBy} on {model.licence.confirmedAt.slice(0, 10)}
                {model.licence.note ? ` · ${model.licence.note}` : ''}. {LICENCE_NOTICE}
              </p>
            </section>
          </div>
        </details>
      )}
    </div>
  );
}
