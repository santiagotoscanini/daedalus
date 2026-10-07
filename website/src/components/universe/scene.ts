import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/** The universe's scene: one cube per service, each carrying the service's own mark on all six faces,
 * in one InstancedMesh (one draw call). Scroll sets one number, p, and the camera follows it:
 *
 *   river  (p 0 .. .5)  cubes stream right to left on depth-staggered lanes, the few in focus passing
 *                       through the middle of the frame, large and slow to tumble; the far lanes are
 *                       small, dim and soft, with streaks behind them.
 *   pull   (p .3 .. .8) the camera backs away and rises while each cube leaves its lane for a place in a
 *                       field around one warm point, waves of it radiating from the middle, and the
 *                       field's light threads (one from the point to every cube) ignite behind them.
 *   field  (p .8 .. 1)  the whole of it, hanging in depth, turning slowly.
 *
 * Ambient motion is a separate additive layer on its own clock: the river's drift, the tumble, the
 * field's slow orbit and the breathing of the light never stop and never wait on the scroll. The camera
 * and the cubes' leave-the-lane waves are what the scroll drives, eased toward it so a flick and a
 * crawl both land without a step. Marks are drawn once into an atlas (sharp, mip-mapped) and the shader
 * softens them with distance from the focal plane, which is the depth of field. */

export interface Item {
  id: string;
  name: string;
  url: string;
  focus?: boolean;
}

