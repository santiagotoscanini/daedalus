import * as THREE from "three";
import {
  APPS,
  BOX,
  LANDING,
  LANE_LENGTH,
  LANE_PATH,
  MACHINES,
  MOUTH,
  laneAlongAt,
  laneAtAlong,
  WALLS,
  WALL_H,
  appPos,
  laneAt,
} from "./geo";

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

/** Where in the scroll each beat happens. The page's stations are four
 * equal blocks, so these are written against 0.25 multiples. */
export const BEATS = {
  descend: [0.2, 0.3],
  walk: [0.3, 0.54],
  crane: [0.54, 0.64],
  hold: [0.64, 0.75],
  out: [0.75, 0.84],
  /** the head of the push, a little ahead of the camera */
  pushHead: [0.255, 0.5],
  /** the deploy leaving the box */
  deployHead: [0.76, 0.84],
  core: [0.5, 0.57],
  links: [0.58, 0.7],
  thread: [0.84, 0.9],
  land: [0.9, 0.95],
} as const;

const GLOBAL = {
  uRes: { value: new THREE.Vector2(1, 1) },
  uPx: { value: 800 },
  uFog: { value: 0.004 },
  uDof: { value: 10 },
  uFocus: { value: 200 },
  uTime: { value: 0 },
  uBuild: { value: 0 },
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
uniform float uA, uLitA, uHeadA, uGain, uReveal, uDash, uTime, uTip, uSharp, uExpo, uTint;
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
  float alpha = uExpo * (a + tip * 0.55) * dash * prof * vFade * uGain * cut / (1.0 + vCoc * 0.4);
  gl_FragColor = vec4(col, alpha);
}
`;

const FACE_VS = /* glsl */ `
attribute float aAl;
attribute float aV;
uniform float uFog, uBuild;
varying float vAl, vV, vFade, vDepth;
void main() {
  float rise = smoothstep(0.0, 0.22, uBuild * 1.3 - aAl);
  vec3 p = position;
  p.y *= rise;
  vec4 v = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * v;
  vAl = aAl;
  vV = aV;
  vFade = exp(v.z * uFog) * smoothstep(0.4, 3.0, -v.z);
  vDepth = -v.z;
}
`;
const FACE_FS = /* glsl */ `
uniform float uA, uLitA, uHeadA, uExpo;
varying float vAl, vV, vFade, vDepth;
${LIGHT}
void main() {
  float lit, head;
  light(vAl, lit, head);
  float g = pow(1.0 - vV, 1.7);
  float near = smoothstep(8.0, 40.0, vDepth);
  float a = min(uExpo * (uA + lit * uLitA + head * uHeadA * near) * (0.25 + 0.75 * g) * vFade, 0.34);
  vec3 col = mix(uInk, uEmber, clamp(lit * 1.2, 0.0, 1.0)) + uHot * head * 0.4 * near;
  gl_FragColor = vec4(col, a);
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
  float size = uSize * uPx / max(depth, 0.5) + coc * 0.7;
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
      uGrow: { value: 1 },
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

function faceMesh(a: number, litA: number, headA: number) {
  const pos: number[] = [];
  const al: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < WALLS.length - 1; i++) {
    const p = WALLS[i]!;
    const q = WALLS[i + 1]!;
    const quad = [
      [p.x, 0, p.z, p.along, 0],
      [q.x, 0, q.z, q.along, 0],
      [q.x, WALL_H, q.z, q.along, 1],
      [p.x, 0, p.z, p.along, 0],
      [q.x, WALL_H, q.z, q.along, 1],
      [p.x, WALL_H, p.z, p.along, 1],
    ];
    for (const [x, y, z, l, h] of quad) {
      pos.push(x!, y!, z!);
      al.push(l!);
      v.push(h!);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aAl", new THREE.Float32BufferAttribute(al, 1));
  g.setAttribute("aV", new THREE.Float32BufferAttribute(v, 1));
  const m = new THREE.ShaderMaterial({
    vertexShader: FACE_VS,
    fragmentShader: FACE_FS,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...GLOBAL, uA: { value: a }, uLitA: { value: litA }, uHeadA: { value: headA } },
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
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

function curve(points: THREE.Vector3[], n: number): Segment[] {
  const c = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const out: Segment[] = [];
  let prev = c.getPoint(0);
  for (let i = 1; i <= n; i++) {
    const p = c.getPoint(i / n);
    out.push(seg([prev.x, prev.y, prev.z], [p.x, p.y, p.z], (i - 1) / n, i / n));
    prev = p;
  }
  return out;
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

export interface LabelSpec {
  id: string;
  at: THREE.Vector3;
  /** scroll window where it is shown: [in start, in end, out start, out end] */
  show: [number, number, number, number];
}

export const LABELS: LabelSpec[] = [
  { id: "push", at: new THREE.Vector3(MOUTH.x + 18, 12, MOUTH.z), show: [0.27, 0.31, 0.34, 0.4] },
  { id: "box", at: new THREE.Vector3(BOX.x, 11, BOX.z), show: [0.6, 0.64, 0.8, 0.84] },
  { id: "mac", at: new THREE.Vector3(MACHINES[0].x, MACHINES[0].y + 14, MACHINES[0].z), show: [0.64, 0.68, 0.78, 0.82] },
  { id: "pc", at: new THREE.Vector3(MACHINES[1].x, MACHINES[1].y + 20, MACHINES[1].z), show: [0.64, 0.68, 0.78, 0.82] },
  { id: "app", at: new THREE.Vector3(appPos(LANDING).x, 16, appPos(LANDING).z), show: [0.9, 0.94, 2, 3] },
];

export interface Options {
  canvas: HTMLCanvasElement;
  light: boolean;
  /** called with the first frame's presence */
  onReady: () => void;
  /** called when the GL context is gone for good */
  onLost: () => void;
  labelEls: Map<string, HTMLElement>;
}

interface Pose {
  pos: THREE.Vector3;
  tgt: THREE.Vector3;
  fov: number;
  fog: number;
  dof: number;
  expo: number;
  /** art offset, share of the viewport: [x, y] */
  off: [number, number];
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function blend(a: Pose, b: Pose, t: number): Pose {
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    tgt: a.tgt.clone().lerp(b.tgt, t),
    fov: a.fov + (b.fov - a.fov) * t,
    fog: a.fog + (b.fog - a.fog) * t,
    dof: a.dof + (b.dof - a.dof) * t,
    expo: a.expo + (b.expo - a.expo) * t,
    off: [a.off[0] + (b.off[0] - a.off[0]) * t, a.off[1] + (b.off[1] - a.off[1]) * t],
  };
}

export function createScene(o: Options) {
  const renderer = new THREE.WebGLRenderer({
    canvas: o.canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);

  const core = { value: 0.1 };
  const macReveal = { value: 0 };
  const pcReveal = { value: 0 };
  const macGain = { value: 0 };
  const pcGain = { value: 0 };
  const macGlow = { value: 0 };
  const pcGlow = { value: 0 };
  const deployReveal = { value: 0 };
  const landGain = { value: 0 };
  const landRing = { value: 0 };

  // —— the walls ——
  const wallTop: Segment[] = [];
  const wallFoot: Segment[] = [];
  const wallMid: Segment[] = [];
  const posts: Segment[] = [];
  const corners: Segment[] = [];
  for (let i = 0; i < WALLS.length - 1; i++) {
    const p = WALLS[i]!;
    const q = WALLS[i + 1]!;
    wallTop.push(seg([p.x, WALL_H, p.z], [q.x, WALL_H, q.z], p.along, q.along));
    wallFoot.push(seg([p.x, 0, p.z], [q.x, 0, q.z], p.along, q.along));
    wallMid.push(seg([p.x, WALL_H * 0.5, p.z], [q.x, WALL_H * 0.5, q.z], p.along, q.along));
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const steps = Math.floor(len / (o.light ? 12 : 8));
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      const x = p.x + (q.x - p.x) * f;
      const z = p.z + (q.z - p.z) * f;
      const al = p.along + (q.along - p.along) * f;
      posts.push(seg([x, 0, z], [x, WALL_H, z], al, al));
    }
    corners.push(seg([p.x, 0, p.z], [p.x, WALL_H, p.z], p.along, p.along));
  }
  const lane: Segment[] = [];
  for (let i = 0; i < LANE_PATH.length - 1; i++) {
    const p = LANE_PATH[i]!;
    const q = LANE_PATH[i + 1]!;
    lane.push(seg([p.x, 0.02, p.z], [q.x, 0.02, q.z], p.along, q.along));
  }

  scene.add(faceMesh(0.075, 0.34, 0.3));
  scene.add(ribbons(wallTop, { w: 0.2, a: 0.9, litA: 0.7, headA: 1.4, build: true, minPx: 1.0 }));
  scene.add(ribbons(wallFoot, { w: 0.12, a: 0.5, litA: 0.55, headA: 1.0, build: true, minPx: 0.8 }));
  scene.add(ribbons(wallMid, { w: 0.07, a: 0.1, litA: 0.2, headA: 0.6, build: true, halo: [4, 0.1] }));
  scene.add(ribbons(posts, { w: 0.06, a: 0.12, litA: 0.3, headA: 0.7, build: true, minPx: 0.45, halo: [3, 0.1] }));
  scene.add(ribbons(corners, { w: 0.14, a: 0.34, litA: 0.5, headA: 1.0, build: true }));
  // the way in: the one line of the mark, in the accent, from the mouth to the heart
  scene.add(ribbons(lane, { w: 0.16, a: 0.55, tint: 0.9, litA: 0.4, headA: 1.4, minPx: 1.0, halo: [9, 0.2] }));

  // —— the box ——
  const boxSegs = boxEdges(BOX.x, 3.6, BOX.z, 7, 7, 7);
  scene.add(ribbons(boxSegs, { w: 0.1, a: 1, tint: 0.5, litA: 0, gain: core, minPx: 1.1, halo: [8, 0.26] }));
  scene.add(ribbons([seg([BOX.x, 7.4, BOX.z], [BOX.x, 130, BOX.z])], { w: 0.14, a: 0.6, tint: 0.7, gain: core, halo: [9, 0.16] }));
  scene.add(glow([BOX.x, 4, BOX.z], 15, core));
  const pool = { value: 0 };
  scene.add(glow([BOX.x, 0.6, BOX.z], 80, pool));

  // —— the machines, and the TLS threads to them ——
  const [mac, pc] = MACHINES;
  const machine = (m: (typeof MACHINES)[number], reveal: { value: number }, gain: { value: number }, glowG: { value: number }, sign: number) => {
    scene.add(ribbons(boxEdges(m.x, m.y, m.z, m.w, m.h, m.d), { w: 0.12, a: 1, tint: 0.3, litA: 0, gain, halo: [7, 0.24], minPx: 1.0 }));
    // a stand: one line to the ground
    scene.add(ribbons([seg([m.x, 0, m.z], [m.x, m.y - m.h / 2, m.z])], { w: 0.07, a: 0.4, litA: 0, gain, minPx: 0.6, halo: false }));
    scene.add(glow([m.x, m.y, m.z], 26, glowG));
    const mid = V((BOX.x + m.x) / 2, 112, (BOX.z + m.z) / 2 + sign * 12);
    scene.add(
      ribbons(curve([V(BOX.x, 7.4, BOX.z), V(BOX.x + (m.x - BOX.x) * 0.18, 60, BOX.z + (m.z - BOX.z) * 0.18), mid, V(m.x, m.y + m.h / 2, m.z)], 72), {
        w: 0.2,
        a: 0.9,
        tint: 0.6,
        litA: 0,
        reveal,
        dash: true,
        tip: 1.7,
        halo: [9, 0.2],
        minPx: 1.0,
      }),
    );
  };
  machine(mac, macReveal, macGain, macGlow, 1);
  machine(pc, pcReveal, pcGain, pcGlow, -1);

  // —— the apps' ring ——
  const tiles: Segment[] = [];
  const land: Segment[] = [];
  APPS.forEach((_, i) => {
    const p = appPos(i);
    const s = i === LANDING ? land : tiles;
    s.push(...boxEdges(p.x, 0.5, p.z, 16, 1, 16));
    s.push(seg([p.x, 1, p.z], [p.x, 14, p.z]));
  });
  scene.add(ribbons(tiles, { w: 0.12, a: 0.5, litA: 0, minPx: 0.8, halo: [5, 0.14] }));
  scene.add(ribbons(land, { w: 0.12, a: 0.5, litA: 0, minPx: 0.8, halo: [6, 0.2] }));
  const landLit = ribbons(land, { w: 0.18, a: 1, tint: 1, litA: 0, gain: landGain, minPx: 1.2, halo: [9, 0.3] });
  scene.add(landLit);
  const lp = appPos(LANDING);
  const landRingMesh = ribbons(ring(1), { w: 0.14, a: 1, tint: 1, litA: 0, gain: landRing, halo: [9, 0.24], minPx: 1 });
  landRingMesh.position.set(lp.x, 0.3, lp.z);
  scene.add(landRingMesh);
  scene.add(glow([lp.x, 4, lp.z], 22, landGain));
  scene.add(ribbons([seg([lp.x, 14, lp.z], [lp.x, 70, lp.z])], { w: 0.14, a: 0.7, tint: 1, gain: landGain, halo: [9, 0.16] }));
  // the deploy's way from the mouth to its app: along the ground, then a short rise
  scene.add(
    ribbons(curve([V(MOUTH.x + 46, 0.5, MOUTH.z), V(MOUTH.x + 74, 6, MOUTH.z + 22), V(lp.x + 22, 9, lp.z - 26), V(lp.x + 2, 5, lp.z - 7)], 56), {
      w: 0.2,
      a: 0.8,
      tint: 0.9,
      litA: 0,
      reveal: deployReveal,
      tip: 1.8,
      halo: [9, 0.22],
      minPx: 1,
    }),
  );

  // the light itself: an orb on the head of the push, and one on the deploy's
  const orbInG = { value: 0 };
  const orbOutG = { value: 0 };
  const orbIn = glow([0, 0, 0], 9, orbInG);
  const orbOut = glow([0, 0, 0], 9, orbOutG);
  scene.add(orbIn, orbOut);

  // —— dust ——
  const dust = motes(o.light ? 380 : 1100, [-110, 0.5, -110, 150, 40, 110], 0.1, 0.5);
  scene.add(dust);

  // —— state ——
  const state = { f: 0, target: 0, t: 0, px: 0, py: 0, ox: 0, oy: 0 };
  let w = 1;
  let h = 1;
  let still = false;
  let ready = false;
  let lost = false;
  let lostTimer = 0;
  const mobile = o.light;

  const POSES = {
    hero: {
      pos: V(150, 236, -118),
      tgt: V(-6, 0, 4),
      fov: 30,
      fog: 0.0022,
      dof: 6,
      expo: 1.9,
      off: mobile ? [0, -0.2] : [0.2, 0],
    } as Pose,
    box: {
      pos: V(30, 150, 290),
      tgt: V(-8, 18, -52),
      fov: 48,
      fog: 0.0030,
      dof: 5,
      expo: 1.8,
      off: mobile ? [0, -0.2] : [0, -0.15],
    } as Pose,
    approach: {
      pos: V(214, 52, -104),
      tgt: V(66, 5, -84),
      fov: 52,
      fog: 0.006,
      dof: 5,
      expo: 1.9,
      off: mobile ? [0, -0.2] : [0, -0.2],
    } as Pose,
    deploy: {
      pos: V(310, 104, -14),
      tgt: V(78, 0, -40),
      fov: 40,
      fog: 0.0034,
      dof: 6,
      expo: 1.9,
      off: mobile ? [0, -0.2] : [0, -0.27],
    } as Pose,
  };

  const EYE = 4.2;
  function lanePose(d: number): Pose {
    const p = laneAt(d);
    const a = laneAt(d - 10);
    const b = laneAt(d - 20);
    const c = laneAt(d - 34);
    const lx = (a.x + b.x + c.x) / 3;
    const lz = (a.z + b.z + c.z) / 3;
    return {
      pos: V(p.x, EYE, p.z),
      tgt: V(lx, EYE - 0.9, lz),
      fov: 74,
      fog: 0.016,
      dof: 3,
      expo: 1.55,
      off: mobile ? [0, -0.2] : [0, -0.2],
    };
  }
  const D_MOUTH = LANE_LENGTH - 8;
  const D_HEART = 9;

  /** Where the camera is in the corridor, as units from the heart. */
  function camDist(f: number): number {
    if (f <= BEATS.walk[0]) return D_MOUTH;
    if (f >= BEATS.walk[1]) return D_HEART;
    const u = span(f, ...BEATS.walk);
    // slow at the mouth, steady between, slowing again at the heart
    const e = u < 0.5 ? 0.5 * Math.pow(u * 2, 1.35) : 1 - 0.5 * Math.pow((1 - u) * 2, 1.35);
    return D_MOUTH + (D_HEART - D_MOUTH) * e;
  }

  function pose(f: number): Pose {
    if (f < BEATS.descend[0]) return POSES.hero;
    if (f < BEATS.descend[1]) {
      const t = inOutCubic(span(f, ...BEATS.descend));
      return t < 0.5 ? blend(POSES.hero, POSES.approach, smooth(t * 2)) : blend(POSES.approach, lanePose(D_MOUTH), smooth(t * 2 - 1));
    }
    if (f < BEATS.walk[1]) {
      return lanePose(camDist(f));
    }
    if (f < BEATS.crane[1]) {
      const t = inOutCubic(span(f, ...BEATS.crane));
      return blend(lanePose(D_HEART), POSES.box, t);
    }
    if (f < BEATS.out[0]) return POSES.box;
    if (f < BEATS.out[1]) {
      const t = inOutCubic(span(f, ...BEATS.out));
      return blend(POSES.box, POSES.deploy, t);
    }
    return POSES.deploy;
  }


  function applyLight(f: number, t: number) {
    // the push: in from the mouth, trail left lit; before it, a quiet idle pulse
    const idle = f < BEATS.descend[1] ? 1 - clamp01((f - 0.17) / 0.09) : 0;
    const pushing = f >= BEATS.pushHead[0];
    if (pushing) {
      // the head leads the camera by a few strides, so the walk is always toward light
      const lead = 30 * smooth(span(f, 0.3, 0.35)) * (1 - 0.7 * smooth(span(f, 0.5, 0.54)));
      const hd =
        f < BEATS.walk[0]
          ? D_MOUTH + 70 * (1 - smooth(span(f, BEATS.pushHead[0], BEATS.walk[0])))
          : camDist(f) - lead;
      GLOBAL.uInHead.value = laneAlongAt(hd) + (hd > LANE_LENGTH ? 0.2 : 0);
      GLOBAL.uInHeadOn.value = f > 0.54 ? Math.max(0, 1 - (f - 0.54) / 0.05) : 1;
      GLOBAL.uInTrail.value = 1;
    } else {
      const cyc = (t / 7.5) % 1;
      GLOBAL.uInHead.value = 1 - inOut(cyc * 1.25 > 1 ? 1 : cyc * 1.25);
      GLOBAL.uInHeadOn.value = idle * (cyc * 1.25 > 1 ? 0 : 0.5);
      GLOBAL.uInTrail.value = 0;
    }
    // the deploy, out from the heart
    const de = span(f, ...BEATS.deployHead);
    GLOBAL.uOutHead.value = inOut(de);
    GLOBAL.uOutTrail.value = de > 0 ? 1 : 0;
    GLOBAL.uOutHeadOn.value = de > 0 && de < 1 ? 1 : de >= 1 ? Math.max(0, 1 - (f - BEATS.deployHead[1]) / 0.05) : 0;
    if (de >= 1) GLOBAL.uOutHead.value = 1.04;

    core.value = 0.32 + 0.68 * smooth(span(f, ...BEATS.core)) + 0.25 * smooth(span(f, ...BEATS.deployHead)) * (1 - span(f, 0.84, 0.9));
    const lm = smooth(span(f, BEATS.links[0], BEATS.links[0] + 0.07));
    const lp2 = smooth(span(f, BEATS.links[0] + 0.04, BEATS.links[1]));
    macReveal.value = lm;
    pcReveal.value = lp2;
    macGain.value = clamp01(lm * 3);
    macGlow.value = macGain.value * 0.5;
    pcGlow.value = pcGain.value * 0.5;
    pool.value = core.value * 0.3;
    const hi = laneAtAlong(clamp01(GLOBAL.uInHead.value));
    orbIn.position.set(hi.x, 3.6, hi.z);
    orbInG.value = GLOBAL.uInHeadOn.value * 0.9;
    const ho = laneAtAlong(clamp01(GLOBAL.uOutHead.value));
    orbOut.position.set(ho.x, 3.6, ho.z);
    orbOutG.value = GLOBAL.uOutHeadOn.value * 0.9;
    pcGain.value = clamp01(lp2 * 3);
    deployReveal.value = smooth(span(f, ...BEATS.thread));
    const lt = smooth(span(f, ...BEATS.land));
    landGain.value = lt;
    const rp = span(f, BEATS.land[0], BEATS.land[1] + 0.06);
    landRing.value = rp > 0 && rp < 1 ? 1 - rp : 0;
    const r = 4 + outExpo(rp) * 30;
    landRingMesh.scale.setScalar(r);
  }

  function frame(dt: number) {
    state.t += dt;
    GLOBAL.uTime.value = state.t;
    state.px += (state.ox - state.px) * (1 - Math.exp(-dt * 3));
    state.py += (state.oy - state.py) * (1 - Math.exp(-dt * 3));
    // intro: the walls grow out of the heart
    if (GLOBAL.uBuild.value < 1) GLOBAL.uBuild.value = Math.min(1, GLOBAL.uBuild.value + dt / 3.4);

    const f = state.f;
    applyLight(f, state.t);
    const p = pose(f);
    const inside = f > BEATS.descend[0] + 0.04 && f < BEATS.crane[0] + 0.03;
    const drift = still ? 0 : inside ? 0.12 : 1;
    const t = state.t;
    camera.position.copy(p.pos);
    camera.position.x += (Math.sin(t * 0.13) * 3.2 + state.px * 7) * drift;
    camera.position.y += Math.sin(t * 0.17) * 1.5 * drift + (inside ? Math.sin(t * 1.6) * 0.05 : 0);
    camera.position.z += (Math.cos(t * 0.11) * 3.2 + state.py * 4) * drift;
    camera.up.set(0, 1, 0);
    camera.lookAt(p.tgt);
    camera.fov = p.fov;
    camera.aspect = w / h;
    if (mobile) {
      camera.fov = p.fov * 1.12;
      if (f < 0.2) camera.fov = p.fov * 1.55;
    } else if (w / h < 1.35) {
      camera.fov = p.fov * 1.14;
    }
    camera.setViewOffset(w, h, -p.off[0] * w, -p.off[1] * h, w, h);
    camera.updateProjectionMatrix();

    const dist = camera.position.distanceTo(tmpV.copy(p.tgt));
    const focus = inside ? 26 : dist;
    GLOBAL.uFocus.value += (focus - GLOBAL.uFocus.value) * (1 - Math.exp(-dt * 4));
    GLOBAL.uFog.value = p.fog;
    GLOBAL.uDof.value = p.dof;
    GLOBAL.uExpo.value = p.expo;
    GLOBAL.uPx.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    renderer.render(scene, camera);

    // labels, anchored
    for (const L of LABELS) {
      const el = o.labelEls.get(L.id);
      if (!el) continue;
      const vis = smooth(span(f, L.show[0], L.show[1])) * (1 - smooth(span(f, L.show[2], L.show[3])));
      tmpV.copy(L.at).project(camera);
      const behind = tmpV.z > 1;
      const sx = (tmpV.x * 0.5 + 0.5) * w;
      const sy = (-tmpV.y * 0.5 + 0.5) * h;
      const onscreen = sx > 20 && sx < w - 20 && sy > 20 && sy < h - 20 && !behind;
      el.style.opacity = onscreen ? String(vis) : "0";
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
    if (!ready) {
      ready = true;
      o.onReady();
    }
  }

  function resize(cw: number, ch: number) {
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    GLOBAL.uRes.value.set(w * dpr, h * dpr);
    if (!still) frame(0);
  }

  function onLost(e: Event) {
    e.preventDefault();
    lost = true;
    lostTimer = window.setTimeout(() => {
      if (lost) o.onLost();
    }, 2500);
  }
  function onRestored() {
    lost = false;
    clearTimeout(lostTimer);
  }
  o.canvas.addEventListener("webglcontextlost", onLost);
  o.canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    setProgress(f: number) {
      state.f = f;
      state.target = f;
    },
    /** One frame, dt seconds after the last. */
    tick(dt: number) {
      frame(Math.min(0.05, dt));
    },
    /** parallax, -1..1 */
    setPointer(x: number, y: number) {
      state.ox = x;
      state.oy = y;
    },
    resize,
    /** The composed still: the hero's pose with everything lit, the deploy landed. */
    renderStill() {
      still = true;
      GLOBAL.uBuild.value = 1;
      state.target = state.f = 0.97;
      // pose the camera at the hero view with the finished light
      state.target = state.f = 0;
      GLOBAL.uInHead.value = 0;
      GLOBAL.uInTrail.value = 1;
      GLOBAL.uOutHead.value = 1.04;
      GLOBAL.uOutTrail.value = 1;
      core.value = 1;
      macReveal.value = pcReveal.value = 1;
      macGain.value = pcGain.value = 1;
      deployReveal.value = 1;
      landGain.value = 1;
      const t = state.t;
      applyLight(0.97, t);
      const p = POSES.hero;
      camera.position.copy(p.pos);
      camera.lookAt(p.tgt);
      camera.fov = p.fov * (mobile ? 1.55 : w / h < 1.35 ? 1.14 : 1);
      camera.aspect = w / h;
      camera.setViewOffset(w, h, -p.off[0] * w, -p.off[1] * h, w, h);
      camera.updateProjectionMatrix();
      GLOBAL.uFocus.value = camera.position.distanceTo(p.tgt);
      GLOBAL.uFog.value = p.fog;
      GLOBAL.uDof.value = p.dof;
      GLOBAL.uExpo.value = p.expo;
      GLOBAL.uPx.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      renderer.render(scene, camera);
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

export type WalkScene = ReturnType<typeof createScene>;
