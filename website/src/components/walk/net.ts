import * as THREE from "three";
import { T } from "./story";
import { APPS, LINKS, NODES, WALLS, WALL_H, appPos, type NodeId } from "./geo";

/** The labyrinth, as a place you walk. One WebGL2 canvas, plain three.js,
 * hand-written shaders: the work is thousands of fine lines and a little
 * dust, and a line is a ribbon of two triangles that knows its own width in
 * world units, so it tapers with depth the way a drafted line would.
 *
 * What the shaders do, once, for every line, face and mote:
 *  - width in world units, floored at a fraction of a pixel, so a distant
 *    wall thins instead of aliasing;
 *  - depth of field: the circle of confusion widens a line and takes the
 *    intensity out of it, so out-of-focus lines go soft the way glass does;
 *  - atmosphere: exp fog, so the far rings sink into the page;
 *  - light travelling by `along`, each wall's share of the corridor, so a
 *    push lights the walls on its way in and the deploy lights them on the
 *    way out.
 * The scroll position f (0..1) is the only input; everything else, the
 * camera, the light, the machines, is a pure function of it. */

const EMBER = new THREE.Color("#e2795a");
const INK = new THREE.Color("#c9ccd6");
const HOT = new THREE.Color("#fff0e8");

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);
const inOut = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));
const inOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));
const span = (f: number, a: number, b: number) => clamp01((f - a) / (b - a));

const GLOBAL = {
  uRes: { value: new THREE.Vector2(1, 1) },
  uPx: { value: 800 },
  uFog: { value: 0.004 },
  uDof: { value: 10 },
  uFocus: { value: 200 },
  uTime: { value: 0 },
  uBuild: { value: 1 },
  uInHead: { value: 1 },
  uInHeadOn: { value: 0 },
  uInTrail: { value: 0 },
  uOutHead: { value: 0 },
  uOutHeadOn: { value: 0 },
  uOutTrail: { value: 0 },
  uInk: { value: INK },
  uEmber: { value: EMBER },
  uHot: { value: HOT },
  uExpo: { value: 1.6 },
};

const LIGHT = /* glsl */ `
uniform float uInHead, uInHeadOn, uInTrail, uOutHead, uOutHeadOn, uOutTrail;
uniform vec3 uInk, uEmber, uHot;
// lit: 0..1, the walked part of the corridor; head: 0..1+, the leading edge
void light(float al, out float lit, out float head) {
  float a = smoothstep(-0.006, 0.006, al - uInHead) * uInTrail;
  float b = smoothstep(-0.006, 0.006, uOutHead - al) * uOutTrail;
  lit = clamp(a * 0.5 + b * 0.5, 0.0, 1.0);
  float di = (al - uInHead);
  float dout = (al - uOutHead);
  head = exp(-di * di * 2600.0) * uInHeadOn + exp(-dout * dout * 2600.0) * uOutHeadOn;
}
`;

