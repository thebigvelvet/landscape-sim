// Rock layers (Colorado Plateau style): a stack of sandstone, shale, siltstone and limestone beds
// made fresh for each landscape from its seed. Rock type is worked out from a cell's bedrock
// elevation and position, so no extra buffer is needed and every cut reveals the next bed down.
//
// Like real plateau country the stack is not periodic: bed thickness is drawn log-normal per rock
// type (thin beds outnumber thick ones), hard and soft beds mostly alternate, and no two beds of
// the same type are quite alike. The whole stack is tilted by a gentle regional dip (0.3-4 deg),
// and some landscapes also get a monocline (beds bending down steeply across a narrow band, like
// the Waterpocket Fold or Comb Ridge) or a broad anticline/syncline.
//
// Each bed sets how fast running water wears the rock (erode), how fast it breaks down into soil
// (weather) and how steep a face it can hold before it falls (cliffTan). Hard beds over soft ones
// then erode into cliffs above slopes, benches, cuestas, hogbacks and mesas on their own.
//
// The bed table and structure go to the GPU in the params uniform (sim) and the render uniform,
// and the same WGSL lookup is used by both, so the colours drawn are the beds the erosion is
// actually working on. Mirrored on the CPU by strataLayer() for tests.

export const MAX_BEDS = 32;

// Rock types. thick: median bed thickness (m) at strataScale 1, sd: log-normal spread.
export const LITHOLOGY = {
  massiveSand: { name: 'Massive sandstone', hard: true, thick: 32, sd: 0.6, erode: 0.25, weather: 0.3, cliffTan: 4.0,
    colors: [[0.84, 0.52, 0.32], [0.90, 0.80, 0.64], [0.78, 0.44, 0.28]] },
  thinSand: { name: 'Thin-bedded sandstone', hard: true, thick: 8, sd: 0.5, erode: 0.6, weather: 0.7, cliffTan: 2.4,
    colors: [[0.78, 0.60, 0.45], [0.74, 0.52, 0.40]] },
  limestone: { name: 'Limestone', hard: true, thick: 5, sd: 0.5, erode: 0.4, weather: 0.5, cliffTan: 3.0,
    colors: [[0.80, 0.78, 0.72], [0.74, 0.72, 0.66]] },
  redShale: { name: 'Red shale', hard: false, thick: 18, sd: 0.6, erode: 3.0, weather: 2.5, cliffTan: 0.9,
    colors: [[0.62, 0.30, 0.22], [0.58, 0.34, 0.30], [0.66, 0.38, 0.26]] },
  grayShale: { name: 'Gray shale', hard: false, thick: 22, sd: 0.6, erode: 3.2, weather: 2.6, cliffTan: 0.85,
    colors: [[0.56, 0.55, 0.50], [0.50, 0.50, 0.48], [0.60, 0.56, 0.46]] },
  siltstone: { name: 'Siltstone', hard: false, thick: 10, sd: 0.5, erode: 1.6, weather: 1.5, cliffTan: 1.4,
    colors: [[0.70, 0.45, 0.35], [0.66, 0.50, 0.40]] },
  basement: { name: 'Basement', hard: true, thick: 1e6, sd: 0, erode: 0.2, weather: 0.25, cliffTan: 4.0,
    colors: [[0.45, 0.38, 0.36]] },
};
const MEAN_BED = 15;   // rough mean bed thickness (m) of the mix below at scale 1
const HARD = [['massiveSand', 0.5], ['thinSand', 0.3], ['limestone', 0.2]];
const SOFT = [['redShale', 0.4], ['grayShale', 0.35], ['siltstone', 0.25]];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Structure offset (m) of the bed surfaces at map position (px, py) in metres from the centre:
// regional dip, monocline step and broad fold. The noise warp is added separately.
function structure(S, px, py) {
  let z = -(S.dipX * px + S.dipY * py);
  if (S.monoThrow > 0) {
    const s = Math.max(-10, Math.min(10, (S.monoNx * px + S.monoNy * py - S.monoC) / S.monoW));
    z -= S.monoThrow * 0.5 * (1 + Math.tanh(s));
  }
  if (S.foldA !== 0) z += S.foldA * Math.cos(S.foldKx * px + S.foldKy * py + S.foldPh);
  return z;
}

