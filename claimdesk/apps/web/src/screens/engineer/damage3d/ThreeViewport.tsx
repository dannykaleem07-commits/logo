/**
 * three.js viewport for the damage model. Loaded lazily (React.lazy) so three.js lives in its own chunk.
 * Builds the parametric car (carMesh.ts) from the model's spec: one mesh per zone + finish (raycast → zone id), paint
 * with clear coat under a studio environment, UK plates as canvas textures, shut lines. Renders on demand.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { VehicleModel } from './geometry';
import { buildCarMesh, type CarMesh, type Tone } from './carMesh';
import { HOVER_COLOUR, SEVERITY_COLOURS, type DamageMap } from './damageModel';
import { DEFAULT_PAINT, type Paint } from './paint';
import { drawPlate, type PlateKind } from './plate';

export type ViewPreset = 'iso' | 'front' | 'rear' | 'left' | 'right' | 'top';

export interface ThreeViewportProps {
  model: VehicleModel;
  damage: DamageMap;
  hovered: string | null;
  selected: string | null;
  view: ViewPreset;
  /** Bump to re-apply the same preset. */
  viewNonce: number;
  onHover: (zone: string | null, clientX: number, clientY: number) => void;
  onPick: (zone: string, clientX: number, clientY: number) => void;
  onContextLost?: () => void;
  /** Body paint (defaults to a neutral silver). */
  paint?: Paint;
  /** Registration shown on the plates. */
  registration?: string;
  /** Called once the scene is built (tests / screenshots): triangle count. */
  onReady?: (info: { triangles: number }) => void;
}

interface Finish {
  color: string;
  metalness: number;
  roughness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Undamaged finishes per tone ('body' comes from the paint). */
const FINISH: Record<Exclude<Tone, 'body'>, Finish> = {
  glass: { color: '#16202b', metalness: 0.2, roughness: 0.06, clearcoat: 0.7, clearcoatRoughness: 0.05 },
  lamp: { color: '#3a424c', metalness: 0.7, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 },
  drl: { color: '#f4f8ff', metalness: 0, roughness: 0.3, emissive: '#e8f1ff', emissiveIntensity: 0.9 },
  rearlamp: { color: '#4d0910', metalness: 0.3, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03 },
  redglow: { color: '#e3202c', metalness: 0, roughness: 0.25, emissive: '#c4101b', emissiveIntensity: 0.65 },
  chrome: { color: '#e2e6eb', metalness: 1, roughness: 0.1 },
  black: { color: '#121316', metalness: 0.1, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 },
  trim: { color: '#24272b', metalness: 0.3, roughness: 0.5 },
  frame: { color: '#3b4047', metalness: 0.3, roughness: 0.45 },
  soft: { color: '#26282c', metalness: 0, roughness: 0.92 },
  tyre: { color: '#1a1b1d', metalness: 0, roughness: 0.88 },
  rim: { color: '#b4bac2', metalness: 0.85, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.15 },
  liner: { color: '#0f1012', metalness: 0, roughness: 0.95 }
};

/** Studio reflection strength per finish: gloss black trim and tinted glass would otherwise mirror the bright ceiling. */
const ENV_INTENSITY: Partial<Record<Tone, number>> = { glass: 0.45, black: 0.35, lamp: 0.6, frame: 0.6, trim: 0.7 };

function paintFinish(p: Paint): Finish {
  const metallic = p.finish === 'metallic' || p.finish === 'pearl';
  return {
    color: p.hex,
    metalness: metallic ? 0.55 : 0.05,
    roughness: p.finish === 'matte' ? 0.6 : metallic ? 0.32 : 0.36,
    clearcoat: p.finish === 'matte' ? 0.1 : 1,
    clearcoatRoughness: p.finish === 'matte' ? 0.5 : 0.06
  };
}

interface GroupEntry {
  zone: string | null;
  tone: Tone;
  material: THREE.MeshPhysicalMaterial;
}

function shadowTexture(): THREE.Texture | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  } catch {
    return null;
  }
}