export interface LabelPlacement {
  index: number;
  x: number;
  y: number;
  a: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (f: number, a: number, b: number) => clamp((f - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = 128;
const GRID = 8;

/** Every mark into one texture: contain-fit into its cell with a margin, so a mark never touches its
 * neighbour's cell when the shader samples a blurred mip. */
async function buildAtlas(items: Item[]) {
  const size = CELL * GRID;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const cx = cv.getContext("2d")!;
  cx.imageSmoothingQuality = "high";
  await Promise.all(
    items.map(async (it, i) => {
      const img = new Image();
      img.decoding = "async";
      img.src = it.url;
      try {
        await img.decode();
      } catch {
        return;
      }
      const iw = img.naturalWidth || img.width || 128;
      const ih = img.naturalHeight || img.height || 128;
      const box = CELL * 0.8;
      const k = Math.min(box / iw, box / ih);
      const w = iw * k;
      const h = ih * k;
      const col = i % GRID;
      const row = Math.floor(i / GRID);
      cx.drawImage(img, col * CELL + (CELL - w) / 2, row * CELL + (CELL - h) / 2, w, h);
    }),
  );
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  return { tex, bytes: size * size * 4 };
}

const CUBE_VERT = /* glsl */ `
attribute float aCell;
attribute float aLit;
attribute float aBlur;
varying vec3 vPos;
varying vec3 vNV;
varying vec3 vView;
varying float vCell;
varying float vLit;
varying float vBlur;
varying float vDepth;
void main() {
  vPos = position;
  vCell = aCell;
  vLit = aLit;
  vBlur = aBlur;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vNV = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
  vView = -mv.xyz;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const CUBE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uBg;
uniform float uFog;
varying vec3 vPos;
varying vec3 vNV;
varying vec3 vView;
varying float vCell;
varying float vLit;
varying float vBlur;
varying float vDepth;
void main() {
  vec3 a = abs(vPos);
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) uv = vec2(-vPos.z * sign(vPos.x), vPos.y);
  else if (a.y >= a.z) uv = vec2(vPos.x, -vPos.z * sign(vPos.y));
  else uv = vec2(vPos.x * sign(vPos.z), vPos.y);
  uv += 0.5;
  vec3 N = normalize(vNV);
  vec3 V = normalize(vView);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 3.4);

  // body: ink glass, a touch lighter toward the top of each face, with a bevelled frame
  vec2 e = abs(uv - 0.5);
  float edge = max(e.x, e.y);
  vec3 body = mix(vec3(0.030, 0.031, 0.040), vec3(0.085, 0.087, 0.105), uv.y * 0.8);
  body += vec3(0.07, 0.07, 0.085) * smoothstep(0.42, 0.50, edge);
  vec3 R = reflect(-V, N);
  float sheen = smoothstep(0.35, 0.95, R.y * 0.5 + 0.5) * smoothstep(0.0, 0.6, R.x * 0.5 + 0.5);
  body += vec3(0.8, 0.84, 1.0) * sheen * 0.07;

  // the mark, on the middle of the face
  vec2 iu = (uv - 0.5) / 0.66 + 0.5;
  float inside = step(0.0, iu.x) * step(iu.x, 1.0) * step(0.0, iu.y) * step(iu.y, 1.0);
  float col = mod(vCell, 8.0);
  float row = floor(vCell / 8.0);
  vec2 auv = (vec2(col, row) + vec2(clamp(iu.x, 0.0, 1.0), 1.0 - clamp(iu.y, 0.0, 1.0))) / 8.0;
  vec4 ic = texture2D(uAtlas, auv, vBlur) * inside;

  vec3 ember = vec3(0.95, 0.46, 0.30);
  vec3 c = body + ember * fres * (0.05 + 0.85 * vLit) + ember * 0.05 * smoothstep(0.44, 0.5, edge) * vLit;
  float k = 0.34 + 0.86 * vLit;
  c = mix(c, ic.rgb * k, ic.a);
  c += ic.rgb * ic.a * vLit * 0.16;

  float f = 1.0 - exp(-uFog * vDepth);
  c = mix(c, uBg, clamp(f, 0.0, 0.92));
  gl_FragColor = vec4(c, 1.0);
}`;

const STREAK_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = uv;
  vA = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const STREAK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vA;
void main() {
  // bright at the cube's end (right), thinning to nothing behind it, soft across
  float along = pow(vUv.x, 1.6);
  float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
  across = pow(max(across, 0.0), 1.5);
  gl_FragColor = vec4(vec3(1.0, 0.62, 0.45) * along * across * vA, 1.0);
}`;

const THREAD_VERT = /* glsl */ `
attribute float aT;
attribute float aLit;
uniform float uTime;
varying float vT;
varying float vLit;
void main() {
  vT = aT;
  vLit = aLit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const THREAD_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
varying float vT;
varying float vLit;
void main() {
  float pulse = 0.5 + 0.5 * sin(vT * 14.0 - uTime * 1.6);
  float a = vLit * (0.07 + 0.26 * vT + 0.22 * pulse * (1.0 - vT));
  gl_FragColor = vec4(vec3(1.0, 0.55, 0.38) * a, 1.0);
}`;

const DUST_VERT = /* glsl */ `
attribute float aS;
uniform float uPx;
uniform float uTime;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(aS * uPx / d, 1.0, 3.2);
  vA = clamp(1.4 - d / 900.0, 0.0, 1.0) * (0.6 + 0.4 * sin(uTime * 0.7 + aS * 40.0));
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
precision highp float;
varying float vA;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(p));
  gl_FragColor = vec4(vec3(0.85, 0.62, 0.55) * a * vA * 0.5, 1.0);
}`;

const GRID_VERT = /* glsl */ `
varying float vD;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const GRID_FRAG = /* glsl */ `
precision highp float;
uniform float uA;
varying float vD;
void main() {
  float a = uA * clamp(1.0 - vD / 1100.0, 0.0, 1.0) * 0.16;
  gl_FragColor = vec4(vec3(0.75, 0.78, 0.9) * a, 1.0);
}`;

export interface Options {
  canvas: HTMLCanvasElement;
  items: Item[];
  mobile: boolean;
  onReady: () => void;
  /** the text zone, in stage pixels: nothing is drawn over it */
  keepout?: () => { l: number; t: number; r: number; b: number } | null;
}

export async function createUniverse(o: Options) {
  const { items, mobile } = o;
  const N = items.length;
  const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  const BG = new THREE.Color(0x08080a);
  renderer.setClearColor(BG, 1);
  const { tex: atlas, bytes: atlasBytes } = await buildAtlas(items);
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const FOV = mobile ? 46 : 36;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 3000);
  let W = 1;
  let H = 1;

  // ── layout ────────────────────────────────────────────────────────────────
  const R = rng(0x5eed);
  const SIZE = mobile ? 8 : 7;
  const SPAN = 250;
  interface Rv {
    x0: number;
    y: number;
    z: number;
    v: number;
    par: number;
    focus: boolean;
    near: number;
  }
  const river: Rv[] = [];
  const focusIdx = items.map((it, i) => (it.focus ? i : -1)).filter((i) => i >= 0);
  let fi = 0;
  items.forEach((it, i) => {
    if (it.focus) {
      // the few in focus: near the camera, in a row that begins at the middle of the frame
      const k = fi++;
      river.push({ x0: k * (mobile ? 22 : 27), y: (k % 2 ? 1 : -1) * (mobile ? 5 : 2.4), z: mobile ? 2 : 4, v: 1.4, par: 190, focus: true, near: 1 });
      return;
    }
    const lane = Math.floor(R() * 6);
    const near = 1 - lane / 5;
    const z = lerp(-8, -170, lane / 5) + (R() - 0.5) * 12;
    const dist = 62 - z;
    const half = Math.tan((FOV * Math.PI) / 360) * dist;
    let y = (R() * 2 - 1) * half * (mobile ? 0.75 : 0.7);
    if (z > -70 && Math.abs(y) < 11) y += (y < 0 ? -1 : 1) * 11;
    river.push({ x0: (R() * 2 - 1) * SPAN * 0.5, y, z, v: 5 + near * 13 + R() * 4, par: 70 + near * 120, focus: false, near });
    void i;
  });

  // the field: a flattened shell-cloud round one warm point, in depth
  const HEART = new THREE.Vector3(0, 6, -150);
  const field: THREE.Vector3[] = [];
  const sx = mobile ? 0.75 : 1.35;
  const rMax = mobile ? 118 : 170;
  const minSep = mobile ? 27 : 36;
  let guard = 0;
  while (field.length < N && guard++ < 20000) {
    const u = R() * 2 - 1;
    const th = R() * Math.PI * 2;
    const rad = 52 + (rMax - 52) * Math.pow(R(), 0.8);
    const q = Math.sqrt(1 - u * u);
    const p = new THREE.Vector3(Math.cos(th) * q * rad * sx, u * rad * 0.5, Math.sin(th) * q * rad).add(HEART);
    if (field.every((f) => f.distanceTo(p) > minSep)) field.push(p);
  }
  while (field.length < N) field.push(new THREE.Vector3((R() - 0.5) * 300, (R() - 0.5) * 80, -60 - R() * 200));
  // which cube gets which place: the focus ones take the nearest places to the heart's front
  const order = field.map((_, i) => i).sort((a, b) => field[b]!.z - field[a]!.z);
  const place: THREE.Vector3[] = new Array(N);
  const nonFocus = items.map((_, i) => i).filter((i) => !items[i]!.focus);
  const slots = [...order];
  focusIdx.forEach((i) => place[i] = field[slots.shift()!]!);
  nonFocus.forEach((i) => {
    const j = Math.floor(R() * slots.length);
    place[i] = field[slots.splice(j, 1)[0]!]!;
  });
  const maxD = Math.max(...place.map((p) => p.distanceTo(HEART)));
  const dNorm = place.map((p) => p.distanceTo(HEART) / maxD);
  const phase = items.map(() => R() * 6.283);
  const spin = items.map(() => (0.25 + R() * 0.45) * (R() < 0.5 ? -1 : 1));

  // ── cubes ─────────────────────────────────────────────────────────────────
  const geo = new RoundedBoxGeometry(1, 1, 1, 4, 0.12);
  const aCell = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
  const aLit = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
  const aBlur = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < N; i++) aCell.setX(i, i);
  geo.setAttribute("aCell", aCell);
  geo.setAttribute("aLit", aLit);
  geo.setAttribute("aBlur", aBlur);
  const cubeMat = new THREE.ShaderMaterial({
    vertexShader: CUBE_VERT,
    fragmentShader: CUBE_FRAG,
    uniforms: { uAtlas: { value: atlas }, uBg: { value: new THREE.Vector3(BG.r, BG.g, BG.b) }, uFog: { value: 0.0012 } },
  });
  const cubes = new THREE.InstancedMesh(geo, cubeMat, N);
  cubes.frustumCulled = false;
  cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(cubes);