// Make the rock stack for one landscape. height: starting terrain (m), N x N cells of cellSize m.
export function makeStrata(seed, height, N, cellSize, scale = 1) {
  const rnd = mulberry32((seed | 0) * 48271 + 911);
  const between = (a, b) => a + (b - a) * rnd();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const pick = (list) => { let r = rnd(), k = 0; while (k < list.length - 1 && (r -= list[k][1]) > 0) k++; return list[k][0]; };
  const ext = N * cellSize;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N * N; i++) { if (height[i] < mn) mn = height[i]; if (height[i] > mx) mx = height[i]; }
  const range = Math.max(20, mx - mn);
  const deg = Math.PI / 180;

  // regional dip: log-uniform 0.3-4 deg toward a random azimuth
  const dip = Math.exp(between(Math.log(0.3), Math.log(4))), az = rnd() * 2 * Math.PI;
  const S = { dipDeg: dip, dipAz: az, dipX: Math.tan(dip * deg) * Math.cos(az), dipY: Math.tan(dip * deg) * Math.sin(az),
    monoThrow: 0, monoNx: 1, monoNy: 0, monoC: 0, monoW: 1, monoDeg: 0, foldA: 0, foldKx: 0, foldKy: 0, foldPh: 0 };
  // monocline: strike close to the regional strike, beds stepping down toward the dip
  if (rnd() < 0.35) {
    const a = az + between(-0.35, 0.35);
    S.monoNx = Math.cos(a); S.monoNy = Math.sin(a);
    S.monoC = between(-0.3, 0.3) * ext;
    S.monoThrow = between(0.3, 0.8) * range;
    S.monoDeg = between(10, 50);
    S.monoW = Math.max(cellSize, S.monoThrow / (2 * Math.tan(S.monoDeg * deg)));
  }
  // broad anticline or syncline, wavelength 1-3 map widths
  if (rnd() < 0.3) {
    const a = rnd() * 2 * Math.PI, k = 2 * Math.PI / (between(1, 3) * ext);
    S.foldA = (rnd() < 0.5 ? -1 : 1) * between(10, 60) * scale;
    S.foldKx = k * Math.cos(a); S.foldKy = k * Math.sin(a); S.foldPh = rnd() * 2 * Math.PI;
  }

  // top of the stack: the first bed starts at or above the ground everywhere. Depth into the stack
  // at (x, y) is top + structure(x, y) - z; record how deep the deepest ground goes.
  let top = -Infinity;
  const c = (N - 1) * 0.5, step = Math.max(1, N >> 6);
  for (let y = 0; y < N; y += step) for (let x = 0; x < N; x += step) {
    top = Math.max(top, height[y * N + x] - structure(S, (x - c) * cellSize, (y - c) * cellSize));
  }
  top += 4;   // room for the noise warp
  let need = 0;
  for (let y = 0; y < N; y += step) for (let x = 0; x < N; x += step) {
    need = Math.max(need, top + structure(S, (x - c) * cellSize, (y - c) * cellSize) - height[y * N + x]);
  }
  need += 0.25 * range + 50;   // valleys can still cut down a long way
  // tall maps get thicker beds (as in real canyon country), so the stack still fits in MAX_BEDS
  scale = Math.max(scale, need / (MEAN_BED * (MAX_BEDS - 8)));

  // beds, top to bottom: a Markov chain that mostly alternates hard and soft
  const beds = [];
  let depth = 0, hard = rnd() < 0.6;
  while (beds.length < MAX_BEDS - 1 && depth < need) {
    const key = pick(hard ? HARD : SOFT), L = LITHOLOGY[key];
    const thick = Math.max(2 * scale, L.thick * scale * Math.exp(L.sd * gauss()));
    const j = () => Math.exp(0.1 * gauss());
    const col = L.colors[Math.floor(rnd() * L.colors.length)].map((v) => Math.min(1, Math.max(0, v * (1 + 0.06 * gauss()))));
    beds.push({ type: key, name: L.name, hard: L.hard, thick, base: depth + thick,
      erode: L.erode * j(), weather: L.weather * j(), cliffTan: L.cliffTan * j(), color: col });
    depth += thick;
    hard = hard ? rnd() < 0.25 : rnd() < 0.65;
  }
  const B = LITHOLOGY.basement;
  beds.push({ type: 'basement', name: B.name, hard: true, thick: 1e6, base: 1e9, erode: B.erode, weather: B.weather, cliffTan: B.cliffTan, color: B.colors[0] });
  return { top, beds, struct: S, cellSize, N, scale, describe: describe(S, beds) };
}