function plateTexture(reg: string | undefined, kind: PlateKind, aniso: number): THREE.Texture | null {
  try {
    const c = document.createElement('canvas');
    c.width = 1040;
    c.height = 222;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    drawPlate(ctx, reg, kind, c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  } catch {
    return null;
  }
}

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

const MESH_CACHE = new Map<string, CarMesh>();
function meshFor(model: VehicleModel): CarMesh {
  let m = MESH_CACHE.get(model.spec.key);
  if (!m) {
    m = buildCarMesh(model.spec);
    if (MESH_CACHE.size > 12) MESH_CACHE.clear();
    MESH_CACHE.set(model.spec.key, m);
  }
  return m;
}

export default function ThreeViewport(props: ThreeViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const api = useRef<{
    groups: GroupEntry[];
    render: () => void;
    goTo: (view: ViewPreset, animate: boolean) => void;
    setPlates: (reg: string | undefined) => void;
  } | null>(null);

  // scene setup per model
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { model } = propsRef.current;
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
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);
    renderer.domElement.className = 'dm3-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const car = meshFor(model);
    const scene = new THREE.Scene();
    const disposables: Array<{ dispose: () => void }> = [];
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.035).texture;
    scene.environment = env;
    disposables.push(env, pmrem, room);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, -4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-4, 2.5, 4);
    scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);
    const groups: GroupEntry[] = [];
    for (const g of car.groups) {
      if (!g.positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
      geo.computeBoundingSphere();
      const material = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
      if (g.layer > 0) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = -g.layer;
        material.polygonOffsetUnits = -g.layer * 2;
      }
      const mesh = new THREE.Mesh(geo, material);
      mesh.userData.zone = g.zone;
      root.add(mesh);
      groups.push({ zone: g.zone, tone: g.tone, material });
      disposables.push(geo, material);
    }
    // shut lines
    if (car.lines.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(car.lines, 3));
      const lm = new THREE.LineBasicMaterial({ color: 0x07090c, transparent: true, opacity: 0.55 });
      const lines = new THREE.LineSegments(lg, lm);
      lines.raycast = () => {};
      root.add(lines);
      disposables.push(lg, lm);
    }
    // plates
    const plateMeshes: Array<{ mesh: THREE.Mesh; kind: PlateKind }> = [];
    const plateGeo = new THREE.PlaneGeometry(1, 1);
    disposables.push(plateGeo);
    const aniso = renderer.capabilities.getMaxAnisotropy();
    for (const p of car.plates) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
      const mesh = new THREE.Mesh(plateGeo, mat);
      const n = new THREE.Vector3(...p.normal);
      const up = new THREE.Vector3(...p.up);
      const right = new THREE.Vector3().crossVectors(up, n).normalize();
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(right.multiplyScalar(p.width), up.multiplyScalar(p.height), n);
      mesh.matrix.setPosition(new THREE.Vector3(...p.center));
      mesh.userData.zone = p.zone;
      root.add(mesh);
      plateMeshes.push({ mesh, kind: p.kind });
      disposables.push(mat);
    }
    const plateTextures: THREE.Texture[] = [];
    const setPlates = (reg: string | undefined) => {
      for (const t of plateTextures.splice(0)) t.dispose();
      for (const { mesh, kind } of plateMeshes) {
        const tex = plateTexture(reg, kind, aniso);
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.map = tex;
        if (!tex) mat.color.set(kind === 'rear' ? '#f5c518' : '#f7f7f2');
        mat.needsUpdate = true;
        if (tex) plateTextures.push(tex);
      }
    };
    setPlates(propsRef.current.registration);

    // soft contact shadow
    const L = car.bounds.max[0] - car.bounds.min[0];
    const Wd = car.bounds.max[2] - car.bounds.min[2];
    const H = car.bounds.max[1];
    const tex = shadowTexture();
    if (tex) {
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(L * 1.18, Wd * 1.35), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.85 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      scene.add(shadow);
      disposables.push(tex, shadow.geometry, shadow.material as THREE.Material);
    }

    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
    const target = new THREE.Vector3((car.bounds.max[0] + car.bounds.min[0]) / 2, H * 0.4, 0);
    const baseDist = Math.max(L, H * 1.8) * 1.9;
    let dist = baseDist;
    const fitDist = (aspect: number) => {
      const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      return Math.max(baseDist, (L * 0.62) / Math.tan(halfH) + Wd / 2);
    };
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.minDistance = dist * 0.4;
    controls.maxDistance = dist * 1.8;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.rotateSpeed = 0.8;

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

    const resize = () => {
      const w = host.clientWidth || 600;
      const h = host.clientHeight || 380;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const next = fitDist(camera.aspect);
      if (Math.abs(next - dist) > 0.01) {
        const k = next / dist;
        dist = next;
        controls.minDistance = dist * 0.4;
        controls.maxDistance = dist * 1.8;
        camera.position.sub(target).multiplyScalar(k).add(target);
        controls.update();
      }
      render();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(host);
    resize();
    goTo(propsRef.current.view, false);

    // picking
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (cx: number, cy: number): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      for (const hit of ray.intersectObjects(root.children, false)) {
        const z = hit.object.userData.zone as string | null | undefined;
        return z ?? null; // nearest surface wins; unselectable parts block what is behind them
      }
      return null;
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
      const z = pick(e.clientX, e.clientY);
      if (z) propsRef.current.onPick(z, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      cancelAnimationFrame(hoverRaf);
      const { clientX, clientY } = e;
      hoverRaf = requestAnimationFrame(() => propsRef.current.onHover(pick(clientX, clientY), clientX, clientY));
    };
    const onLeave = () => {
      cancelAnimationFrame(hoverRaf);
      propsRef.current.onHover(null, 0, 0);
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

    api.current = { groups, render, goTo, setPlates };
    propsRef.current.onReady?.({ triangles: car.triangles });
    return () => {
      api.current = null;
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
      for (const d of disposables) d.dispose();
      renderer.dispose();
      el.remove();
    };
  }, [props.model]);

  // finishes, damage, hover / selection
  const paint = props.paint ?? DEFAULT_PAINT;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const body = paintFinish(paint);
    for (const g of a.groups) {
      const base = g.tone === 'body' ? body : FINISH[g.tone];
      const d = g.zone ? props.damage[g.zone] : undefined;
      const damaged = !!d && d.severity > 0;
      const m = g.material;
      if (damaged) {
        m.color.set(SEVERITY_COLOURS[d!.severity]);
        m.metalness = 0.1;
        m.roughness = 0.45;
        m.clearcoat = 0.6;
        m.clearcoatRoughness = 0.2;
      } else {
        m.color.set(base.color);
        m.metalness = base.metalness;
        m.roughness = base.roughness;
        m.clearcoat = base.clearcoat ?? 0;
        m.clearcoatRoughness = base.clearcoatRoughness ?? 0;
      }
      // tinted glass reflects the studio less, so the cabin reads through it
      m.envMapIntensity = damaged ? 1 : ENV_INTENSITY[g.tone] ?? 1;
      const id = g.zone;
      const hot = id && id === props.selected ? 0.35 : id && id === props.hovered ? 0.22 : 0;
      if (hot) {
        m.emissive.set(damaged ? '#ffffff' : HOVER_COLOUR);
        m.emissiveIntensity = damaged ? hot * 0.4 : hot;
      } else {
        m.emissive.set(base.emissive ?? '#000000');
        m.emissiveIntensity = base.emissiveIntensity ?? 0;
      }
    }
    a.render();
  }, [props.damage, props.hovered, props.selected, props.model, paint.hex, paint.finish]); // eslint-disable-line react-hooks/exhaustive-deps

  // plates
  const first = useRef(true);
  useEffect(() => {
    api.current?.setPlates(props.registration);
    api.current?.render();
  }, [props.registration]);

  // preset views
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    api.current?.goTo(props.view, true);
  }, [props.view, props.viewNonce]);

  return <div ref={hostRef} className="dm3-viewport" />;
}