const RIBBON_VS = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aAl;
uniform vec2 uRes;
uniform float uPx, uW, uMinPx, uDof, uFocus, uFog, uBuild, uUseBuild, uGrow;
varying float vY, vAl, vFade, vCoc, vT, vDepth;
float rise(float al) {
  return mix(1.0, smoothstep(0.0, 0.22, uBuild * 1.3 - al), uUseBuild);
}
void main() {
  vec3 A = aA;
  vec3 B = aB;
  A.y *= rise(aAl.x);
  B.y *= rise(aAl.y);
  vec4 vA = modelViewMatrix * vec4(A, 1.0);
  vec4 vB = modelViewMatrix * vec4(B, 1.0);
  float nearZ = -0.4;
  float tA = 0.0;
  float tB = 1.0;
  if (vA.z > nearZ && vB.z > nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (vA.z > nearZ) { float k = (nearZ - vA.z) / (vB.z - vA.z); vA = mix(vA, vB, k); tA = k; }
  if (vB.z > nearZ) { float k = (nearZ - vA.z) / (vB.z - vA.z); vB = mix(vA, vB, k); tB = mix(tA, 1.0, k); }
  float t = position.x;
  vec4 v = mix(vA, vB, t);
  float depth = -v.z;
  vec4 cA = projectionMatrix * vA;
  vec4 cB = projectionMatrix * vB;
  vec4 clip = mix(cA, cB, t);
  vec2 d = normalize((cB.xy / cB.w - cA.xy / cA.w) * uRes + 1e-6);
  vec2 n = vec2(-d.y, d.x);
  float coc = uDof * abs(depth - uFocus) / max(depth, 0.5);
  float core = max(uW * uPx / depth, uMinPx);
  float w = min(core + coc * 0.55, 15.0) * uGrow;
  vec2 off = n * position.y * w * 0.5 + d * (t * 2.0 - 1.0) * w * 0.5;
  clip.xy += off * 2.0 / uRes * clip.w;
  gl_Position = clip;
  vY = position.y;
  vT = mix(tA, tB, t);
  vAl = mix(aAl.x, aAl.y, vT);
  vFade = exp(-depth * uFog) * smoothstep(0.4, 3.0, depth);
  vCoc = coc / (core + 0.001);
  vDepth = depth;
}
`;

const RIBBON_FS = /* glsl */ `
uniform float uA, uLitA, uHeadA, uGain, uReveal, uDash, uTime, uTip, uSharp, uExpo, uTint, uPos, uPulseA, uStream;
varying float vY, vAl, vFade, vCoc, vT, vDepth;
${LIGHT}
void main() {
  float lit, head;
  light(vAl, lit, head);
  float prof = exp(-vY * vY * uSharp);
  float near = smoothstep(7.0, 36.0, vDepth);
  float a = uA + lit * uLitA + head * uHeadA * near;
  float cut = (1.0 - smoothstep(uReveal - 0.01, uReveal + 0.002, vAl)) * step(0.002, uReveal);
  float tip = uTip * exp(-pow((vAl - uReveal) * 16.0, 2.0)) * step(0.001, uReveal) * (1.0 - step(0.999, uReveal));
  float dash = 1.0;
  if (uDash > 0.0) {
    float p = fract(vAl * 2.0 - uTime * 0.16);
    dash = 0.28 + 0.72 * exp(-pow((p - 0.5) * 7.0, 2.0));
    float p2 = fract(vAl * 2.0 + uTime * 0.12);
    dash += 0.6 * exp(-pow((p2 - 0.5) * 12.0, 2.0));
  }
  vec3 col = mix(mix(uInk, uEmber, uTint), uEmber, clamp(lit * 1.25, 0.0, 1.0)) + uHot * (head * 0.7 * near + tip * 0.5);
  float pulse = 0.0;
  if (uPulseA > 0.0) {
    if (uStream > 0.5) { float q = fract(vAl * uStream - uPos * uStream); float dq = min(q, 1.0 - q); pulse = exp(-pow(dq * 9.0, 2.0)); }
    else pulse = exp(-pow((vAl - uPos) * 26.0, 2.0));
  }
  col += uHot * pulse * uPulseA * 0.3;
  float alpha = uExpo * (a + tip * 0.55 + pulse * uPulseA * 0.5) * dash * prof * vFade * uGain * cut / (1.0 + vCoc * 0.4);
  gl_FragColor = vec4(col, alpha);
}
`;

const MOTE_VS = /* glsl */ `
attribute float aSeed;
uniform float uPx, uSize, uDof, uFocus, uFog, uTime, uFlat;
varying float vA, vS;
void main() {
  vec3 p = position;
  p += uFlat < 0.5 ? vec3(sin(uTime * 0.11 + aSeed * 40.0), sin(uTime * 0.09 + aSeed * 23.0) * 0.6, cos(uTime * 0.1 + aSeed * 31.0)) * 3.0 : vec3(0.0);
  vec4 v = modelViewMatrix * vec4(p, 1.0);
  float depth = -v.z;
  gl_Position = projectionMatrix * v;
  float coc = uDof * abs(depth - uFocus) / max(depth, 0.5);
  float size = uSize * uPx / max(depth, 0.5) + coc * 0.2;
  gl_PointSize = clamp(size, 1.0, uFlat > 0.5 ? 900.0 : 22.0);
  vA = exp(-depth * uFog * 1.2) * smoothstep(1.0, 5.0, depth) / (1.0 + coc * 0.18);
  vS = aSeed;
}
`;
const MOTE_FS = /* glsl */ `
uniform float uGain, uFlat, uTime;
uniform vec3 uEmber, uInk;
varying float vA, vS;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float soft = uFlat > 0.5 ? pow(max(1.0 - r, 0.0), 2.4) : smoothstep(1.0, 0.2, r);
  float tw = uFlat > 0.5 ? 1.0 : 0.55 + 0.45 * sin(uTime * 0.7 + vS * 90.0);
  vec3 col = uFlat > 0.5 ? uEmber : mix(uInk, uEmber, step(0.82, fract(vS * 7.0)));
  gl_FragColor = vec4(col, soft * vA * uGain * tw);
}
`;

type Segment = [number, number, number, number, number, number, number, number];
const seg = (a: number[], b: number[], al0 = 0, al1 = al0): Segment => [a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, al0, al1];

function ribbonGeometry(segs: Segment[]) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const a = new Float32Array(segs.length * 3);
  const b = new Float32Array(segs.length * 3);
  const al = new Float32Array(segs.length * 2);
  segs.forEach((s, i) => {
    a.set([s[0], s[1], s[2]], i * 3);
    b.set([s[3], s[4], s[5]], i * 3);
    al.set([s[6], s[7]], i * 2);
  });
  g.setAttribute("aA", new THREE.InstancedBufferAttribute(a, 3));
  g.setAttribute("aB", new THREE.InstancedBufferAttribute(b, 3));
  g.setAttribute("aAl", new THREE.InstancedBufferAttribute(al, 2));
  g.instanceCount = segs.length;
  return g;
}

interface Shared {
  pos: { value: number };
  amt: { value: number };
  stream: { value: number };
  grow: { value: number };
}
const shared = (): Shared => ({ pos: { value: -1 }, amt: { value: 0 }, stream: { value: 0 }, grow: { value: 1 } });

interface LineOpts {
  /** width in world units */
  w: number;
  a: number;
  litA?: number;
  headA?: number;
  minPx?: number;
  build?: boolean;
  gain?: { value: number };
  reveal?: { value: number };
  dash?: boolean;
  tip?: number;
  /** extra halo layer: width multiplier and alpha multiplier */
  halo?: [number, number] | false;
  sharp?: number;
  /** 0..1: how far the line sits toward the accent when nothing lights it */
  tint?: number;
  /** uniforms a link shares across its layers: the pulse, its strength, and the line's load */
  shared?: Shared;
}

function lineMaterial(o: LineOpts, halo: boolean, mult = 1, k = 1) {
  const m = new THREE.ShaderMaterial({
    vertexShader: RIBBON_VS,
    fragmentShader: RIBBON_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      ...GLOBAL,
      uW: { value: o.w * mult },
      uMinPx: { value: halo ? (o.minPx ?? 0.55) * mult : (o.minPx ?? 0.55) },
      uA: { value: halo ? o.a * ((o.halo || undefined)?.[1] ?? 0.2) * k : o.a },
      uLitA: { value: (o.litA ?? 0.5) * (halo ? ((o.halo || undefined)?.[1] ?? 0.2) * 1.4 * k : 1) },
      uHeadA: { value: (o.headA ?? 1.4) * (halo ? 0.5 * k : 1) },
      uTint: { value: o.tint ?? 0 },
      uGain: o.gain ?? { value: 1 },
      uReveal: o.reveal ?? { value: 1.01 },
      uDash: { value: o.dash ? 1 : 0 },
      uTip: { value: o.tip ?? 0 },
      uUseBuild: { value: o.build ? 1 : 0 },
      uGrow: o.shared?.grow ?? { value: 1 },
      uPos: o.shared?.pos ?? { value: -1 },
      uPulseA: o.shared?.amt ?? { value: 0 },
      uStream: o.shared?.stream ?? { value: 0 },
      uSharp: { value: halo ? 1.6 : 3.2 },
    },
  });
  return m;
}

function ribbons(segs: Segment[], o: LineOpts) {
  const geo = ribbonGeometry(segs);
  const group = new THREE.Group();
  const core = new THREE.Mesh(geo, lineMaterial(o, false));
  core.frustumCulled = false;
  group.add(core);
  if (o.halo !== false) {
    const hm = new THREE.Mesh(geo, lineMaterial(o, true, (o.halo || undefined)?.[0] ?? 7));
    hm.frustumCulled = false;
    group.add(hm);
    const h2 = new THREE.Mesh(geo, lineMaterial(o, true, ((o.halo || undefined)?.[0] ?? 7) * 3.2, 0.32));
    h2.frustumCulled = false;
    group.add(h2);
  }
  return group;
}

function motes(count: number, box: [number, number, number, number, number, number], size: number, gain: number) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = box[0] + Math.random() * (box[3] - box[0]);
    pos[i * 3 + 1] = box[1] + Math.random() * (box[4] - box[1]);
    pos[i * 3 + 2] = box[2] + Math.random() * (box[5] - box[2]);
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    vertexShader: MOTE_VS,
    fragmentShader: MOTE_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...GLOBAL, uSize: { value: size }, uGain: { value: gain }, uFlat: { value: 0 } },
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

function glow(at: [number, number, number], size: number, gain: { value: number }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(at, 3));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute([0.3], 1));
  const m = new THREE.ShaderMaterial({
    vertexShader: MOTE_VS,
    fragmentShader: MOTE_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...GLOBAL, uSize: { value: size }, uGain: gain, uFlat: { value: 1 } },
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

function boxEdges(cx: number, cy: number, cz: number, w: number, h: number, d: number): Segment[] {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const c = (x: number, y: number, z: number) => [x, y, z];
  const v = [c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), c(x0, y0, z1), c(x0, y1, z0), c(x1, y1, z0), c(x1, y1, z1), c(x0, y1, z1)];
  const e = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ] as const;
  return e.map(([a, b]) => seg(v[a]!, v[b]!));
}

function ring(r: number, n = 48): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(seg([Math.cos(a0) * r, 0, Math.sin(a0) * r], [Math.cos(a1) * r, 0, Math.sin(a1) * r]));
  }
  return out;
}


export interface Options {
  canvas: HTMLCanvasElement;
  light: boolean;
  onReady: () => void;
  onLost: () => void;
}

export interface Anchor {
  x: number;
  y: number;
  on: boolean;
}

interface Pose {
  pos: THREE.Vector3;
  tgt: THREE.Vector3;
  fov: number;
  fog: number;
  dof: number;
  expo: number;
  /** where the graph sits on the screen, as a share of it */
  off: [number, number];
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function blend(a: Pose, b: Pose, t: number): Pose {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    tgt: a.tgt.clone().lerp(b.tgt, t),
    fov: l(a.fov, b.fov),
    fog: l(a.fog, b.fog),
    dof: l(a.dof, b.dof),
    expo: l(a.expo, b.expo),
    off: [l(a.off[0], b.off[0]), l(a.off[1], b.off[1])],
  };
}


export function createScene(o: Options) {
  const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
  const mobile = o.light;

  /** one gain every dimmable thing in the world shares */
  const world = { value: 1 };
  const g = (v = 0) => ({ value: v });
  const boxCore = g(0.35);
  const macG = g(0.2);
  const pcG = g(0.2);
  const pc2G = g(0.2);
  const netG = g(0.14);
  const ghG = g(0.14);
  const landG = g(0);
  const landRing = g(0);
  const sessG = g(0);
  const sessRing = g(0);

  // —— the ground: rings of reach, quiet ——
  const rings: Segment[] = [];
  for (const r of [70, 140, 210]) {
    for (let i = 0; i < 96; i++) {
      const a0 = (i / 96) * Math.PI * 2;
      const a1 = ((i + 1) / 96) * Math.PI * 2;
      rings.push(seg([Math.cos(a0) * r, 0, Math.sin(a0) * r], [Math.cos(a1) * r, 0, Math.sin(a1) * r]));
    }
  }
  scene.add(ribbons(rings, { w: 0.1, a: 0.07, halo: false, minPx: 0.6, gain: world }));

  // —— the box: the mark's labyrinth, small, as its body ——
  const S = 0.5;
  const mazeTop: Segment[] = [];
  const mazeFoot: Segment[] = [];
  const mazePost: Segment[] = [];
  const total = WALLS.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - WALLS[i - 1]!.x, p.z - WALLS[i - 1]!.z) : 0), 0);
  let acc = 0;
  const H = WALL_H * 0.5;
  for (let i = 0; i < WALLS.length - 1; i++) {
    const p = WALLS[i]!;
    const q = WALLS[i + 1]!;
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const a0 = acc / total;
    const a1 = (acc + len) / total;
    acc += len;
    mazeTop.push(seg([p.x * S, H, p.z * S], [q.x * S, H, q.z * S], a0, a1));
    mazeFoot.push(seg([p.x * S, 0, p.z * S], [q.x * S, 0, q.z * S], a0, a1));
    mazePost.push(seg([p.x * S, 0, p.z * S], [p.x * S, H, p.z * S], a0, a0));
  }
  scene.add(ribbons(mazeTop, { w: 0.22, a: 0.8, litA: 0.9, headA: 0.7, minPx: 1, gain: world, halo: [7, 0.22] }));
  scene.add(ribbons(mazeFoot, { w: 0.14, a: 0.35, litA: 0.5, headA: 0.4, minPx: 0.8, gain: world }));
  scene.add(ribbons(mazePost, { w: 0.14, a: 0.3, litA: 0.5, headA: 0.4, minPx: 0.8, gain: world }));
  scene.add(ribbons(boxEdges(0, 3.4, 0, 6, 6, 6), { w: 0.14, a: 1, tint: 0.6, litA: 0, gain: boxCore, halo: [7, 0.24], minPx: 1.1 }));
  scene.add(glow([0, 3, 0], 34, boxCore));
  scene.add(ribbons([seg([0, 7, 0], [0, 150, 0])], { w: 0.12, a: 0.4, tint: 0.7, gain: boxCore, halo: [9, 0.12] }));

  // —— the machines and the outside, each a pad and a shape ——
  const pad = (id: NodeId, r: number) => {
    const n = NODES[id];
    const m = ribbons(ring(r), { w: 0.1, a: 0.28, halo: [4, 0.1], minPx: 0.7, gain: world });
    m.position.set(n.x, 0.1, n.z);
    scene.add(m);
  };
  const shape = (segs: Segment[], gain: { value: number }, tint = 0.2) =>
    scene.add(ribbons(segs, { w: 0.14, a: 0.9, tint, litA: 0, gain, halo: [7, 0.24], minPx: 1 }));
  const at = (id: NodeId) => NODES[id];
  // the Mac: a screen and a base
  shape([...boxEdges(at("mac").x, 17, at("mac").z, 30, 19, 1.4), ...boxEdges(at("mac").x, 4, at("mac").z + 8, 32, 1.2, 20)], world);
  // the gaming PC: a tower, its GPU a lit slab in it
  shape(boxEdges(at("pc").x, 19, at("pc").z, 17, 36, 30), world);
  scene.add(ribbons(boxEdges(at("pc").x, 15, at("pc").z, 13, 6, 22), { w: 0.12, a: 1, tint: 0.9, litA: 0, gain: pcG, halo: [8, 0.3], minPx: 1 }));
  // the second PC
  shape(boxEdges(at("pc2").x, 15, at("pc2").z, 14, 30, 24), world);
  // GitHub and the internet: plain pads with a mast
  for (const id of ["github", "net"] as const) {
    scene.add(ribbons([seg([at(id).x, 0, at(id).z], [at(id).x, 22, at(id).z])], { w: 0.12, a: 0.6, litA: 0, gain: world, halo: [6, 0.2] }));
    scene.add(ribbons(ring(7), { w: 0.12, a: 0.7, litA: 0, gain: world, halo: [6, 0.2] }));
  }
  scene.children[scene.children.length - 1]!.position.set(at("net").x, 22, at("net").z);
  scene.children[scene.children.length - 2]!.position.set(at("net").x, 0, at("net").z);
  scene.add(
    (() => {
      const r = ribbons(ring(7), { w: 0.12, a: 0.7, litA: 0, gain: world, halo: [6, 0.2] });
      r.position.set(at("github").x, 22, at("github").z);
      return r;
    })(),
  );
  for (const id of ["mac", "pc", "pc2", "github", "net"] as const) pad(id, 20);
  scene.add(glow([at("mac").x, 14, at("mac").z], 36, macG));
  scene.add(glow([at("pc").x, 15, at("pc").z], 42, pcG));
  scene.add(glow([at("pc2").x, 14, at("pc2").z], 34, pc2G));
  scene.add(glow([at("net").x, 22, at("net").z], 26, netG));
  scene.add(glow([at("github").x, 22, at("github").z], 26, ghG));
  // a session on the second PC: a ring that opens
  const sessMesh = ribbons(ring(1), { w: 0.14, a: 1, tint: 1, litA: 0, gain: sessRing, halo: [8, 0.24], minPx: 1 });
  sessMesh.position.set(at("pc2").x, 0.3, at("pc2").z);
  scene.add(sessMesh);
  scene.add(glow([at("pc2").x, 33, at("pc2").z], 18, sessG));

  // —— the links ——
  const nodeTop = (id: NodeId) => V(NODES[id].x, id === "box" ? 7 : id === "net" || id === "github" ? 22 : 30, NODES[id].z);
  const linkSh: Record<string, Shared> = {};
  const linkCurve: Record<string, THREE.CatmullRomCurve3> = {};
  const mkLink = (id: string, a: THREE.Vector3, b: THREE.Vector3, rise: number, base = 0.55, n = 64) => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y += rise;
    const pts = [a, a.clone().lerp(mid, 0.5).setY(a.y + rise * 0.7), mid, mid.clone().lerp(b, 0.5).setY(b.y + rise * 0.7), b];
    const c = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    linkCurve[id] = c;
    const sh = shared();
    linkSh[id] = sh;
    const segs: Segment[] = [];
    let prev = c.getPoint(0);
    for (let i = 1; i <= n; i++) {
      const p = c.getPoint(i / n);
      segs.push(seg([prev.x, prev.y, prev.z], [p.x, p.y, p.z], (i - 1) / n, i / n));
      prev = p;
    }
    scene.add(ribbons(segs, { w: 0.16, a: base, tint: 0.35, litA: 0, gain: world, shared: sh, halo: [8, 0.2], minPx: 0.9 }));
  };
  for (const l of LINKS) mkLink(l.id, nodeTop(l.a), nodeTop(l.b), l.rise);

  // —— the apps' ring ——
  const tiles: Segment[] = [];
  const land: Segment[] = [];
  APPS.forEach((_, i) => {
    const p = appPos(i);
    (i === 5 ? land : tiles).push(...boxEdges(p.x, 0.5, p.z, 11, 1, 11));
  });
  scene.add(ribbons(tiles, { w: 0.12, a: 0.22, litA: 0, gain: world, halo: [5, 0.12], minPx: 0.8 }));
  scene.add(ribbons(land, { w: 0.12, a: 0.22, litA: 0, gain: world, halo: [5, 0.12], minPx: 0.8 }));
  scene.add(ribbons(land, { w: 0.18, a: 1, tint: 1, litA: 0, gain: landG, halo: [9, 0.3], minPx: 1.2 }));
  const lp = appPos(5);
  const landMesh = ribbons(ring(1), { w: 0.14, a: 1, tint: 1, litA: 0, gain: landRing, halo: [9, 0.24], minPx: 1 });
  landMesh.position.set(lp.x, 0.3, lp.z);
  scene.add(landMesh);
  scene.add(glow([lp.x, 3, lp.z], 20, landG));
  mkLink("app", V(0, 7, 0), V(lp.x, 2, lp.z), 10, 0.22, 40);

  scene.add(motes(mobile ? 140 : 360, [-240, 2, -200, 240, 90, 220], 0.05, 0.4));

  // —— anchors for the page's own text ——
  const anchors = new Map<string, THREE.Vector3>();
  (Object.keys(NODES) as NodeId[]).forEach((id) => {
    anchors.set(`node:${id}`, V(NODES[id].x, 0, NODES[id].z));
    anchors.set(`lab:${id}`, V(NODES[id].x + (NODES[id].lab?.[0] ?? 0), 0, NODES[id].z + (NODES[id].lab?.[1] ?? 24)));
    anchors.set(`top:${id}`, nodeTop(id).clone().setY(id === "box" ? 14 : 42));
  });
  for (const l of LINKS) anchors.set(`link:${l.id}`, linkCurve[l.id]!.getPoint(0.5));
  anchors.set("app", V(lp.x, 12, lp.z));
  const screen = new Map<string, Anchor>();

  // —— poses ——
  const OFF: [number, number] = mobile ? [0, -0.14] : [0, 0];
  const POSES = {
    hero: { pos: V(30, 150, 192), tgt: V(16, 0, -4), fov: 44, fog: 0.0018, dof: 4, expo: 2.3, off: mobile ? OFF : [0.18, -0.05] } as Pose,
    ai: { pos: V(-30, 180, 240), tgt: V(10, 0, 14), fov: 44, fog: 0.0018, dof: 4, expo: 2.3, off: OFF } as Pose,
    claude: { pos: V(60, 176, 210), tgt: V(30, 0, -26), fov: 44, fog: 0.0018, dof: 4, expo: 2.3, off: OFF } as Pose,
    push: { pos: V(0, 170, 210), tgt: V(0, 0, -8), fov: 44, fog: 0.0018, dof: 4, expo: 2.3, off: OFF } as Pose,
  };
  const pose = (f: number): Pose => {
    if (f < 0.08) return POSES.hero;
    if (f < 0.2) return blend(POSES.hero, POSES.ai, inOutCubic(span(f, 0.08, 0.2)));
    if (f < 0.3) return POSES.ai;
    if (f < 0.4) return blend(POSES.ai, POSES.claude, inOutCubic(span(f, 0.3, 0.4)));
    if (f < 0.5) return POSES.claude;
    if (f < 0.58) return blend(POSES.claude, POSES.push, inOutCubic(span(f, 0.5, 0.58)));
    return POSES.push;
  };

  // —— state ——
  const state = { f: 0, t: 0, px: 0, py: 0, ox: 0, oy: 0 };
  let w = 1;
  let h = 1;
  let still = false;
  let ready = false;
  let lost = false;
  let lostTimer = 0;
  const tmp = new THREE.Vector3();

  const pulse = (id: string, p: number, amt: number, dir = 1, stream = 0, grow = 1) => {
    const sh = linkSh[id]!;
    sh.pos.value = dir > 0 ? p : 1 - p;
    // a backward pulse reads as a position that falls: the shader moves patterns toward higher alongs
    if (dir < 0 && stream > 0) sh.pos.value = -p;
    sh.amt.value = amt;
    sh.stream.value = stream;
    sh.grow.value = grow;
  };
  const rest = (id: string) => {
    const sh = linkSh[id]!;
    sh.amt.value = 0;
    sh.grow.value = 1;
    sh.stream.value = 0;
  };
  const fadeIO = (f: number, [a, b]: readonly [number, number], tail = 0.03) => smooth(span(f, a, a + tail)) * (1 - smooth(span(f, b - tail, b)));

  function applyState(f: number, t: number) {
    // everything at rest first, then each beat lays its light over it
    for (const id of Object.keys(linkSh)) rest(id);
    const breathe = (ph: number, base: number) => base + 0.05 * Math.sin(t * 0.5 + ph);
    macG.value = breathe(0, 0.2);
    pcG.value = breathe(1.3, 0.22);
    pc2G.value = breathe(2.1, 0.2);
    netG.value = breathe(3.4, 0.14);
    ghG.value = breathe(4.2, 0.14);
    boxCore.value = breathe(5, 0.34);
    sessG.value = 0;
    sessRing.value = 0;
    GLOBAL.uInHeadOn.value = 0;
    GLOBAL.uInTrail.value = 0;

    // hero: a quiet request now and then, so the page is alive before it is scrolled
    if (f < 0.1) {
      const cyc = (t / 6.5) % 3;
      const k = Math.floor(cyc);
      const p = cyc - k;
      const seq = ["net", "github", "pc"];
      const id = seq[k]!;
      const e = inOut(span(p, 0, 0.55));
      pulse(id, e, 0.55 * (1 - smooth(span(p, 0.5, 0.65))) * (p < 0.65 ? 1 : 0), 1);
    }
    // 1 · an AI query
    if (f >= T.aiIn[0] && f < T.aiBack[1] + 0.02) {
      const a = span(f, ...T.aiIn);
      const r = span(f, ...T.aiRoute);
      const b = span(f, ...T.aiBack);
      if (a > 0 && a < 1) pulse("net", inOut(a), 1, 1, 0, 1.4);
      if (r > 0 && r < 1) {
        pulse("pc", inOut(r), 1, 1, 0, 1.5);
        pcG.value = 0.2 + 0.7 * smooth(r);
      }
      if (b > 0) {
        pcG.value = 0.9 - 0.65 * smooth(span(b, 0.6, 1));
        const half = b < 0.5;
        if (b < 1) {
          if (half) pulse("pc", inOut(b * 2), 1, -1, 4, 1.5);
          else pulse("net", inOut((b - 0.5) * 2), 1, -1, 4, 1.4);
          boxCore.value = 0.7;
        }
      }
      if (a >= 1 && r === 0) pcG.value = 0.2;
    }
    // 2 · a Claude session
    if (f >= T.clDown[0] && f < T.clUp[1] + 0.02) {
      const d = span(f, ...T.clDown);
      const u = span(f, ...T.clUp);
      if (d > 0 && d < 1) pulse("pc2", inOut(d), 0.9, 1, 0, 1.4);
      const s = smooth(span(f, 0.41, 0.46)) * (1 - smooth(span(f, 0.52, 0.55)));
      sessG.value = s * 0.8;
      sessRing.value = s;
      sessMesh.scale.setScalar(6 + outExpo(span(f, 0.41, 0.5)) * 18);
      pc2G.value = 0.2 + 0.55 * s;
      if (u > 0 && u < 1) {
        pulse("pc2", inOut(u), 0.9, -1, 0, 1.4);
        boxCore.value = 0.34 + 0.4 * smooth(span(u, 0.8, 1));
      }
    }
    // 3 · a push
    if (f >= T.ghIn[0]) {
      const gi = span(f, ...T.ghIn);
      if (gi > 0 && gi < 1) pulse("github", inOut(gi), 1, 1, 0, 1.4);
      ghG.value = 0.14 + 0.6 * fadeIO(f, [T.ghIn[0], T.ghIn[1] + 0.02], 0.02);
      const b = span(f, ...T.build);
      if (b > 0) {
        GLOBAL.uInHead.value = 1 - inOut(b);
        GLOBAL.uInHeadOn.value = b < 1 ? 1 : 0;
        GLOBAL.uInTrail.value = 1;
        boxCore.value = 0.34 + 0.5 * smooth(b);
      }
      const d = span(f, ...T.deploy);
      if (d > 0 && d < 1) pulse("app", inOut(d), 1, 1, 0, 1.5);
      if (d >= 1) boxCore.value = 0.5;
      const l = smooth(span(f, ...T.land));
      landG.value = l;
      const rp = span(f, T.land[0], T.land[1] + 0.05);
      landRing.value = rp > 0 && rp < 1 ? 1 - rp : 0;
      landMesh.scale.setScalar(4 + outExpo(rp) * 26);
    }
  }

  /** if frames run long, the canvas steps down in resolution (never below 1) and stays there */
  let dprCap = mobile ? 1.5 : 1.75;
  let slow = 0;
  let nFrames = 0;
  function adapt(dt: number) {
    if (still || dt <= 0) return;
    nFrames++;
    if (nFrames < 30) return;
    slow = slow * 0.9 + (dt > 0.026 ? 0.1 : 0);
    if (slow > 0.6 && dprCap > 1) {
      dprCap = Math.max(1, dprCap - 0.25);
      slow = 0;
      nFrames = 0;
      resize(w, h);
    }
  }

  function frame(dt: number) {
    adapt(dt);
    state.t += dt;
    GLOBAL.uTime.value = state.t;
    state.px += (state.ox - state.px) * (1 - Math.exp(-dt * 3));
    state.py += (state.oy - state.py) * (1 - Math.exp(-dt * 3));
    if (GLOBAL.uBuild.value < 1) GLOBAL.uBuild.value = Math.min(1, GLOBAL.uBuild.value + dt / 2.6);
    const f = state.f;
    const t = state.t;
    applyState(f, t);
    const p = pose(f);
    const drift = still ? 0 : 1;
    camera.position.copy(p.pos);
    camera.position.x += (Math.sin(t * 0.11) * 8 + state.px * 10) * drift;
    camera.position.y += Math.sin(t * 0.15) * 3 * drift;
    camera.position.z += (Math.cos(t * 0.09) * 6 + state.py * 6) * drift;
    camera.up.set(0, 1, 0);
    camera.lookAt(p.tgt);
    camera.aspect = w / h;
    camera.fov = p.fov * (mobile ? 2.05 - 0.4 * (1 - smooth(span(f, 0.0, 0.12))) : w / h < 1.35 ? 1.2 : 1);
    camera.setViewOffset(w, h, -p.off[0] * w, -p.off[1] * h, w, h);
    camera.updateProjectionMatrix();
    GLOBAL.uFocus.value = camera.position.distanceTo(p.tgt);
    GLOBAL.uFog.value = p.fog;
    GLOBAL.uDof.value = p.dof;
    GLOBAL.uExpo.value = p.expo;
    GLOBAL.uPx.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    renderer.render(scene, camera);
    anchors.forEach((v, k) => {
      tmp.copy(v).project(camera);
      screen.set(k, {
        x: (tmp.x * 0.5 + 0.5) * w,
        y: (-tmp.y * 0.5 + 0.5) * h,
        on: tmp.z < 1 && tmp.x > -1.02 && tmp.x < 1.02 && tmp.y > -1.02 && tmp.y < 1.02,
      });
    });
    if (!ready) {
      ready = true;
      o.onReady();
    }
  }

  function resize(cw: number, ch: number) {
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    // a short window leaves less room beside the headline: the graph rises and slides over a little
    const k = clamp01((900 - h) / 180);
    if (!mobile) POSES.hero.off = [0.18 + 0.04 * k, -0.05 - 0.02 * k];
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    GLOBAL.uRes.value.set(w * dpr, h * dpr);
    if (still) frame(0);
  }

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    lostTimer = window.setTimeout(() => {
      if (lost) o.onLost();
    }, 2500);
  };
  const onRestored = () => {
    lost = false;
    clearTimeout(lostTimer);
  };
  o.canvas.addEventListener("webglcontextlost", onLost);
  o.canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    setProgress(f: number) {
      state.f = f;
    },
    tick(dt: number) {
      frame(Math.min(0.05, dt));
    },
    setPointer(x: number, y: number) {
      state.ox = x;
      state.oy = y;
    },
    resize,
    screen,
    /** The finished graph: every link at rest and drawn, the box lit, one app landed. */
    renderStill() {
      still = true;
      GLOBAL.uBuild.value = 1;
      state.f = 0.82;
      frame(0);
      state.f = 0;
      GLOBAL.uInHead.value = 0;
      GLOBAL.uInTrail.value = 1;
      boxCore.value = 0.8;
      landG.value = 1;
      pcG.value = 0.5;
      macG.value = 0.3;
      pc2G.value = 0.3;
      const p = POSES.hero;
      camera.position.copy(p.pos);
      camera.lookAt(p.tgt);
      camera.aspect = w / h;
      camera.fov = p.fov * (mobile ? 1.65 : w / h < 1.35 ? 1.2 : 1);
      camera.setViewOffset(w, h, -p.off[0] * w, -p.off[1] * h, w, h);
      camera.updateProjectionMatrix();
      GLOBAL.uFocus.value = camera.position.distanceTo(p.tgt);
      GLOBAL.uFog.value = p.fog;
      GLOBAL.uExpo.value = p.expo;
      GLOBAL.uPx.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      renderer.render(scene, camera);
      anchors.forEach((v, k) => {
        tmp.copy(v).project(camera);
        screen.set(k, { x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, on: tmp.z < 1 });
      });
      if (!ready) {
        ready = true;
        o.onReady();
      }
    },
    dispose() {
      clearTimeout(lostTimer);
      o.canvas.removeEventListener("webglcontextlost", onLost);
      o.canvas.removeEventListener("webglcontextrestored", onRestored);
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

export type NetScene = ReturnType<typeof createScene>;