function describe(S, beds) {
  const dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  // grid +x is east and +y is south (as in column.js), so flip y for the compass
  const compass = (a) => dirs[Math.round(((-a / (2 * Math.PI)) % 1 + 1) % 1 * 8) % 8];
  let s = `${beds.length - 1} beds, dipping ${S.dipDeg.toFixed(1)}° to the ${compass(S.dipAz)}`;
  if (S.monoThrow > 0) s += `; a monocline drops them ${Math.round(S.monoThrow)} m at up to ${Math.round(S.monoDeg)}°`;
  if (S.foldA !== 0) s += `; a broad ${S.foldA > 0 ? 'anticline' : 'syncline'} arches them ${Math.round(Math.abs(S.foldA))} m`;
  return s + '.';
}

// Pack for the GPU: 16 structure floats (see STRATA_PARAM_FIELDS order), the bed table
// (base depth, erode, weather, cliffTan) and the bed colours (sRGB, renderer only).
export function packStrata(T, on) {
  const S = T.struct;
  const head = new Float32Array([
    on ? 1 : 0, T.top, S.dipX, S.dipY,
    S.monoNx, S.monoNy, S.monoC, S.monoThrow,
    S.monoW, S.foldA, S.foldKx, S.foldKy,
    S.foldPh, T.beds.length, T.cellSize, (T.N - 1) * 0.5,
  ]);
  const beds = new Float32Array(MAX_BEDS * 4), colors = new Float32Array(MAX_BEDS * 4);
  for (let k = 0; k < MAX_BEDS; k++) {
    const b = T.beds[Math.min(k, T.beds.length - 1)];
    beds.set([k < T.beds.length ? b.base : 1e9, b.erode, b.weather, b.cliffTan], k * 4);
    colors.set([...b.color, 1], k * 4);
  }
  return { head, beds, colors };
}

