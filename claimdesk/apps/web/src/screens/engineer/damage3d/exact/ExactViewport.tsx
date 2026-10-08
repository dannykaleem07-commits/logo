/**
 * three.js viewport for an imported (licensed) glTF model. Shared by the damage view (ExactModelView) and the tagging
 * tool in Settings. Loaded lazily, so three.js and GLTFLoader live in their own chunk.
 *
 *  - The model is turned so its nose points to +X and its left side to -Z (the generated model's convention, so the
 *    same camera presets apply), sat on the ground and centred. `record.frame` says which way the model faces.
 *  - Every glTF primitive keeps its part key (`n<node>p<primitive>`, from GLTFLoader's associations); materials are
 *    cloned per mesh so a style on one part never bleeds into another that shared the material.
 *  - Body-paint materials take the vehicle's colour; plate meshes show the registration (UK white front / yellow rear).
 *  - Renders on demand (no animation loop); hover picking is switched off on very heavy models.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ViewPreset } from '../ThreeViewport';
import type { Paint } from '../paint';
import { drawPlate, type PlateKind } from '../plate';
import type { Model3dView } from './exactApi';
import { partKeyOf, yawFor, type Associations, type PartStyle } from './exactModel';

export interface ExactViewportProps {
  url: string;
  record: Pick<Model3dView, 'id' | 'frame' | 'paintMaterials' | 'plateParts'>;
  /** Style for a part key; re-read whenever `styleKey` changes. */
  styleFor: (key: string) => PartStyle | null;
  styleKey: string;
  view: ViewPreset;
  viewNonce: number;
  /** The vehicle's paint; null or a fallback paint keeps the model's own colours. */
  paint?: Paint | null;
  registration?: string;
  onHoverPart?: (key: string | null, clientX: number, clientY: number) => void;
  onPickPart?: (key: string, clientX: number, clientY: number) => void;
  onContextLost?: () => void;
  onProgress?: (fraction: number) => void;
  onLoaded?: (info: { triangles: number; keys: string[] }) => void;
  onError?: (message: string) => void;
  /** Receives a function that renders the current view to a PNG data URL (thumbnails), or null on unmount. */
  captureRef?: (capture: (() => string | null) | null) => void;
}

/** Same presets as the generated model: front = +X, left side = -Z. */
export function cameraOffset(view: ViewPreset, d: number): THREE.Vector3 {
  switch (view) {
    case 'front':
      return new THREE.Vector3(d, d * 0.14, 0);
    case 'rear':
      return new THREE.Vector3(-d, d * 0.14, 0);
    case 'left':
      return new THREE.Vector3(0, d * 0.14, -d);
    case 'right':
      return new THREE.Vector3(0, d * 0.14, d);
    case 'top':
      return new THREE.Vector3(0, d, d * 0.001);
    default:
      return new THREE.Vector3(d * 0.68, d * 0.34, -d * 0.66);
  }
}

const HEAVY_TRIANGLES = 600_000;

type Mat = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  metalness?: number;
  roughness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
};

interface MatEntry {
  mat: Mat;
  /** glTF material index of the original material. */
  index: number | undefined;
  base: { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; map?: THREE.Texture | null; metalness?: number; roughness?: number; clearcoat?: number; clearcoatRoughness?: number; transparent: boolean; opacity: number };
  /** Colour after paint / plate finishing; styles blend from here. */
  finished?: THREE.Color;
}

interface PartEntry {
  key: string;
  mesh: THREE.Mesh;
  mats: MatEntry[];
}

const FINISH: Record<string, { metalness: number; roughness: number; clearcoat: number; clearcoatRoughness: number }> = {
  metallic: { metalness: 0.62, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 },
  pearl: { metalness: 0.45, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 },
  solid: { metalness: 0.05, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.08 },
  matte: { metalness: 0.2, roughness: 0.72, clearcoat: 0, clearcoatRoughness: 0.6 },
};

function shadowTexture(): THREE.Texture | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  } catch {
    return null;
  }
}

