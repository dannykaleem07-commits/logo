/**
 * Client for the exact (licensed) 3D model routes (apps/api/src/routes/models3d.ts). Shapes are copied here because the
 * web cannot import the API package. Uploads use XMLHttpRequest for progress (fetch has no upload progress); every
 * other call goes through the shared `request` helper (cookie session, error mapping, manager-mode headers).
 */
import { ApiError, API_BASE, request, seg } from '../../../../api/client';

export const LICENCE_NOTICE = 'Use only models you have a licence for. Audatex/Qapter models cannot be imported.';

export type PartPos = 'front' | 'rear';
export type ForwardAxis = '+x' | '-x' | '+z' | '-z';
export type ModelBodyType = 'hatchback' | 'saloon' | 'estate' | 'coupe' | 'convertible' | 'suv' | 'mpv' | 'panel-van' | 'pickup';

export interface ZoneGuess {
  zone: string | null;
  source: 'name' | 'name+position' | 'position';
  confidence: number;
  rule: string;
}

export interface Model3dPart {
  key: string;
  node: number;
  primitive: number;
  name: string;
  meshName?: string;
  material?: number;
  materialName?: string;
  parents: string[];
  triangles: number;
  bbox?: [number[], number[]];
}

export interface Model3dMaterial {
  index: number;
  name: string;
  role: 'paint' | 'glass' | 'plate' | 'other';
}

export interface Model3dAssignment {
  makeSlug: string;
  make: string;
  modelSlug: string;
  model: string;
  generationId?: string;
  generation?: string;
  years?: { from: number; to: number | null };
  bodyType?: ModelBodyType;
}

export interface ModelFrame {
  forward: ForwardAxis;
  mirror: boolean;
  source: 'auto' | 'owner';
}

export interface PlatePart {
  key: string;
  position: PartPos;
}

export interface Model3dSummary {
  id: string;
  title: string;
  fileName: string;
  sourceFormat: 'glb' | 'gltf' | 'zip';
  bytes: number;
  sha256: string;
  assignment: Model3dAssignment;
  licence: { confirmed: true; note?: string; confirmedBy: string; confirmedAt: string };
  active: boolean;
  stats: { triangles: number; nodes: number; meshes: number; materials: number; textures: number; parts: number; extensionsUsed: string[] };
  warnings: string[];
  frame: ModelFrame;
  paintMaterials: number[];
  plateParts: PlatePart[];
  thumbnail: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  mappedParts: number;
  taggedParts: number;
}

export interface Model3dView extends Omit<Model3dSummary, 'mappedParts' | 'taggedParts'> {
  parts: Model3dPart[];
  materials: Model3dMaterial[];
  autoZones: Record<string, ZoneGuess>;
  tags: Record<string, string | null>;
  /** Effective zone per part key (tags over automatic). */
  zones: Record<string, string>;
  /** Path under /api. */
  fileUrl: string;
  thumbnailUrl?: string;
}

export interface Models3dLimits {
  maxBytes: number;
  maxTriangles: number;
  maxNodes: number;
  accept: string[];
  notice: string;
  zones: string[];
}

export type MatchedOn = 'generation+body' | 'generation' | 'year+body' | 'year' | 'model+body' | 'model';

export interface Model3dMatch {
  model: Model3dView | null;
  matchedOn: MatchedOn | null;
  makeSlug?: string;
  modelSlug?: string;
}

export interface Model3dMatchQuery {
  makeSlug?: string;
  modelSlug?: string;
  generationId?: string;
  make?: string;
  model?: string;
  bodyType?: string;
  year?: number;
}

export interface UploadModelFields {
  file: File | Blob;
  fileName?: string;
  makeSlug: string;
  modelSlug: string;
  generationId?: string;
  bodyType?: string;
  title?: string;
  licenceConfirmed: boolean;
  licenceNote?: string;
}

export interface ModelPatchBody {
  title?: string;
  active?: boolean;
  assignment?: { makeSlug: string; modelSlug: string; generationId?: string | null; bodyType?: ModelBodyType | null };
  frame?: { forward: ForwardAxis; mirror: boolean };
  paintMaterials?: number[];
  plateParts?: PlatePart[];
  licenceNote?: string;
}

/** Absolute URL (same origin) of a path the API returned, e.g. `/models3d/<id>/model.glb`. */
export const apiUrl = (p: string): string => `${API_BASE}${p}`;

export function buildModelUploadForm(f: UploadModelFields): FormData {
  const fd = new FormData();
  fd.append('makeSlug', f.makeSlug);
  fd.append('modelSlug', f.modelSlug);
  if (f.generationId) fd.append('generationId', f.generationId);
  if (f.bodyType) fd.append('bodyType', f.bodyType);
  if (f.title?.trim()) fd.append('title', f.title.trim());
  if (f.licenceConfirmed) fd.append('licenceConfirmed', 'true');
  if (f.licenceNote?.trim()) fd.append('licenceNote', f.licenceNote.trim());
  // the file goes last so the fields are read before the large part streams in
  fd.append('file', f.file, f.fileName ?? ((f.file as File).name || 'model.glb'));
  return fd;
}

function parseXhrError(xhr: XMLHttpRequest, url: string): ApiError {
  let code = 'HTTP_ERROR';
  let message = `Upload failed (${xhr.status})`;
  let details: unknown;
  try {
    const body = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    /* not JSON */
  }
  return new ApiError(xhr.status, code, message, url, details);
}

/** POST /models3d with upload progress (0..1). */
export function uploadModel3d(fields: UploadModelFields, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Model3dView> {
  const url = apiUrl('/models3d');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(1, e.loaded / Math.max(1, e.total)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Model3dView);
        } catch {
          reject(new ApiError(xhr.status, 'BAD_RESPONSE', 'The server answered with something that is not JSON', url));
        }
      } else reject(parseXhrError(xhr, url));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Cannot reach the ClaimDesk API', url));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(buildModelUploadForm(fields));
  });
}

export const models3dApi = {
  list: (signal?: AbortSignal) => request<{ items: Model3dSummary[]; notice: string }>('/models3d', { method: 'GET', signal }),
  limits: (signal?: AbortSignal) => request<Models3dLimits>('/models3d/limits', { method: 'GET', signal }),
  get: (id: string, signal?: AbortSignal) => request<Model3dView>(`/models3d/${seg(id)}`, { method: 'GET', signal }),
  match: (q: Model3dMatchQuery, signal?: AbortSignal) => {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && String(v).trim() !== '') query[k] = String(v);
    return request<Model3dMatch>('/models3d/match', { method: 'GET', query, signal });
  },
  upload: uploadModel3d,
  patch: (id: string, body: ModelPatchBody) => request<Model3dView>(`/models3d/${seg(id)}`, { method: 'PATCH', body }),
  saveTags: (id: string, body: { tags: Record<string, string | null>; clear?: string[]; replace?: boolean }) => request<Model3dView>(`/models3d/${seg(id)}/tags`, { method: 'PUT', body }),
  saveThumbnail: (id: string, dataUrl: string) => request<{ thumbnailUrl: string }>(`/models3d/${seg(id)}/thumbnail`, { method: 'PUT', body: { dataUrl } }),
  remove: (id: string) => request<void>(`/models3d/${seg(id)}`, { method: 'DELETE' }),
};