// The lookup, written against an accessor so the sim (Params scalars) and the renderer (R vec4s)
// share it. a(i) returns the WGSL expression for structure float i; bed(k) the bed vec4.
export function strataWGSL(a, bed) {
  return /* wgsl */`
fn stHash(p : vec2<f32>) -> f32 {
  let q = fract(p * vec2<f32>(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
fn stNoise(p : vec2<f32>) -> f32 {
  let i = floor(p); let u = fract(p); let s = u * u * (3.0 - 2.0 * u);
  return mix(mix(stHash(i), stHash(i + vec2<f32>(1.0, 0.0)), s.x),
             mix(stHash(i + vec2<f32>(0.0, 1.0)), stHash(i + vec2<f32>(1.0, 1.0)), s.x), s.y);
}
// Depth (m) into the stack at bedrock height z in grid cell g.
fn stDepth(z : f32, g : vec2<f32>) -> f32 {
  let p = (g - ${a(15)}) * ${a(14)};
  var s = -dot(vec2<f32>(${a(2)}, ${a(3)}), p);
  if (${a(7)} > 0.0) {
    let t = clamp((dot(vec2<f32>(${a(4)}, ${a(5)}), p) - ${a(6)}) / ${a(8)}, -10.0, 10.0);
    s -= ${a(7)} * 0.5 * (1.0 + tanh(t));
  }
  s += ${a(9)} * cos(dot(vec2<f32>(${a(10)}, ${a(11)}), p) + ${a(12)});
  let gw = g * (${a(14)} / 10.0);
  let warp = (stNoise(gw * 0.012) - 0.5) * 4.0 + (stNoise(gw * 0.05) - 0.5) * 1.5;
  return ${a(1)} + s + warp - z;
}
// (bed index, metres below the bed's top, metres above its base).
fn stLayer(z : f32, g : vec2<f32>) -> vec3<f32> {
  let d = max(stDepth(z, g), 0.0);
  var k = 0u;
  for (var st = 16u; st > 0u; st = st >> 1u) {
    if (k + st - 1u < ${MAX_BEDS}u && d >= ${bed('k + st - 1u')}.x) { k += st; }
  }
  k = min(k, u32(${a(13)}) - 1u);
  let top = select(0.0, ${bed('max(k, 1u) - 1u')}.x, k > 0u);
  return vec3<f32>(f32(k), d - top, ${bed('k')}.x - d);
}
// (erode multiplier, weather multiplier, cliff tan) with a ~1 m blend across each contact.
fn stProps(z : f32, g : vec2<f32>) -> vec3<f32> {
  let L = stLayer(z, g);
  let k = u32(L.x); let n = u32(${a(13)});
  let p = ${bed('k')}.yzw;
  let pd = ${bed('min(k + 1u, n - 1u)')}.yzw;
  let pu = ${bed('max(k, 1u) - 1u')}.yzw;
  let toDown = 0.5 * (1.0 - smoothstep(0.0, 1.0, L.z));
  let toUp = select(0.0, 0.5 * (1.0 - smoothstep(0.0, 1.0, L.y)), k > 0u);
  return p + (pd - p) * toDown + (pu - p) * toUp;
}
`;
}

// Param names for the 16 structure floats, in packStrata order (sim/params.js).
export const STRATA_PARAM_FIELDS = ['strataOn', 'strataTop', 'stDipX', 'stDipY', 'stMonoNx', 'stMonoNy', 'stMonoC', 'stMonoThrow',
  'stMonoW', 'stFoldA', 'stFoldKx', 'stFoldKy', 'stFoldPh', 'stCount', 'stCell', 'stCenter'];

// CPU mirror of stLayer (bed index only), for tests and probes.
export function strataLayer(z, x, y, T) {
  const hash = (px, py) => {
    let qx = px * 0.1031, qy = py * 0.1030; qx -= Math.floor(qx); qy -= Math.floor(qy);
    const d = qx * (qy + 33.33) + qy * (qx + 33.33);
    const rx = qx + d, ry = qy + d;
    const v = (rx + ry) * rx; return v - Math.floor(v);
  };
  const noise = (px, py) => {
    const ix = Math.floor(px), iy = Math.floor(py), ux = px - ix, uy = py - iy;
    const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
    const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
    const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
  const c = (T.N - 1) * 0.5, f = T.cellSize / 10;
  const gx = x * f, gy = y * f;
  const warp = (noise(gx * 0.012, gy * 0.012) - 0.5) * 4 + (noise(gx * 0.05, gy * 0.05) - 0.5) * 1.5;
  const d = Math.max(0, T.top + structure(T.struct, (x - c) * T.cellSize, (y - c) * T.cellSize) + warp - z);
  let k = 0;
  while (k < T.beds.length - 1 && d >= T.beds[k].base) k++;
  return k;
}