function plateTexture(reg: string, kind: PlateKind, aniso: number): THREE.Texture | null {
  try {
    const c = document.createElement('canvas');
    c.width = 1040;
    c.height = 222;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    drawPlate(ctx, reg, kind, c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // glTF UVs start top-left
    t.anisotropy = aniso;
    return t;
  } catch {
    return null;
  }
}

export default function ExactViewport(props: ExactViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const api = useRef<{
    parts: PartEntry[];
    render: () => void;
    goTo: (view: ViewPreset, animate: boolean) => void;
    applyFrame: () => void;
    applyFinish: () => void;
    applyStyles: () => void;
  } | null>(null);

  // scene per model file
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch {
      propsRef.current.onContextLost?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    host.appendChild(renderer.domElement);
    renderer.domElement.className = 'dmx-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new THREE.Scene();
    const disposables: Array<{ dispose: () => void }> = [];
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.035).texture;
    scene.environment = env;
    disposables.push(env, pmrem, room);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.5));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(3, 6, -4);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-4, 2.5, 4);
    scene.add(fill);

    // placer (centre + ground) → mirror (scale z) → yaw (nose to +X) → glTF scene
    const placer = new THREE.Group();
    const mirror = new THREE.Group();
    const yaw = new THREE.Group();
    placer.add(mirror);
    mirror.add(yaw);
    scene.add(placer);

    const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.rotateSpeed = 0.8;
    const target = new THREE.Vector3();
    let dist = 10;
    let size = new THREE.Vector3(4.2, 1.5, 1.8);

    let raf = 0;
    const render = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderer.render(scene, camera);
      });
    };
    controls.addEventListener('change', render);

    let anim = 0;
    const goTo = (view: ViewPreset, animate: boolean) => {
      cancelAnimationFrame(anim);
      const to = target.clone().add(cameraOffset(view, dist));
      if (!animate) {
        camera.position.copy(to);
        controls.update();
        render();
        return;
      }
      const from = camera.position.clone();
      const r0 = from.distanceTo(target);
      const r1 = to.distanceTo(target);
      const d0 = from.clone().sub(target).normalize();
      const d1 = to.clone().sub(target).normalize();
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 380);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const dir = d0.clone().lerp(d1, e);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        camera.position.copy(target).add(dir.normalize().multiplyScalar(r0 + (r1 - r0) * e));
        controls.update();
        renderer.render(scene, camera);
        if (t < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    };

    const fitDist = (aspect: number) => {
      const L = size.x;
      const W = size.z;
      const H = size.y;
      const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      return Math.max(Math.max(L, H * 1.8) * 1.9, (L * 0.62) / Math.tan(halfH) + W / 2);
    };
    const resize = () => {
      const w = host.clientWidth || 600;
      const h = host.clientHeight || 380;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const next = fitDist(camera.aspect);
      if (Math.abs(next - dist) > 1e-3 * next) {
        const k = next / dist;
        dist = next;
        controls.minDistance = dist * 0.35;
        controls.maxDistance = dist * 1.8;
        camera.position.sub(target).multiplyScalar(k).add(target);
        controls.update();
      }
      render();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(host);

    // shadow (sized once the model is placed)
    const shadowTex = shadowTexture();
    let shadow: THREE.Mesh | null = null;
    if (shadowTex) {
      shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.raycast = () => {};
      scene.add(shadow);
      disposables.push(shadowTex, shadow.geometry, shadow.material as THREE.Material);
    }

    const parts: PartEntry[] = [];
    let triangles = 0;
    const plateTextures: THREE.Texture[] = [];
    const aniso = renderer.capabilities.getMaxAnisotropy();

    const applyFrame = () => {
      const f = propsRef.current.record.frame;
      yaw.rotation.set(0, yawFor(f.forward), 0);
      mirror.scale.set(1, 1, f.mirror ? -1 : 1);
      placer.position.set(0, 0, 0);
      placer.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mirror);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      placer.position.set(-c.x, -box.min.y, -c.z);
      placer.updateMatrixWorld(true);
      size = box.getSize(new THREE.Vector3());
      target.set(0, size.y * 0.42, 0);
      controls.target.copy(target);
      camera.near = Math.max(1e-3, size.x * 0.01);
      camera.far = size.x * 40;
      camera.updateProjectionMatrix();
      if (shadow) {
        shadow.scale.set(size.x * 1.18, size.z * 1.35, 1);
        shadow.position.y = size.y * 0.001;
      }
      dist = fitDist(camera.aspect || 1.6);
      controls.minDistance = dist * 0.35;
      controls.maxDistance = dist * 1.8;
    };

    const applyFinish = () => {
      const { record, paint, registration } = propsRef.current;
      const paintSet = new Set(record.paintMaterials);
      const usePaint = !!paint && !paint.fallback;
      const plateKind = new Map(record.plateParts.map((p) => [p.key, p.position]));
      for (const t of plateTextures.splice(0)) t.dispose();
      const texFor = new Map<PlateKind, THREE.Texture | null>();
      const reg = registration?.trim();
      for (const part of parts) {
        const plate = plateKind.get(part.key);
        const hasUv = !!part.mesh.geometry.getAttribute('uv');
        for (const m of part.mats) {
          const { mat, base } = m;
          if (base.color && mat.color) mat.color.copy(base.color);
          if ('map' in mat) mat.map = base.map ?? null;
          if (base.metalness !== undefined) mat.metalness = base.metalness;
          if (base.roughness !== undefined) mat.roughness = base.roughness;
          if (base.clearcoat !== undefined) mat.clearcoat = base.clearcoat;
          if (base.clearcoatRoughness !== undefined) mat.clearcoatRoughness = base.clearcoatRoughness;
          if (usePaint && m.index !== undefined && paintSet.has(m.index) && mat.color) {
            mat.color.set(paint!.hex);
            if ('map' in mat) mat.map = null;
            const fin = FINISH[paint!.finish] ?? FINISH.metallic!;
            if (mat.metalness !== undefined) mat.metalness = fin.metalness;
            if (mat.roughness !== undefined) mat.roughness = fin.roughness;
            if (mat.clearcoat !== undefined) {
              mat.clearcoat = fin.clearcoat;
              mat.clearcoatRoughness = fin.clearcoatRoughness;
            }
          }
          if (plate && reg && hasUv) {
            if (!texFor.has(plate)) {
              const t = plateTexture(reg, plate, aniso);
              texFor.set(plate, t);
              if (t) plateTextures.push(t);
            }
            const t = texFor.get(plate);
            if (t && 'map' in mat) {
              mat.map = t;
              mat.color?.set('#ffffff');
              if (mat.metalness !== undefined) mat.metalness = 0;
              if (mat.roughness !== undefined) mat.roughness = 0.4;
            }
          }
          mat.needsUpdate = true;
          m.finished = mat.color?.clone();
        }
      }
    };

    const tmp = new THREE.Color();
    const applyStyles = () => {
      const { styleFor } = propsRef.current;
      for (const part of parts) {
        const s = styleFor(part.key);
        for (const m of part.mats) {
          const { mat, base } = m;
          if (mat.color && m.finished) {
            mat.color.copy(m.finished);
            if (s?.colour) mat.color.lerp(tmp.set(s.colour), s.mix ?? 0.7);
          }
          if (mat.emissive) {
            if (s?.emissive) {
              mat.emissive.set(s.emissive);
              mat.emissiveIntensity = s.emissiveIntensity ?? 0.4;
            } else {
              if (base.emissive) mat.emissive.copy(base.emissive);
              mat.emissiveIntensity = base.emissiveIntensity ?? 1;
            }
          }
          const dim = !!s?.dim;
          mat.transparent = dim || base.transparent;
          mat.opacity = dim ? Math.min(base.opacity, 0.3) : base.opacity;
        }
      }
      render();
    };

    // picking
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (cx: number, cy: number): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(placer, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
      return (hit?.object.userData.partKey as string | undefined) ?? null;
    };
    let down: { x: number; y: number } | null = null;
    let hoverRaf = 0;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5 || e.button !== 0) return;
      const k = pick(e.clientX, e.clientY);
      if (k) propsRef.current.onPickPart?.(k, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons || triangles > HEAVY_TRIANGLES || !propsRef.current.onHoverPart) return;
      cancelAnimationFrame(hoverRaf);
      const { clientX, clientY } = e;
      hoverRaf = requestAnimationFrame(() => propsRef.current.onHoverPart?.(pick(clientX, clientY), clientX, clientY));
    };
    const onLeave = () => {
      cancelAnimationFrame(hoverRaf);
      propsRef.current.onHoverPart?.(null, 0, 0);
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      propsRef.current.onContextLost?.();
    };
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('webglcontextlost', onLost);

    const capture = (): string | null => {
      try {
        renderer.render(scene, camera);
        const src = renderer.domElement;
        const out = document.createElement('canvas');
        out.width = 480;
        out.height = 300;
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        const k = Math.max(out.width / src.width, out.height / src.height);
        const w = src.width * k;
        const h = src.height * k;
        ctx.drawImage(src, (out.width - w) / 2, (out.height - h) / 2, w, h);
        return out.toDataURL('image/png');
      } catch {
        return null;
      }
    };

    // load
    const loader = new GLTFLoader();
    loader.setWithCredentials(false); // same-origin request: the session cookie is sent anyway
    let loaded: THREE.Group | null = null;
    loader.load(
      propsRef.current.url,
      (gltf) => {
        if (disposed) {
          gltf.scene.traverse((o) => disposeObject(o));
          return;
        }
        loaded = gltf.scene;
        const assoc = gltf.parser.associations as unknown as Associations;
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const key = partKeyOf(mesh as unknown as Parameters<typeof partKeyOf>[0], assoc);
          const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const mats: MatEntry[] = originals.map((orig) => {
            const mat = orig.clone() as Mat;
            const index = (assoc.get(orig) as { materials?: number } | undefined)?.materials;
            return {
              mat,
              index,
              base: {
                ...(mat.color ? { color: mat.color.clone() } : {}),
                ...(mat.emissive ? { emissive: mat.emissive.clone(), emissiveIntensity: mat.emissiveIntensity ?? 1 } : {}),
                ...('map' in mat ? { map: mat.map ?? null } : {}),
                ...(mat.metalness !== undefined ? { metalness: mat.metalness } : {}),
                ...(mat.roughness !== undefined ? { roughness: mat.roughness } : {}),
                ...(mat.clearcoat !== undefined ? { clearcoat: mat.clearcoat, clearcoatRoughness: mat.clearcoatRoughness ?? 0 } : {}),
                transparent: mat.transparent,
                opacity: mat.opacity,
              },
            };
          });
          mesh.material = Array.isArray(mesh.material) ? mats.map((m) => m.mat) : mats[0]!.mat;
          const geo = mesh.geometry;
          triangles += geo.index ? geo.index.count / 3 : (geo.getAttribute('position')?.count ?? 0) / 3;
          if (key) {
            mesh.userData.partKey = key;
            parts.push({ key, mesh, mats });
          }
        });
        yaw.add(gltf.scene);
        applyFrame();
        applyFinish();
        applyStyles();
        resize();
        goTo(propsRef.current.view, false);
        api.current = { parts, render, goTo, applyFrame, applyFinish, applyStyles };
        propsRef.current.captureRef?.(capture);
        propsRef.current.onLoaded?.({ triangles: Math.round(triangles), keys: parts.map((p) => p.key) });
      },
      (e) => {
        if (!disposed && e.lengthComputable && e.total > 0) propsRef.current.onProgress?.(e.loaded / e.total);
      },
      (err) => {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : String(err);
        propsRef.current.onError?.(`The 3D model could not be loaded: ${msg}`);
      }
    );

    resize();
    return () => {
      disposed = true;
      api.current = null;
      propsRef.current.captureRef?.(null);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(anim);
      cancelAnimationFrame(hoverRaf);
      ro?.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('webglcontextlost', onLost);
      controls.dispose();
      for (const t of plateTextures) t.dispose();
      if (loaded) loaded.traverse((o) => disposeObject(o));
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [props.url, props.record.id]);

  // frame, finish, styles, camera
  const f = props.record.frame;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.applyFrame();
    a.goTo(propsRef.current.view, false);
  }, [f.forward, f.mirror]);
  const paintKey = props.paint && !props.paint.fallback ? `${props.paint.hex}|${props.paint.finish}` : '';
  const finishKey = `${paintKey}|${props.registration ?? ''}|${props.record.paintMaterials.join(',')}|${props.record.plateParts.map((p) => `${p.key}:${p.position}`).join(',')}`;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.applyFinish();
    a.applyStyles();
  }, [finishKey]);
  useEffect(() => {
    api.current?.applyStyles();
  }, [props.styleKey]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    api.current?.goTo(props.view, true);
  }, [props.view, props.viewNonce]);

  return <div ref={hostRef} className="dmx-host" />;
}

function disposeObject(o: THREE.Object3D): void {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (!m) continue;
    for (const v of Object.values(m)) if (v && typeof v === 'object' && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
    m.dispose();
  }
}
