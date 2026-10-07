/**
 * three.js viewport for the damage model. Loaded lazily (React.lazy) so three.js lives in its own chunk.
 * One mesh group per zone (raycast → zone id); renders on demand, not every frame.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { outwardNormal, type Part, type PolyPart, type Tone, type VehicleModel } from './geometry';
import { HOVER_COLOUR, TONE_COLOURS, zoneFill, type DamageMap } from './damageModel';

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
}

const LAYER_EPS = 0.004;
const EDGE = new THREE.Color('#6b7a8f');
const EDGE_SELECTED = new THREE.Color(HOVER_COLOUR);

interface ZoneEntry {
  zone: string;
  tone: Tone;
  material: THREE.MeshLambertMaterial;
  edges: THREE.LineBasicMaterial;
}

function polyGeometry(part: PolyPart): THREE.BufferGeometry {
  const n = outwardNormal(part);
  const off = part.layer * LAYER_EPS;
  const pts = part.pts.map((p) => new THREE.Vector3(p[0] + n[0] * off, p[1] + n[1] * off, p[2] + n[2] * off));
  // triangulate in the plane that drops the dominant normal axis
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const flat = pts.map((p) => (ax === 0 ? new THREE.Vector2(p.z, p.y) : ax === 1 ? new THREE.Vector2(p.x, p.z) : new THREE.Vector2(p.x, p.y)));
  const tris = THREE.ShapeUtils.triangulateShape(flat, []);
  const pos: number[] = [];
  const nv = new THREE.Vector3(n[0], n[1], n[2]);
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (const tri of tris) {
    const [a, b, c] = tri as [number, number, number];
    const A = pts[a]!;
    let B = pts[b]!;
    let C = pts[c]!;
    e1.subVectors(B, A);
    e2.subVectors(C, A);
    if (e1.cross(e2).dot(nv) < 0) [B, C] = [C, B];
    pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function beamGeometry(a: THREE.Vector3, b: THREE.Vector3, t: number): { geo: THREE.BufferGeometry; pos: THREE.Vector3; quat: THREE.Quaternion } {
  const len = a.distanceTo(b);
  const geo = new THREE.BoxGeometry(t, len, t);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return { geo, pos: new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), quat };
}

function shadowTexture(): THREE.Texture | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(7,38,71,0.30)');
    g.addColorStop(0.6, 'rgba(7,38,71,0.10)');
    g.addColorStop(1, 'rgba(7,38,71,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
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
      return new THREE.Vector3(d * 0.66, d * 0.42, -d * 0.62);
  }
}

export default function ThreeViewport(props: ThreeViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const api = useRef<{
    zones: Map<string, ZoneEntry>;
    render: () => void;
    goTo: (view: ViewPreset, animate: boolean) => void;
  } | null>(null);

  // scene setup per model
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { model } = propsRef.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    } catch {
      propsRef.current.onContextLost?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.className = 'dm3-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xaab4c3, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(4, 6, -3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-4, 3, 4);
    scene.add(fill);

    const disposables: Array<{ dispose: () => void }> = [];
    const car = new THREE.Group();
    scene.add(car);
    const zones = new Map<string, ZoneEntry>();
    const fillers = new Map<Tone, THREE.MeshLambertMaterial>();
    const fillerEdges = new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.45 });
    disposables.push(fillerEdges);

    const materialFor = (part: Part): { mat: THREE.MeshLambertMaterial; edges: THREE.LineBasicMaterial } => {
      if (!part.zone) {
        let m = fillers.get(part.tone);
        if (!m) {
          m = new THREE.MeshLambertMaterial({ color: TONE_COLOURS[part.tone], side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
          fillers.set(part.tone, m);
          disposables.push(m);
        }
        return { mat: m, edges: fillerEdges };
      }
      const k = `${part.zone}|${part.tone}`;
      let z = zones.get(k);
      if (!z) {
        z = {
          zone: part.zone,
          tone: part.tone,
          material: new THREE.MeshLambertMaterial({ color: TONE_COLOURS[part.tone], side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
          edges: new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 })
        };
        zones.set(k, z);
        disposables.push(z.material, z.edges);
      }
      return { mat: z.material, edges: z.edges };
    };

    const add = (geo: THREE.BufferGeometry, part: Part, place?: (o: THREE.Object3D) => void, edgeAngle = 25) => {
      const { mat, edges } = materialFor(part);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.zone = part.zone;
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, edgeAngle), edges);
      lines.raycast = () => {};
      mesh.add(lines);
      place?.(mesh);
      car.add(mesh);
      disposables.push(geo, lines.geometry);
    };

    for (const part of model.parts) {
      if (part.type === 'poly') add(polyGeometry(part), part);
      else if (part.type === 'box') {
        add(new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]), part, (o) => o.position.set(...part.center));
      } else if (part.type === 'beam') {
        const b = beamGeometry(new THREE.Vector3(...part.a), new THREE.Vector3(...part.b), part.thickness);
        add(b.geo, part, (o) => {
          o.position.copy(b.pos);
          o.quaternion.copy(b.quat);
        });
      } else {
        const tyre = new THREE.CylinderGeometry(part.radius, part.radius, part.width, 28, 1);
        add(tyre, part, (o) => {
          o.position.set(...part.center);
          o.rotation.x = Math.PI / 2;
        }, 40);
        const rim = new THREE.CylinderGeometry(part.radius * 0.6, part.radius * 0.6, part.width + 0.012, 28, 1);
        add(rim, { ...part, tone: 'frame' }, (o) => {
          o.position.set(...part.center);
          o.rotation.x = Math.PI / 2;
        }, 40);
      }
    }

    // soft contact shadow + floor disc
    const tex = shadowTexture();
    if (tex) {
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(model.length * 1.25, model.width * 1.5),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      scene.add(shadow);
      disposables.push(tex, shadow.geometry, shadow.material as THREE.Material);
    }

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const target = new THREE.Vector3(0, model.height * 0.42, 0);
    const baseDist = Math.max(model.length, model.height * 1.8) * 1.85;
    let dist = baseDist;
    // keep the whole vehicle in frame on narrow (portrait) viewports
    const fitDist = (aspect: number) => {
      const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      return Math.max(baseDist, (model.length * 0.62) / Math.tan(halfH) + model.width / 2);
    };
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 1.8;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
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
        const scale = next / dist;
        dist = next;
        controls.minDistance = dist * 0.45;
        controls.maxDistance = dist * 1.8;
        camera.position.sub(target).multiplyScalar(scale).add(target);
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
      for (const hit of ray.intersectObjects(car.children, false)) {
        const z = hit.object.userData.zone as string | null | undefined;
        return z ?? null; // nearest surface wins; filler blocks what is behind it
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

    api.current = { zones, render, goTo };
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
      for (const d of disposables) d.dispose();
      renderer.dispose();
      el.remove();
    };
  }, [props.model]);

  // colours / hover / selection
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    for (const z of a.zones.values()) {
      const id = z.zone;
      const d = props.damage[id];
      z.material.color.set(zoneFill(z.tone, d));
      // highlight without changing the hue: blue tint on bare parts, a lighter shade on coloured (damaged) ones
      const damaged = !!d && d.severity > 0;
      const hot = id === props.selected ? (damaged ? 0.12 : 0.22) : id === props.hovered ? (damaged ? 0.08 : 0.14) : 0;
      z.material.emissive.set(damaged ? '#ffffff' : HOVER_COLOUR);
      z.material.emissiveIntensity = hot;
      const sel = id === props.selected || id === props.hovered;
      z.edges.color.copy(sel ? EDGE_SELECTED : EDGE);
      z.edges.opacity = sel ? 1 : 0.55;
    }
    a.render();
  }, [props.damage, props.hovered, props.selected, props.model]);

  // preset views
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    api.current?.goTo(props.view, true);
  }, [props.view, props.viewNonce]);

  return <div ref={hostRef} className="dm3-viewport" />;
}