  // streaks behind the cubes in the river, and a few of their own on the far lanes
  const DECOR = mobile ? 14 : 28;
  const sGeo = new THREE.PlaneGeometry(1, 1);
  sGeo.translate(0.5, 0, 0);
  const aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(N + DECOR), 1).setUsage(THREE.DynamicDrawUsage);
  sGeo.setAttribute("aAlpha", aAlpha);
  const streakMat = new THREE.ShaderMaterial({
    vertexShader: STREAK_VERT,
    fragmentShader: STREAK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const streaks = new THREE.InstancedMesh(sGeo, streakMat, N + DECOR);
  streaks.frustumCulled = false;
  streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streaks.renderOrder = 2;
  scene.add(streaks);
  const decor = Array.from({ length: DECOR }, () => {
    const z = -40 - R() * 260;
    const half = Math.tan((FOV * Math.PI) / 360) * (62 - z);
    return { x0: (R() * 2 - 1) * SPAN * 0.6, y: (R() * 2 - 1) * half * 0.8, z, v: 14 + R() * 26, len: 14 + R() * 40, a: 0.25 + R() * 0.5 };
  });

  // threads from the warm point to every cube, and the point itself
  const tPos = new Float32Array(N * 6);
  const tT = new Float32Array(N * 2);
  const tLit = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    tT[i * 2] = 0;
    tT[i * 2 + 1] = 1;
  }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  tGeo.setAttribute("aT", new THREE.BufferAttribute(tT, 1));
  tGeo.setAttribute("aLit", new THREE.BufferAttribute(tLit, 1).setUsage(THREE.DynamicDrawUsage));
  const threadMat = new THREE.ShaderMaterial({
    vertexShader: THREAD_VERT,
    fragmentShader: THREAD_FRAG,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const threads = new THREE.LineSegments(tGeo, threadMat);
  threads.frustumCulled = false;
  threads.renderOrder = 1;
  scene.add(threads);

  const hc = document.createElement("canvas");
  hc.width = hc.height = 128;
  const hx = hc.getContext("2d")!;
  const hg = hx.createRadialGradient(64, 64, 0, 64, 64, 64);
  hg.addColorStop(0, "rgba(255,236,220,1)");
  hg.addColorStop(0.12, "rgba(255,170,130,0.75)");
  hg.addColorStop(0.45, "rgba(226,121,90,0.16)");
  hg.addColorStop(1, "rgba(226,121,90,0)");
  hx.fillStyle = hg;
  hx.fillRect(0, 0, 128, 128);
  const heart = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(hc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  heart.position.copy(HEART);
  heart.renderOrder = 3;
  scene.add(heart);

  // dust and a receding floor, so the depth has something to be measured against
  const DUST = mobile ? 260 : 700;
  const dPos = new Float32Array(DUST * 3);
  const dS = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dPos[i * 3] = (R() * 2 - 1) * 380;
    dPos[i * 3 + 1] = (R() * 2 - 1) * 150 + 10;
    dPos[i * 3 + 2] = 100 - R() * 620;
    dS[i] = 0.4 + R();
  }
  const dGeo = new THREE.BufferGeometry();
  dGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
  dGeo.setAttribute("aS", new THREE.BufferAttribute(dS, 1));
  const dustMat = new THREE.ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: { uPx: { value: 1000 }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dGeo, dustMat);
  dust.renderOrder = 1;
  scene.add(dust);

  const gl: number[] = [];
  for (let x = -600; x <= 600; x += 60) gl.push(x, 0, 120, x, 0, -760);
  for (let z = 120; z >= -760; z -= 60) gl.push(-600, 0, z, 600, 0, z);
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute("position", new THREE.Float32BufferAttribute(gl, 3));
  const gridMat = new THREE.ShaderMaterial({
    vertexShader: GRID_VERT,
    fragmentShader: GRID_FRAG,
    uniforms: { uA: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const grid = new THREE.LineSegments(gGeo, gridMat);
  grid.position.y = -78;
  grid.renderOrder = 0;
  scene.add(grid);

  // ── the camera's two ends ─────────────────────────────────────────────────
  const camStart = { pos: new THREE.Vector3(0, 3, 62), tgt: new THREE.Vector3(0, 0, 0) };
  const camEnd = { pos: new THREE.Vector3(), tgt: HEART.clone().add(new THREE.Vector3(0, -4, 0)) };
  const fitEnd = () => {
    const aspect = W / H;
    const halfW = rMax * sx * 1.12 + SIZE * 2.4;
    const halfH = rMax * 0.5 * 1.4 + 40;
    const dist = Math.max(halfW / (Math.tan((FOV * Math.PI) / 360) * aspect), halfH / Math.tan((FOV * Math.PI) / 360)) * 0.76;
    const el = (mobile ? 40 : 30) * (Math.PI / 180);
    camEnd.pos.set(0, Math.sin(el) * dist, Math.cos(el) * dist).add(HEART);
  };

  // ── state ─────────────────────────────────────────────────────────────────
  const st = { p: 0, t: 0, tr: 0, px: 0, py: 0, ox: 0, oy: 0, scrollV: 0, lastS: 0 };
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const pos = Array.from({ length: N }, () => new THREE.Vector3());
  const scl = new Float32Array(N);
  const labels: LabelPlacement[] = [];
  let ready = false;
  let still = false;

  const wrap = (x: number) => ((((x + SPAN / 2) % SPAN) + SPAN) % SPAN) - SPAN / 2;
  const camPos = new THREE.Vector3();
  const camTgt = new THREE.Vector3();

  function apply(dt: number) {
    const p = st.p;
    const t = st.t;
    const S = smooth(span(p, 0, 0.5));
    const wG = smooth(span(p, 0.3, 0.62));
    // the river's clock slows to nothing as the lanes dissolve into the field
    st.tr += dt * (1 - wG);
    const trv = still ? 0 : st.tr;

    // scroll velocity, smoothed, for the streaks
    const sv = dt > 0 ? Math.abs(S - st.lastS) / dt : 0;
    st.lastS = S;
    st.scrollV += (sv - st.scrollV) * (1 - Math.exp(-dt * 6));

    const ez = inOut(span(p, 0.26, 0.8));
    camPos.lerpVectors(camStart.pos, camEnd.pos, ez);
    camTgt.lerpVectors(camStart.tgt, camEnd.tgt, ez);
    // a slow breath of the camera and a little of the pointer, never still
    camPos.x += Math.sin(t * 0.21) * 2.2 * (1 - ez * 0.4) + st.px * 6;
    camPos.y += Math.sin(t * 0.17 + 1) * 1.4 - st.py * 3;
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    camera.updateMatrixWorld();
    // the focal plane rides the focus cubes in the river and the heart in the field
    const focusDist = lerp(48, camPos.distanceTo(HEART), ez);

    const wave = (i: number) => smooth(span(p, 0.3 + dNorm[i]! * 0.26, 0.44 + dNorm[i]! * 0.26));
    const ignite = (i: number) => smooth(span(p, 0.36 + dNorm[i]! * 0.26, 0.5 + dNorm[i]! * 0.24));
    let streakI = 0;

    for (let i = 0; i < N; i++) {
      const r = river[i]!;
      const w = wave(i);
      const rx = wrap(r.x0 - trv * r.v - S * r.par);
      const rp = tmpV.set(rx, r.y + Math.sin(t * 0.5 + phase[i]!) * 0.6, r.z);
      const fp = place[i]!;
      const orb = tmpS.set(Math.sin(t * 0.13 + phase[i]!) * 3, Math.sin(t * 0.21 + phase[i]! * 2) * 2.4, Math.cos(t * 0.11 + phase[i]!) * 3);
      const e = inOut(w);
      const P = pos[i]!;
      P.set(lerp(rp.x, fp.x + orb.x, e), lerp(rp.y, fp.y + orb.y, e), lerp(rp.z, fp.z + orb.z, e));
      // the field's cubes are larger, so a mark still reads from where the camera ends
      const grow = lerp(1, mobile ? 2.6 : 2.5, e);
      const base = SIZE * (r.focus ? 0.95 : 0.78 + r.near * 0.2);
      scl[i] = base * grow * (r.focus ? lerp(1, 0.9, e) : 1);
      // nothing is cropped by the frame's edges in the stream, and nothing stands on the text
      tmpV.copy(P).project(camera);
      const dd = P.distanceTo(camPos);
      const half = (scl[i]! / (2 * dd * Math.tan((FOV * Math.PI) / 360))) * H * 0.9;
      const scx = (tmpV.x * 0.5 + 0.5) * W;
      const scy = (-tmpV.y * 0.5 + 0.5) * H;
      const edge = 1 - smooth(span(Math.max(Math.abs(scx - W / 2) + half - W / 2, 0), 0, half * 1.4)) * (1 - e);
      let clear = 1;
      const kz = o.keepout?.();
      if (kz) {
        const dx = Math.max(kz.l - (scx + half), scx - half - kz.r, 0);
        const dy = Math.max(kz.t - (scy + half), scy - half - kz.b, 0);
        clear = smooth(span(Math.hypot(dx, dy), 0, 60));
      }
      scl[i] = scl[i]! * Math.max(0.0001, edge * clear);
      // slow tumble; the cubes in focus settle toward a readable face while they cross the middle
      const centre = r.focus ? (1 - e) * (1 - smooth(span(Math.abs(P.x), 10, 46))) : 0;
      const amp = lerp(1, 0.16, centre);
      tmpE.set(Math.sin(t * 0.31 + phase[i]!) * 0.35 * amp + 0.28, t * spin[i]! * amp + phase[i]! + (r.focus ? Math.sin(t * 0.4 + phase[i]!) * 0.35 : 0), Math.sin(t * 0.23 + phase[i]! * 1.7) * 0.2 * amp);
      tmpQ.setFromEuler(tmpE);
      tmpM.compose(P, tmpQ, tmpS.setScalar(scl[i]!));
      cubes.setMatrixAt(i, tmpM);

      // light: the river lights by nearness, the field by the wave of ignition, both breathing
      const dist = P.distanceTo(camPos);
      const riverLit = 0.4 + 0.6 * r.near * (r.focus ? 1 : 0.8);
      const lit = riverLit * (1 - e) + e * (0.5 + 0.5 * ignite(i));
      const breath = 0.9 + 0.1 * Math.sin(t * 0.9 + phase[i]!);
      aLit.setX(i, clamp(lit * breath));
      aBlur.setX(i, clamp((Math.abs(dist - focusDist) / Math.max(focusDist, 30)) * 3.2, 0, 2.4));

      // threads: from the heart to the cube, lit with the cube
      tPos[i * 6] = HEART.x;
      tPos[i * 6 + 1] = HEART.y;
      tPos[i * 6 + 2] = HEART.z;
      tPos[i * 6 + 3] = P.x;
      tPos[i * 6 + 4] = P.y;
      tPos[i * 6 + 5] = P.z;
      const tl = smooth(span(p, 0.36, 0.52)) * ignite(i) * e * 0.8;
      tLit[i * 2] = tl;
      tLit[i * 2 + 1] = tl;

      // a streak behind each cube while it is in the river
      const speed = r.v * (1 - wG) + st.scrollV * r.par * 1.1;
      const len = clamp(speed * 0.55, 0, 90) * (1 - e) * (r.focus ? 0.7 : 1);
      tmpQ.identity();
      tmpM.compose(tmpV.set(P.x + scl[i]! * 0.2, P.y, P.z - 0.5), tmpQ, tmpS.set(Math.max(len, 0.001), scl[i]! * 0.34, 1));
      streaks.setMatrixAt(streakI, tmpM);
      aAlpha.setX(streakI, len > 1 ? 0.36 * (1 - e) * (0.4 + 0.6 * r.near) : 0);
      streakI++;
    }
    for (let d = 0; d < DECOR; d++) {
      const q = decor[d]!;
      const x = wrap(q.x0 - trv * q.v * 2.2 - S * (q.v * 7));
      const len = clamp(q.len * (0.5 + st.scrollV * 3.5), 0, 120);
      tmpQ.identity();
      tmpM.compose(tmpV.set(x, q.y, q.z), tmpQ, tmpS.set(len, 0.35 + q.v * 0.02, 1));
      streaks.setMatrixAt(streakI, tmpM);
      aAlpha.setX(streakI, q.a * 0.45 * (1 - wG));
      streakI++;
    }
    cubes.instanceMatrix.needsUpdate = true;
    streaks.instanceMatrix.needsUpdate = true;
    aLit.needsUpdate = true;
    aBlur.needsUpdate = true;
    aAlpha.needsUpdate = true;
    (tGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (tGeo.getAttribute("aLit") as THREE.BufferAttribute).needsUpdate = true;
    threadMat.uniforms.uTime!.value = t;
    dustMat.uniforms.uTime!.value = t;
    gridMat.uniforms.uA!.value = smooth(span(p, 0.4, 0.8));
    const hs = 20 + 26 * smooth(span(p, 0.36, 0.7)) + Math.sin(t * 0.8) * 2;
    heart.scale.setScalar(hs);
    (heart.material as THREE.SpriteMaterial).opacity = smooth(span(p, 0.34, 0.6));
    cubeMat.uniforms.uFog!.value = lerp(0.0016, 0.0009, ez);

    // names for the cubes in focus: the ones large on screen and near the middle, apart from each other
    labels.length = 0;
    if (wG < 0.5) {
      const cand: LabelPlacement[] = [];
      for (let i = 0; i < N; i++) {
        tmpV.copy(pos[i]!).project(camera);
        if (tmpV.z > 1) continue;
        const dist = pos[i]!.distanceTo(camPos);
        const sz = (scl[i]! / (2 * dist * Math.tan((FOV * Math.PI) / 360))) * H;
        if (sz < (mobile ? 70 : 96)) continue;
        const x = (tmpV.x * 0.5 + 0.5) * W;
        const y = (-tmpV.y * 0.5 + 0.5) * H;
        if (x < 60 || x > W - 60) continue;
        const centre = 1 - Math.abs(tmpV.x);
        cand.push({ index: i, x, y: y + sz * 0.62 + 12, a: smooth(span(centre, 0.15, 0.55)) * (1 - wG * 2) });
      }
      cand.sort((a, b) => b.a - a.a);
      for (const c of cand) {
        if (c.a < 0.05 || labels.length >= 3) continue;
        if (labels.every((l) => Math.abs(l.x - c.x) > 170)) labels.push(c);
      }
    }
  }

  function resize(w: number, h: number) {
    W = Math.max(1, w);
    H = Math.max(1, h);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    dustMat.uniforms.uPx!.value = (H * renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360)) * 1.2;
    fitEnd();
  }

  const frame = (dt: number) => {
    st.t += dt;
    st.px += (st.ox - st.px) * (1 - Math.exp(-dt * 3));
    st.py += (st.oy - st.py) * (1 - Math.exp(-dt * 3));
    apply(dt);
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      o.onReady();
    }
  };

  return {
    atlasBytes,
    labels,
    names: items.map((i) => i.name),
    setProgress(p: number) {
      st.p = p;
    },
    setPointer(x: number, y: number) {
      st.ox = x;
      st.oy = y;
    },
    tick(dt: number) {
      frame(Math.min(0.05, dt));
    },
    resize,
    /** the finished field, once: every cube in place and lit, the threads drawn */
    renderStill() {
      still = true;
      st.p = 1;
      st.t = 14;
      frame(0);
      labels.length = 0;
    },
    dispose() {
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      atlas.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

export type UniverseScene = Awaited<ReturnType<typeof createUniverse>>;
