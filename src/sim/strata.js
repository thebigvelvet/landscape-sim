// Rock layers and geologic provinces. Each landscape gets its own rock, made fresh from its seed in
// the style of one of four provinces:
//
//   Colorado Plateau    flat-lying sandstone, mudstone, shale and limestone, gently tilted, with
//                       monoclines, basement-cored uplifts, laccoliths, salt anticlines, breccia
//                       pipes, joint sets and the odd volcanic neck.
//   Southern Rockies    a crystalline core (granite, gneiss, schist) with a thin cover of sediments
//                       turned up on edge into hogbacks along one flank; dikes, crushed fault zones,
//                       hydrothermally altered rock and hot springs.
//   Valley and Ridge    tight, plunging folds of quartzite, sandstone, limestone, dolomite, shale and
//                       coal, cut by thrust faults; karst with sinkholes and cave springs.
//   Gulf Coastal Plain  young soft sands, clays, marl and chalk dipping gently to the sea, stepped by
//                       growth faults and pushed up by salt domes that dissolve and collapse.
//
// Rock type is worked out from a cell's bedrock elevation and position, so no extra buffer is needed
// and every cut reveals the next bed down. Bed thickness is log-normal per rock type, and hard and
// soft beds mostly alternate. The structure (regional dip, monocline, folds with plunge, faults that
// step the beds, domes that arch them) bends the bed surfaces. On top of the beds sits a table of
// anomalies: dikes, fault zones, altered rock, hot springs, sinkhole seeds, salt bodies, breccia
// pipes, laccolith cores and volcanic necks. They are analytic shapes (a line segment or a point
// with a half-width), so they survive erosion and sculpting exactly.
//
// Every rock sets how fast running water wears it (erode), how fast it breaks down into soil
// (weather), how steep a face it holds (cliffTan), how fast groundwater dissolves it (sol) and how
// easily groundwater moves through it (perm). Hot springs also warm the ground (heat, deg C).
//
// The bed table, structure and anomalies go to the GPU in the params uniform (sim) and the render
// uniform, and the same WGSL lookup is used by both, so the colours drawn are the rocks the erosion
// is working on. Mirrored on the CPU by strataLayer() / anomalyAt() for tests.

export const MAX_BEDS = 32;
export const MAX_FAULTS = 4;
export const MAX_DOMES = 3;
export const MAX_ANOMS = 12;
// Layout of the rock table (vec4 entries) shared by the sim params and the render uniform.
export const TB = {
  beds: 0,            // (base depth m, erode, weather, cliffTan) per bed
  bedsB: 32,          // (soluble, perm, 0, 0) per bed
  faults: 64,         // (nx, ny, c, throw) per fault
  faultW: 68,         // fault widths (m), one per component
  domes: 69,          // 2 per dome: (cx, cy, radius along axis, uplift), (axis x, axis y, radius across, 0)
  anoms: 75,          // 2 per anomaly: (x0, y0, x1, y1) metres, (half-width m, type, strength, top depth)
  plunge: 99,         // fold plunge: (amplitude fraction, kx, ky, phase)
  joints: 100,        // 2 joint sets: (nx, ny, spacing m, strength)
  base: 102,          // 3 crystalline basement rocks: (erode, weather, cliffTan, perm)
  baseCol: 105,       // their colours (renderer)
  misc: 108,          // (faults, domes, anomalies, crystalline mosaic on)
};
export const TABLE_LEN = 109;

// Anomaly type codes (table and WGSL)
export const ANOM = { dike: 1, fault: 2, alteration: 3, hotSpring: 4, sinkhole: 5, salt: 6, pipe: 7, laccolith: 8, neck: 9 };
// Rock of the anomaly bodies: (erode, weather, cliffTan)
const DIKE = [0.12, 0.3, 6.0], PORPHYRY = [0.15, 0.3, 5.5], CAPROCK = [0.3, 0.45, 3.5], SALT = [4.0, 4.0, 0.8], NECK = [0.1, 0.25, 6.0];
// Anomaly colours by colour id (renderer, sRGB): 1 dike, 2 fault gouge, 3 altered rock, 4 travertine,
// 6 caprock, 7 salt, 8 breccia, 9 porphyry, 10 neck, 11 joint shadow
export const ANOM_COLORS = {
  1: [0.16, 0.18, 0.16], 2: [0.50, 0.40, 0.40], 3: [0.86, 0.62, 0.20], 4: [0.93, 0.90, 0.80],
  6: [0.78, 0.76, 0.70], 7: [0.95, 0.92, 0.92], 8: [0.45, 0.42, 0.36], 9: [0.62, 0.56, 0.56],
  10: [0.22, 0.21, 0.22], 11: [0.25, 0.20, 0.17],
};

// Rock types. thick: median bed thickness (m) at scale 1, sd: log-normal spread. sol: dissolution
// rate multiplier (0 insoluble, 1 limestone, 5 gypsum, 30 salt). perm: groundwater conductivity
// multiplier (1 = the plain shallow ground).
export const LITHOLOGY = {
  // Colorado Plateau
  eolian: { name: 'Eolian sandstone', hard: true, thick: 45, sd: 0.55, erode: 0.22, weather: 0.3, cliffTan: 4.5, sol: 0, perm: 2,
    colors: [[0.90, 0.72, 0.52], [0.94, 0.84, 0.68], [0.86, 0.58, 0.40]] },
  massiveSand: { name: 'Fluvial sandstone', hard: true, thick: 22, sd: 0.6, erode: 0.28, weather: 0.35, cliffTan: 3.8, sol: 0, perm: 1.5,
    colors: [[0.84, 0.52, 0.32], [0.78, 0.44, 0.28], [0.80, 0.62, 0.46]] },
  thinSand: { name: 'Ledgy sandstone', hard: true, thick: 8, sd: 0.5, erode: 0.6, weather: 0.7, cliffTan: 2.4, sol: 0, perm: 1.2,
    colors: [[0.78, 0.60, 0.45], [0.74, 0.52, 0.40]] },
  conglomerate: { name: 'Conglomerate', hard: true, thick: 6, sd: 0.5, erode: 0.3, weather: 0.4, cliffTan: 3.5, sol: 0, perm: 1.5,
    colors: [[0.66, 0.60, 0.52], [0.70, 0.62, 0.50]] },
  limestone: { name: 'Limestone', hard: true, thick: 8, sd: 0.5, erode: 0.4, weather: 0.5, cliffTan: 3.0, sol: 1, perm: 30,
    colors: [[0.80, 0.78, 0.72], [0.74, 0.72, 0.66]] },
  mudstone: { name: 'Bentonitic mudstone', hard: false, thick: 25, sd: 0.6, erode: 3.5, weather: 3.5, cliffTan: 0.7, sol: 0, perm: 0.3,
    colors: [[0.58, 0.46, 0.58], [0.60, 0.66, 0.58], [0.66, 0.40, 0.38], [0.72, 0.68, 0.62]] },
  redShale: { name: 'Red shale', hard: false, thick: 18, sd: 0.6, erode: 3.0, weather: 2.5, cliffTan: 0.9, sol: 0, perm: 0.4,
    colors: [[0.62, 0.30, 0.22], [0.58, 0.34, 0.30], [0.66, 0.38, 0.26]] },
  grayShale: { name: 'Marine gray shale', hard: false, thick: 30, sd: 0.6, erode: 3.2, weather: 2.6, cliffTan: 0.85, sol: 0, perm: 0.3,
    colors: [[0.56, 0.55, 0.50], [0.50, 0.50, 0.48], [0.60, 0.56, 0.46]] },
  siltstone: { name: 'Siltstone', hard: false, thick: 10, sd: 0.5, erode: 1.6, weather: 1.5, cliffTan: 1.4, sol: 0, perm: 0.6,
    colors: [[0.70, 0.45, 0.35], [0.66, 0.50, 0.40]] },
  gypsum: { name: 'Gypsum', hard: false, thick: 6, sd: 0.5, erode: 2.0, weather: 2.0, cliffTan: 1.2, sol: 5, perm: 5,
    colors: [[0.90, 0.88, 0.84], [0.84, 0.82, 0.78]] },
  // Southern Rockies cover
  arkose: { name: 'Arkose', hard: true, thick: 20, sd: 0.55, erode: 0.3, weather: 0.45, cliffTan: 3.6, sol: 0, perm: 1.5,
    colors: [[0.72, 0.36, 0.26], [0.78, 0.44, 0.32]] },
  // Valley and Ridge
  quartzite: { name: 'Quartzite', hard: true, thick: 15, sd: 0.5, erode: 0.12, weather: 0.2, cliffTan: 5.0, sol: 0, perm: 1,
    colors: [[0.86, 0.84, 0.78], [0.80, 0.76, 0.68]] },
  dolomite: { name: 'Dolomite', hard: true, thick: 12, sd: 0.5, erode: 0.35, weather: 0.45, cliffTan: 3.2, sol: 0.6, perm: 15,
    colors: [[0.74, 0.70, 0.62], [0.70, 0.66, 0.60]] },
  coal: { name: 'Coal seam', hard: false, thick: 1.5, sd: 0.4, erode: 2.5, weather: 2.0, cliffTan: 1.0, sol: 0, perm: 2,
    colors: [[0.10, 0.10, 0.10]] },
  // Gulf Coastal Plain
  sand: { name: 'Loose sand', hard: false, thick: 12, sd: 0.6, erode: 4.0, weather: 3.0, cliffTan: 0.6, sol: 0, perm: 4,
    colors: [[0.86, 0.78, 0.60], [0.80, 0.70, 0.52]] },
  clay: { name: 'Clay', hard: false, thick: 15, sd: 0.6, erode: 3.0, weather: 2.5, cliffTan: 0.8, sol: 0, perm: 0.3,
    colors: [[0.56, 0.58, 0.54], [0.62, 0.52, 0.44]] },
  marl: { name: 'Marl', hard: false, thick: 8, sd: 0.5, erode: 2.0, weather: 1.8, cliffTan: 1.0, sol: 0.5, perm: 0.6,
    colors: [[0.74, 0.72, 0.62]] },
  chalk: { name: 'Chalk', hard: true, thick: 10, sd: 0.5, erode: 1.0, weather: 1.2, cliffTan: 2.0, sol: 1, perm: 8,
    colors: [[0.90, 0.90, 0.84]] },
  ironstone: { name: 'Ironstone ledge', hard: true, thick: 2, sd: 0.4, erode: 0.5, weather: 0.6, cliffTan: 2.5, sol: 0, perm: 1,
    colors: [[0.50, 0.28, 0.16]] },
  // the floor of every stack
  basement: { name: 'Crystalline basement', hard: true, thick: 1e6, sd: 0, erode: 0.2, weather: 0.25, cliffTan: 4.0, sol: 0, perm: 0.5,
    colors: [[0.45, 0.38, 0.36]] },
};
// The Southern Rockies' crystalline core, a patchwork of three rocks (TB.base)
export const CRYSTALLINE = [
  { name: 'Granite', erode: 0.18, weather: 0.3, cliffTan: 5.0, perm: 0.5, color: [0.78, 0.66, 0.62] },
  { name: 'Gneiss', erode: 0.22, weather: 0.3, cliffTan: 4.2, perm: 0.5, color: [0.52, 0.48, 0.46] },
  { name: 'Schist', erode: 0.5, weather: 0.6, cliffTan: 2.6, perm: 0.7, color: [0.42, 0.44, 0.40] },
];
// Volcanic rock (sim/volcano.js), keyed by the type code kept in world.volcRock. These sit on top of
// the plateau stack wherever a volcano has built them, so they are looked up per cell, not by depth.
//   Basalt: runny lava that set hard. Columnar joints hold sheer cliffs, and it shrugs off water,
//           so old flows end up as caps on mesas and ridges (inverted topography).
//   Cinders: loose, frothy scoria thrown out of the vent. Piles at ~32 deg and washes away easily.
//   Plug: lava that set in the volcano's throat. Hardest of all; outlasts the cone as a neck.
export const VOLCANIC = {
  1: { key: 'basalt', name: 'Basalt lava', erode: 0.15, weather: 0.35, cliffTan: 4.5,
    fresh: [0.10, 0.10, 0.11], old: [0.30, 0.25, 0.23] },
  2: { key: 'cinders', name: 'Cinders (scoria)', erode: 3.5, weather: 2.2, cliffTan: 0.62,
    fresh: [0.30, 0.12, 0.09], old: [0.52, 0.26, 0.18] },
  3: { key: 'plug', name: 'Volcanic plug', erode: 0.1, weather: 0.25, cliffTan: 6.0,
    fresh: [0.17, 0.16, 0.17], old: [0.27, 0.25, 0.25] },
};

// ---- provinces ----
// relief: multiplier on the terrain relief at load (the Gulf plain is low). heatFlow: regional
// background (mW/m2) for the description. hard/soft(f): weighted rock lists at depth fraction f.
export const PROVINCES = {
  plateau: {
    name: 'Colorado Plateau', relief: 1, heatFlow: 60, meanBed: 20,
    blurb: 'flat-lying sandstone, mudstone and limestone',
    hard: (f) => [['eolian', f < 0.75 ? 0.38 : 0.1], ['massiveSand', 0.22], ['thinSand', 0.18], ['conglomerate', 0.06], ['limestone', 0.06 + 0.4 * f]],
    soft: (f) => [['mudstone', 0.28], ['redShale', 0.24], ['grayShale', 0.3 * (1 - f)], ['siltstone', 0.18], ['gypsum', f > 0.55 ? 0.6 * (f - 0.55) : 0]],
    startHard: 0.6, hardHard: 0.25, softHard: 0.65,
  },
  rockies: {
    name: 'Southern Rockies', relief: 1, heatFlow: 90, meanBed: 15,
    blurb: 'a granite, gneiss and schist core with sediments turned up on one flank',
    hard: () => [['arkose', 0.4], ['massiveSand', 0.3], ['limestone', 0.3]],
    soft: () => [['redShale', 0.45], ['grayShale', 0.35], ['siltstone', 0.2]],
    startHard: 0.5, hardHard: 0.2, softHard: 0.7,
  },
  valleyRidge: {
    name: 'Valley and Ridge', relief: 1, heatFlow: 50, meanBed: 15,
    blurb: 'tightly folded quartzite, limestone, dolomite, shale and coal',
    hard: () => [['quartzite', 0.35], ['thinSand', 0.25], ['limestone', 0.25], ['dolomite', 0.15]],
    soft: () => [['grayShale', 0.5], ['redShale', 0.25], ['siltstone', 0.17], ['coal', 0.08]],
    startHard: 0.5, hardHard: 0.3, softHard: 0.6,
  },
  gulf: {
    name: 'Gulf Coastal Plain', relief: 0.3, heatFlow: 45, meanBed: 12,
    blurb: 'young, soft sand, clay, marl and chalk dipping gently to the sea',
    hard: () => [['chalk', 0.6], ['ironstone', 0.4]],
    soft: () => [['sand', 0.45], ['clay', 0.4], ['marl', 0.15]],
    startHard: 0.15, hardHard: 0.1, softHard: 0.2,
  },
};
export const PROVINCE_KEYS = Object.keys(PROVINCES);
// 'random' (or anything unknown) picks a province from the seed
export function resolveProvince(p, seed) {
  if (PROVINCES[p]) return p;
  return PROVINCE_KEYS[(Math.imul((seed | 0) + 7, 2654435761) >>> 0) % PROVINCE_KEYS.length];
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Structure offset (m) of the bed surfaces at map position (px, py) in metres from the centre:
// regional dip, monocline step, fold (with plunge), fault steps and domes. The noise warp is added
// separately. Mirrors stStruct in strataWGSL.
function structure(S, px, py) {
  let z = -(S.dipX * px + S.dipY * py);
  if (S.monoThrow > 0) {
    const s = Math.max(-10, Math.min(10, (S.monoNx * px + S.monoNy * py - S.monoC) / S.monoW));
    z -= S.monoThrow * 0.5 * (1 + Math.tanh(s));
  }
  if (S.foldA !== 0) {
    const pl = S.plunge;
    z += S.foldA * (1 + pl.A * Math.cos(pl.kx * px + pl.ky * py + pl.ph)) * Math.cos(S.foldKx * px + S.foldKy * py + S.foldPh);
  }
  for (const f of S.faults) {
    const t = Math.max(-10, Math.min(10, (f.nx * px + f.ny * py - f.c) / f.w));
    z -= f.throw * 0.5 * (1 + Math.tanh(t));
  }
  for (const d of S.domes) {
    const qx = px - d.cx, qy = py - d.cy;
    const u = (qx * d.ax + qy * d.ay) / d.ra, v = (d.ax * qy - d.ay * qx) / d.rb;
    z += d.U * Math.exp(-(u * u + v * v));
  }
  return z;
}

// Make the rock for one landscape. height: starting terrain (m), N x N cells of cellSize m.
export function makeStrata(seed, height, N, cellSize, scale = 1, province = 'plateau') {
  const prov = resolveProvince(province, seed), PV = PROVINCES[prov];
  const rnd = mulberry32((seed | 0) * 48271 + 911 + 7919 * PROVINCE_KEYS.indexOf(prov));
  const between = (a, b) => a + (b - a) * rnd();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const pick = (list) => {
    const tot = list.reduce((s, e) => s + e[1], 0);
    let r = rnd() * tot, k = 0;
    while (k < list.length - 1 && (r -= list[k][1]) > 0) k++;
    return list[k][0];
  };
  const ext = N * cellSize, c = (N - 1) * 0.5;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N * N; i++) { if (height[i] < mn) mn = height[i]; if (height[i] > mx) mx = height[i]; }
  const range = Math.max(20, mx - mn);
  const deg = Math.PI / 180;
  const hAt = (px, py) => {
    const x = Math.max(0, Math.min(N - 1, Math.round(px / cellSize + c))), y = Math.max(0, Math.min(N - 1, Math.round(py / cellSize + c)));
    return height[y * N + x];
  };
  const inMap = (px, py) => Math.abs(px) < 0.5 * ext && Math.abs(py) < 0.5 * ext;

  // ---- structure ----
  const S = { dipDeg: 0, dipAz: 0, dipX: 0, dipY: 0, monoThrow: 0, monoNx: 1, monoNy: 0, monoC: 0, monoW: 1, monoDeg: 0,
    foldA: 0, foldKx: 0, foldKy: 0, foldPh: 0, foldWave: 0, plunge: { A: 0, kx: 0, ky: 0, ph: 0 },
    faults: [], domes: [], joints: [], mosaic: false };
  const setDip = (lo, hi) => {
    const dip = Math.exp(between(Math.log(lo), Math.log(hi))), az = rnd() * 2 * Math.PI;
    Object.assign(S, { dipDeg: dip, dipAz: az, dipX: Math.tan(dip * deg) * Math.cos(az), dipY: Math.tan(dip * deg) * Math.sin(az) });
  };
  const monocline = (a, cFrac, thr, dMin, dMax) => {
    S.monoNx = Math.cos(a); S.monoNy = Math.sin(a);
    S.monoC = cFrac * ext; S.monoThrow = thr; S.monoDeg = between(dMin, dMax);
    S.monoW = Math.max(cellSize, S.monoThrow / (2 * Math.tan(S.monoDeg * deg)));
  };
  const fault = (a, cOff, thr, w, kind) => S.faults.length < MAX_FAULTS &&
    S.faults.push({ nx: Math.cos(a), ny: Math.sin(a), c: cOff, throw: thr, w: Math.max(0.5 * cellSize, w), kind });
  const dome = (cx, cy, ra, rb, axAng, U, kind) => S.domes.length < MAX_DOMES &&
    S.domes.push({ cx, cy, ra, rb, ax: Math.cos(axAng), ay: Math.sin(axAng), U, kind });
  let coverNeed = 0;

  if (prov === 'plateau') {
    setDip(0.3, 4);
    if (rnd() < 0.35) monocline(S.dipAz + between(-0.35, 0.35), between(-0.3, 0.3), between(0.3, 0.8) * range, 10, 50);
    if (rnd() < 0.3) {
      const a = rnd() * 2 * Math.PI, k = 2 * Math.PI / (between(1, 3) * ext);
      S.foldA = (rnd() < 0.5 ? -1 : 1) * between(10, 60) * scale;
      S.foldKx = k * Math.cos(a); S.foldKy = k * Math.sin(a); S.foldPh = rnd() * 2 * Math.PI;
    }
    // basement-cored uplift (San Rafael Swell / Kaibab style): a broad, elongated dome
    if (rnd() < 0.2) dome(between(-0.3, 0.3) * ext, between(-0.3, 0.3) * ext, between(0.3, 0.55) * ext, between(0.15, 0.3) * ext, rnd() * Math.PI, between(0.3, 0.7) * range, 'uplift');
    // Moab-fault style normal fault
    if (rnd() < 0.25) fault(rnd() * 2 * Math.PI, between(-0.3, 0.3) * ext, between(0.1, 0.35) * range, 1.2 * cellSize, 'normal');
    // laccolith: beds domed over an igneous core
    if (rnd() < 0.25) { const r = between(0.06, 0.12) * ext; dome(between(-0.3, 0.3) * ext, between(-0.3, 0.3) * ext, r, r * between(0.8, 1.2), rnd() * Math.PI, between(0.4, 0.8) * range, 'laccolith'); }
    // salt anticline: a long, narrow arch over a salt wall
    if (rnd() < 0.2) dome(between(-0.2, 0.2) * ext, between(-0.2, 0.2) * ext, between(0.3, 0.5) * ext, between(0.05, 0.09) * ext, rnd() * Math.PI, between(0.15, 0.3) * range, 'saltAnticline');
    // joints: two fracture families that open the massive sandstones into fins
    if (rnd() < 0.6) {
      const a = rnd() * Math.PI, sp = Math.max(3 * cellSize, between(30, 90));
      S.joints.push({ nx: Math.cos(a), ny: Math.sin(a), spacing: sp, strength: between(0.6, 1) });
      const b = a + between(60, 90) * deg;
      S.joints.push({ nx: Math.cos(b), ny: Math.sin(b), spacing: sp * between(1, 2), strength: between(0.4, 0.8) });
    }
  } else if (prov === 'rockies') {
    setDip(0.5, 3);
    S.mosaic = true;
    // the thin sedimentary cover survives only on the down-dropped flank, bent up into hogbacks
    coverNeed = (between(0.25, 0.5) * range + 60) * scale;
    monocline(rnd() * 2 * Math.PI, between(0.1, 0.3), 1.1 * range + coverNeed, 40, 80);
    for (let n = 1 + Math.floor(rnd() * 3), k = 0; k < n; k++) {
      fault(rnd() * 2 * Math.PI, between(-0.35, 0.35) * ext, between(0.02, 0.1) * range, cellSize, 'fault');
    }
  } else if (prov === 'valleyRidge') {
    setDip(0.3, 2);
    const a = rnd() * 2 * Math.PI, wave = between(0.22, 0.4) * ext, k = 2 * Math.PI / wave;
    S.foldA = (between(0.8, 1.6) * range + 40) * (rnd() < 0.5 ? -1 : 1);
    S.foldKx = k * Math.cos(a); S.foldKy = k * Math.sin(a); S.foldPh = rnd() * 2 * Math.PI; S.foldWave = wave;
    const k2 = 2 * Math.PI / (between(1.2, 2.5) * ext);
    S.plunge = { A: between(0.25, 0.6), kx: -k2 * Math.sin(a), ky: k2 * Math.cos(a), ph: rnd() * 2 * Math.PI };
    for (let n = 1 + (rnd() < 0.5 ? 1 : 0), j = 0; j < n; j++) {
      fault(a + (rnd() < 0.5 ? 0 : Math.PI), between(-0.35, 0.35) * ext, between(0.3, 0.7) * Math.abs(S.foldA), 1.5 * cellSize, 'thrust');
    }
  } else {   // gulf
    setDip(0.05, 0.5);
    const dx = Math.cos(S.dipAz), dy = Math.sin(S.dipAz);
    for (let n = 1 + Math.floor(rnd() * 3), j = 0; j < n; j++) {
      fault(S.dipAz + between(-0.25, 0.25), between(-0.4, 0.4) * ext, between(0.1, 0.3) * range + 3, 2 * cellSize, 'growth');
    }
    for (let n = 1 + Math.floor(rnd() * 3), j = 0; j < n; j++) {
      const r = between(0.05, 0.1) * ext;
      dome(between(-0.35, 0.35) * ext, between(-0.35, 0.35) * ext, r, r, 0, between(0.3, 0.8) * range + 10, 'saltDome');
    }
    void dx; void dy;
  }

  // ---- top of the stack: the first bed starts at or above the ground everywhere. Depth into the
  // stack at (x, y) is top + structure(x, y) - z; record how deep the deepest ground goes.
  let top = -Infinity;
  const step = Math.max(1, N >> 6);
  for (let y = 0; y < N; y += step) for (let x = 0; x < N; x += step) {
    top = Math.max(top, height[y * N + x] - structure(S, (x - c) * cellSize, (y - c) * cellSize));
  }
  top += 4;   // room for the noise warp
  let need = 0;
  for (let y = 0; y < N; y += step) for (let x = 0; x < N; x += step) {
    need = Math.max(need, top + structure(S, (x - c) * cellSize, (y - c) * cellSize) - height[y * N + x]);
  }
  need += 0.25 * range + 50;   // valleys can still cut down a long way
  if (prov === 'rockies') need = coverNeed;
  // tall maps get thicker beds (as in real canyon country), so the stack still fits in MAX_BEDS
  scale = Math.max(scale, need / (PV.meanBed * (MAX_BEDS - 8)));
  const depthAt = (px, py) => top + structure(S, px, py) - hAt(px, py);

  // ---- beds, top to bottom: a Markov chain that mostly alternates hard and soft ----
  const beds = [];
  let depth = 0, hard = rnd() < PV.startHard, prev = '';
  while (beds.length < MAX_BEDS - 1 && depth < need) {
    const f = Math.min(1, depth / need);
    let list = hard ? PV.hard(f) : PV.soft(f);
    // plateau habit: a thick dune sandstone sits on soft red or purple mudstone, so cliffs stand over slopes
    if (!hard && prev === 'eolian') list = [['mudstone', 0.5], ['redShale', 0.4], ['siltstone', 0.1]];
    const key = pick(list), L = LITHOLOGY[key];
    const thick = Math.max(key === 'coal' ? 1 : 2 * scale, L.thick * (key === 'coal' ? 1 : scale) * Math.exp(L.sd * gauss()));
    const j = () => Math.exp(0.1 * gauss());
    const col = L.colors[Math.floor(rnd() * L.colors.length)].map((v) => Math.min(1, Math.max(0, v * (1 + 0.06 * gauss()))));
    beds.push({ type: key, name: L.name, hard: L.hard, thick, base: depth + thick,
      erode: L.erode * j(), weather: L.weather * j(), cliffTan: L.cliffTan * j(), sol: L.sol, perm: L.perm, color: col });
    depth += thick;
    prev = key;
    if (key === 'eolian') hard = rnd() < 0.15;
    else hard = hard ? rnd() < PV.hardHard : rnd() < PV.softHard;
  }
  const B = LITHOLOGY.basement;
  beds.push({ type: 'basement', name: prov === 'rockies' ? 'Granite, gneiss and schist' : B.name, hard: true, thick: 1e6, base: 1e9,
    erode: B.erode, weather: B.weather, cliffTan: B.cliffTan, sol: 0, perm: B.perm, color: B.colors[0] });
  const T = { province: prov, top, beds, struct: S, cellSize, N, scale, anoms: [] };

  // ---- anomalies ----
  const A = T.anoms;
  const add = (o) => { if (A.length < MAX_ANOMS) { A.push(o); return true; } return false; };
  const minW = 0.8 * cellSize;
  const seg = (px, py, ang, len) => [px - 0.5 * len * Math.cos(ang), py - 0.5 * len * Math.sin(ang), px + 0.5 * len * Math.cos(ang), py + 0.5 * len * Math.sin(ang)];
  // a fault trace as a long segment across the map (the damage zone follows the step)
  const faultSeg = (f) => { const px = f.nx * f.c, py = f.ny * f.c; return seg(px, py, Math.atan2(f.ny, f.nx) + Math.PI / 2, 2 * ext); };
  // lowest ground along a segment (where a spring will come out)
  const lowOn = (s) => {
    let best = null;
    for (let k = 0; k <= 60; k++) {
      const t = k / 60, px = s[0] + (s[2] - s[0]) * t, py = s[1] + (s[3] - s[1]) * t;
      if (!inMap(0.9 * px, 0.9 * py)) continue;
      const h = hAt(px, py);
      if (!best || h < best.h) best = { px, py, h };
    }
    return best;
  };
  const point = () => [between(-0.4, 0.4) * ext, between(-0.4, 0.4) * ext];

  // structural features that carry a body or damage zone
  for (const f of S.faults) {
    add({ type: 'fault', seg: faultSeg(f), hw: Math.max(minW, prov === 'rockies' ? between(15, 35) : between(8, 20)), strength: 1, dTop: 0, kind: f.kind });
  }
  for (const d of S.domes) {
    if (d.kind === 'laccolith') {
      const below = between(-15, 25);   // some cores are already bare, as in the Henry Mountains
      add({ type: 'laccolith', seg: [d.cx, d.cy, d.cx, d.cy], hw: 0.55 * Math.min(d.ra, d.rb), strength: 1, dTop: depthAt(d.cx, d.cy) + below, below });
    } else if (d.kind === 'saltAnticline') {
      const s = seg(d.cx, d.cy, Math.atan2(d.ay, d.ax), 1.6 * d.ra);
      let d0 = Infinity;
      for (let k = 0; k <= 20; k++) { const t = k / 20; d0 = Math.min(d0, depthAt(s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t)); }
      const below = between(5, 40) * scale;
      add({ type: 'salt', seg: s, hw: 0.45 * d.rb, strength: between(2, 5) * scale, dTop: Math.max(0, d0) + below, below, kind: 'wall' });
    } else if (d.kind === 'saltDome') {
      const below = between(2, 10) * scale;
      add({ type: 'salt', seg: [d.cx, d.cy, d.cx, d.cy], hw: between(0.4, 0.6) * d.ra, strength: between(2, 6) * scale,
        dTop: Math.max(0, depthAt(d.cx, d.cy)) + below, below, kind: 'dome' });
    }
  }
  if (prov === 'plateau') {
    if (rnd() < 0.15) {   // volcanic neck (diatreme) with radiating dikes, Shiprock style
      const [px, py] = point();
      add({ type: 'neck', seg: [px, py, px, py], hw: Math.max(minW, between(20, 45)), strength: 1, dTop: 0 });
      for (let n = 2 + Math.floor(rnd() * 2), k = 0; k < n; k++) {
        const a = rnd() * 2 * Math.PI, len = between(0.08, 0.25) * ext;
        add({ type: 'dike', seg: [px, py, px + len * Math.cos(a), py + len * Math.sin(a)], hw: Math.max(minW, between(4, 8)), strength: 1, dTop: 0 });
      }
    }
    if (rnd() < 0.4) {    // breccia pipes: collapse columns of broken rock
      for (let n = 2 + Math.floor(rnd() * 4), k = 0; k < n; k++) {
        const [px, py] = point();
        if (!add({ type: 'pipe', seg: [px, py, px, py], hw: Math.max(1.2 * cellSize, between(12, 30)), strength: 1, dTop: 0 })) break;
      }
    }
  } else if (prov === 'rockies') {
    for (let n = 1 + Math.floor(rnd() * 4), k = 0; k < n; k++) {
      const [px, py] = point();
      add({ type: 'dike', seg: seg(px, py, rnd() * Math.PI, between(0.4, 1.0) * ext), hw: Math.max(minW, between(4, 10)), strength: 1, dTop: 0 });
    }
    if (rnd() < 0.5) { const [px, py] = point(); add({ type: 'alteration', seg: [px, py, px, py], hw: between(0.05, 0.1) * ext, strength: 1, dTop: 0 }); }
    if (rnd() < 0.6 && S.faults.length) {
      const lo = lowOn(faultSeg(S.faults[0]));
      if (lo) add({ type: 'hotSpring', seg: [lo.px, lo.py, lo.px, lo.py], hw: Math.max(1.5 * cellSize, between(15, 30)), strength: between(15, 30), dTop: 0 });
    }
  } else if (prov === 'valleyRidge') {
    if (rnd() < 0.25 && S.faults.length) {   // warm springs on a thrust (Warm Springs, Virginia style)
      const lo = lowOn(faultSeg(S.faults[0]));
      if (lo) add({ type: 'hotSpring', seg: [lo.px, lo.py, lo.px, lo.py], hw: Math.max(1.5 * cellSize, between(15, 30)), strength: between(8, 15), dTop: 0 });
    }
    // sinkhole seeds where limestone or dolomite is at (or just under) the surface, on gentle
    // high ground (dolines pock the uplands; in valley floors streams and sediment would bury them)
    let want = 3 + Math.floor(rnd() * 6), tries = 0;
    const R8 = Math.max(4, Math.round(120 / cellSize));
    while (want > 0 && tries++ < 800) {
      const x = Math.floor(between(0.08, 0.92) * N), y = Math.floor(between(0.08, 0.92) * N);
      const b = beds[strataLayer(height[y * N + x] - 2, x, y, T)];
      if (!b || b.sol <= 0) continue;
      let sum = 0, n = 0;
      for (let oy = -R8; oy <= R8; oy += 2) for (let ox = -R8; ox <= R8; ox += 2) {
        const xx = Math.max(0, Math.min(N - 1, x + ox)), yy = Math.max(0, Math.min(N - 1, y + oy)); sum += height[yy * N + xx]; n++;
      }
      const sl = Math.hypot(height[y * N + Math.min(N - 1, x + 1)] - height[y * N + Math.max(0, x - 1)], height[Math.min(N - 1, y + 1) * N + x] - height[Math.max(0, y - 1) * N + x]) / (2 * cellSize);
      if (height[y * N + x] < sum / n - 0.03 * range || sl > 0.6) continue;
      const px = (x - c) * cellSize, py = (y - c) * cellSize;
      if (!add({ type: 'sinkhole', seg: [px, py, px, py], hw: Math.max(2 * cellSize, between(20, 50)), strength: 60, dTop: 0 })) break;
      want--;
    }
  }
  T.describe = describe(T, PV, range);
  T.notes = notes(T, PV);
  return T;
}

const DIRS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
// grid +x is east and +y is south (as in column.js), so flip y for the compass
const compass = (a) => DIRS[Math.round(((-a / (2 * Math.PI)) % 1 + 1) % 1 * 8) % 8];
const trend = (s) => { const a = Math.atan2(s[3] - s[1], s[2] - s[0]); const t = ['E-W', 'NE-SW', 'N-S', 'NW-SE']; return t[Math.round(((-a / Math.PI) % 1 + 1) % 1 * 4) % 4]; };
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

function describe(T, PV, range) {
  const S = T.struct, beds = T.beds;
  let s = `${PV.name}: ${beds.length - 1} beds, dipping ${S.dipDeg.toFixed(S.dipDeg < 1 ? 2 : 1)}° to the ${compass(S.dipAz)}`;
  if (T.province === 'rockies') s = `${PV.name}: a granite, gneiss and schist core under ${beds.length - 1} beds of cover, turned up into hogbacks along the ${compass(Math.atan2(S.monoNy, S.monoNx))} flank`;
  else if (S.monoThrow > 0) s += `; a monocline drops them ${Math.round(S.monoThrow)} m at up to ${Math.round(S.monoDeg)}°`;
  if (T.province === 'valleyRidge') s += `; tight folds every ${km(S.foldWave)}, ${Math.round(Math.abs(S.foldA))} m high, plunging along their axes`;
  else if (S.foldA !== 0) s += `; a broad ${S.foldA > 0 ? 'anticline' : 'syncline'} arches them ${Math.round(Math.abs(S.foldA))} m`;
  const up = S.domes.find((d) => d.kind === 'uplift');
  if (up) s += `; a basement-cored uplift raises them ${Math.round(up.U)} m`;
  void range;
  return s + '.';
}

// One line per anomaly: what it is, what it does in the sim, and its geophysical signature.
function notes(T, PV) {
  const out = [`Regional heat flow ~${PV.heatFlow} mW/m²${T.province === 'rockies' ? '; Bouguer gravity low under the range (thick, light crust)' : T.province === 'gulf' ? '; kilometres of light sediment and salt below' : ''}.`];
  const S = T.struct;
  for (const f of S.faults) {
    const t = trend([0, 0, -f.ny, f.nx]);
    if (f.kind === 'thrust') out.push(`An ${t} thrust fault stacks the beds ${Math.round(f.throw)} m: its crushed zone wears into a gully and leaks groundwater. Seismic: repeated reflectors.`);
    else if (f.kind === 'growth') out.push(`An ${t} growth fault steps the beds down ${Math.round(f.throw)} m toward the sea; water seeps along it. Seismic: thickening beds on the down side.`);
    else if (f.kind === 'normal') out.push(`An ${t} normal fault drops the beds ${Math.round(f.throw)} m; its crushed zone leaks groundwater. Gravity step across it.`);
    else out.push(`An ${t} fault zone of crushed rock wears into a gully and carries groundwater to springs. Resistivity and gravity low.`);
  }
  for (const d of S.domes) {
    if (d.kind === 'laccolith') { const a = T.anoms.find((x) => x.type === 'laccolith'); out.push(`A laccolith ${km(2 * d.ra)} across: beds domed ${Math.round(d.U)} m over a hard porphyry core${a ? (a.below > 0 ? ` about ${Math.round(a.below)} m down` : ' already laid bare at the summit') : ''}. Magnetic high.`); }
    if (d.kind === 'saltAnticline') { const a = T.anoms.find((x) => x.kind === 'wall'); out.push(`A salt anticline: salt${a ? ` about ${Math.round(a.below)} m down` : ' at depth'}. Once erosion reaches it, groundwater dissolves it and the crest collapses into a long valley. Gravity low.`); }
    if (d.kind === 'saltDome') { const a = T.anoms.find((x) => x.kind === 'dome' && Math.abs(x.seg[0] - d.cx) < 1); out.push(`A salt dome ${km(2 * d.ra)} across, beds ringing it: caprock${a ? ` about ${Math.round(a.below)} m down` : ''}, then salt that dissolves so the ground sinks into a hollow or lake. Strong gravity low; sulfur in the caprock.`); }
  }
  const count = (t) => T.anoms.filter((a) => a.type === t);
  const dikes = count('dike'), pipes = count('pipe'), sinks = count('sinkhole');
  if (count('neck').length) out.push(`A volcanic neck with ${dikes.length} radiating dike${dikes.length === 1 ? '' : 's'}: hard dark rock that stands up as walls. Magnetic high.`);
  else if (dikes.length) out.push(`${dikes.length === 1 ? 'A dike' : `${dikes.length} dikes`} (${dikes.map((d) => trend(d.seg)).join(', ')}): hard dark sheets that stand up as walls and dam groundwater. Magnetic highs.`);
  for (const a of count('alteration')) out.push(`A hydrothermally altered zone ${km(2 * a.hw)} across: soft ochre rock that weathers fast (mineral-belt style). Magnetic low.`);
  for (const a of count('hotSpring')) out.push(`A hot spring on the fault: +${Math.round(a.strength)}°C at the vent, heat flow ~${Math.round(PV.heatFlow + 15 * a.strength)} mW/m². It melts the snow and keeps the ground unfrozen.`);
  if (sinks.length) out.push(`${sinks.length} sinkhole seeds in the limestone: they dissolve into closed hollows, and streams on bare limestone sink into the ground and come out as cave springs. Microgravity lows over voids.`);
  if (pipes.length) out.push(`${pipes.length} breccia pipes: collapse columns of broken rock that leak groundwater and wear into hollows. Radiometric (uranium) highs.`);
  if (S.joints.length) out.push(`Two joint sets about ${Math.round(S.joints[0].spacing)} m apart: the massive sandstones split along them into fins and slots.`);
  const sol = T.beds.filter((b) => b.sol > 0).length;
  if (sol && !sinks.length) out.push(`${sol} soluble bed${sol === 1 ? '' : 's'} (limestone, gypsum, chalk): where exposed, streams lose water into the ground and the rock slowly dissolves.`);
  return out;
}

// Pack for the GPU: 16 structure floats (see STRATA_PARAM_FIELDS order), the rock table (TB layout)
// and the bed colours (sRGB, renderer only).
export function packStrata(T, on) {
  const S = T.struct;
  const head = new Float32Array([
    on ? 1 : 0, T.top, S.dipX, S.dipY,
    S.monoNx, S.monoNy, S.monoC, S.monoThrow,
    S.monoW, S.foldA, S.foldKx, S.foldKy,
    S.foldPh, T.beds.length, T.cellSize, (T.N - 1) * 0.5,
  ]);
  const table = new Float32Array(TABLE_LEN * 4), colors = new Float32Array(MAX_BEDS * 4);
  const put = (row, v) => table.set(v, row * 4);
  for (let k = 0; k < MAX_BEDS; k++) {
    const b = T.beds[Math.min(k, T.beds.length - 1)];
    put(TB.beds + k, [k < T.beds.length ? b.base : 1e9, b.erode, b.weather, b.cliffTan]);
    put(TB.bedsB + k, [b.sol || 0, b.perm ?? 1, 0, 0]);
    colors.set([...b.color, 1], k * 4);
  }
  const fw = [1, 1, 1, 1];
  S.faults.forEach((f, k) => { put(TB.faults + k, [f.nx, f.ny, f.c, f.throw]); fw[k] = f.w; });
  put(TB.faultW, fw);
  S.domes.forEach((d, k) => { put(TB.domes + 2 * k, [d.cx, d.cy, d.ra, d.U]); put(TB.domes + 2 * k + 1, [d.ax, d.ay, d.rb, 0]); });
  T.anoms.forEach((a, k) => { put(TB.anoms + 2 * k, a.seg); put(TB.anoms + 2 * k + 1, [a.hw, ANOM[a.type], a.strength, a.dTop]); });
  put(TB.plunge, [S.plunge.A, S.plunge.kx, S.plunge.ky, S.plunge.ph]);
  S.joints.forEach((j, k) => put(TB.joints + k, [j.nx, j.ny, j.spacing, j.strength]));
  CRYSTALLINE.forEach((r, k) => { put(TB.base + k, [r.erode, r.weather, r.cliffTan, r.perm]); put(TB.baseCol + k, [...r.color, 1]); });
  put(TB.misc, [S.faults.length, S.domes.length, T.anoms.length, S.mosaic ? 1 : 0]);
  return { head, table, colors };
}

const f3 = (v) => `vec3<f32>(${v.map((x) => x.toFixed(3)).join(', ')})`;
// The lookup, written against an accessor so the sim (Params scalars) and the renderer (R vec4s)
// share it. a(i) returns the WGSL expression for structure float i; bed(e) the table vec4 at row e.
export function strataWGSL(a, bed) {
  const row = (base, e) => bed(`${base}u + ${e}`);
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
// Map position (m from the centre) of grid cell g.
fn stP(g : vec2<f32>) -> vec2<f32> { return (g - ${a(15)}) * ${a(14)}; }
// Structure offset (m) of the bed surfaces: dip, monocline, plunging fold, fault steps, domes.
fn stStruct(p : vec2<f32>) -> f32 {
  var s = -dot(vec2<f32>(${a(2)}, ${a(3)}), p);
  if (${a(7)} > 0.0) {
    let t = clamp((dot(vec2<f32>(${a(4)}, ${a(5)}), p) - ${a(6)}) / ${a(8)}, -10.0, 10.0);
    s -= ${a(7)} * 0.5 * (1.0 + tanh(t));
  }
  let pl = ${bed(`${TB.plunge}u`)};
  s += ${a(9)} * (1.0 + pl.x * cos(dot(pl.yz, p) + pl.w)) * cos(dot(vec2<f32>(${a(10)}, ${a(11)}), p) + ${a(12)});
  let m = ${bed(`${TB.misc}u`)};
  let fw = ${bed(`${TB.faultW}u`)};
  for (var f = 0u; f < u32(m.x); f++) {
    let F = ${row(TB.faults, 'f')};
    let t = clamp((dot(F.xy, p) - F.z) / fw[f], -10.0, 10.0);
    s -= F.w * 0.5 * (1.0 + tanh(t));
  }
  for (var d = 0u; d < u32(m.y); d++) {
    let A = ${row(TB.domes, '2u * d')}; let B = ${row(TB.domes, '2u * d + 1u')};
    let q = p - A.xy;
    let u = dot(q, B.xy) / A.z; let v = (B.x * q.y - B.y * q.x) / B.z;
    s += A.w * exp(-(u * u + v * v));
  }
  return s;
}
// Depth (m) into the stack at bedrock height z in grid cell g.
fn stDepth(z : f32, g : vec2<f32>) -> f32 {
  let gw = g * (${a(14)} / 10.0);
  let warp = (stNoise(gw * 0.012) - 0.5) * 4.0 + (stNoise(gw * 0.05) - 0.5) * 1.5;
  return ${a(1)} + stStruct(stP(g)) + warp - z;
}
// (bed index, metres below the bed's top, metres above its base) at depth d.
fn stLayerD(d : f32) -> vec3<f32> {
  var k = 0u;
  for (var st = 16u; st > 0u; st = st >> 1u) {
    if (k + st - 1u < ${MAX_BEDS}u && d >= ${bed('k + st - 1u')}.x) { k += st; }
  }
  k = min(k, u32(${a(13)}) - 1u);
  let top = select(0.0, ${bed('max(k, 1u) - 1u')}.x, k > 0u);
  return vec3<f32>(f32(k), d - top, ${bed('k')}.x - d);
}
fn stLayer(z : f32, g : vec2<f32>) -> vec3<f32> { return stLayerD(max(stDepth(z, g), 0.0)); }
fn stSeg(p : vec2<f32>, s : vec4<f32>) -> f32 {
  let ab = s.zw - s.xy;
  let t = clamp(dot(p - s.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - s.xy - ab * t);
}
// Everything about the rock at bedrock height z in cell g:
//   p (erode multiplier, weather multiplier, cliff tan), sol (dissolution multiplier), perm
//   (groundwater conductivity multiplier), heat (deg C of ground warming), col/cw (anomaly colour id
//   and its weight, renderer), k (bed index), mw (crystalline mosaic weights, renderer), lyz (metres
//   below the bed's top and above its base).
struct StRock { p : vec3<f32>, sol : f32, perm : f32, heat : f32, col : f32, cw : f32, k : f32, mw : vec3<f32>, lyz : vec2<f32> };
fn stMark(r : ptr<function, StRock>, id : f32, w : f32) { if (w > (*r).cw) { (*r).col = id; (*r).cw = w; } }
fn stRock(z : f32, g : vec2<f32>) -> StRock {
  let d = max(stDepth(z, g), 0.0);
  let L = stLayerD(d);
  let k = u32(L.x); let n = u32(${a(13)});
  let pk = ${bed('k')}.yzw;
  let pd = ${bed('min(k + 1u, n - 1u)')}.yzw;
  let pu = ${bed('max(k, 1u) - 1u')}.yzw;
  // ~1 m blend across each contact
  let toDown = 0.5 * (1.0 - smoothstep(0.0, 1.0, L.z));
  let toUp = select(0.0, 0.5 * (1.0 - smoothstep(0.0, 1.0, L.y)), k > 0u);
  let bb = ${row(TB.bedsB, 'k')};
  var r = StRock(pk + (pd - pk) * toDown + (pu - pk) * toUp, bb.x, bb.y, 0.0, 0.0, 0.0, L.x, vec3<f32>(0.0), L.yz);
  let m = ${bed(`${TB.misc}u`)};
  let gw = g * (${a(14)} / 10.0);
  let cs = ${a(14)};
  let p = stP(g);
  // crystalline core: granite, gneiss and schist in broad patches
  if (m.w > 0.5 && k + 1u >= n) {
    let t = stNoise(gw * 0.004) * 0.7 + stNoise(gw * 0.017 + 3.1) * 0.3;
    let wg = 1.0 - smoothstep(0.38, 0.46, t);
    let ws = smoothstep(0.56, 0.64, t);
    let w = vec3<f32>(wg, max(1.0 - wg - ws, 0.0), ws);
    let b0 = ${bed(`${TB.base}u`)}; let b1 = ${bed(`${TB.base + 1}u`)}; let b2 = ${bed(`${TB.base + 2}u`)};
    let f = smoothstep(0.0, 1.0, L.y);
    r.p = mix(r.p, b0.xyz * w.x + b1.xyz * w.y + b2.xyz * w.z, f);
    r.perm = mix(r.perm, b0.w * w.x + b1.w * w.y + b2.w * w.z, f);
    r.mw = w * f;
  }
  // joints: the massive, hard beds crack along two families of fractures
  if (r.p.z > 2.5) {
    var jw = 0.0;
    for (var j = 0u; j < 2u; j++) {
      let J = ${row(TB.joints, 'j')};
      if (J.z > 0.0) {
        let u = dot(p, J.xy) / J.z + 0.35 * stNoise(gw * 0.015 + f32(j) * 7.0);
        let dist = (0.5 - abs(fract(u) - 0.5)) * J.z;
        jw = max(jw, J.w * (1.0 - smoothstep(0.2 * cs, 0.75 * cs, dist)));
      }
    }
    r.p = r.p * vec3<f32>(1.0 + 3.5 * jw, 1.0 + 2.0 * jw, 1.0 - 0.55 * jw);
    r.perm *= 1.0 + 4.0 * jw;
    stMark(&r, 11.0, 0.35 * jw);
  }
  // anomalies
  for (var q = 0u; q < u32(m.z); q++) {
    let S = ${row(TB.anoms, '2u * q')}; let B = ${row(TB.anoms, '2u * q + 1u')};
    let t = u32(B.y + 0.5);
    let hw = B.x; let bl = 0.5 * cs;
    let dist = stSeg(p, S);
    let reach = select(hw + bl, 3.0 * hw + bl, t == 4u);
    if (dist > reach) { continue; }
    let w = 1.0 - smoothstep(hw - bl, hw + bl, dist);
    switch t {
      case 1u: {   // dike: hard dark sheet
        r.p = mix(r.p, ${f3(DIKE)}, w); r.perm = mix(r.perm, 0.3, w); r.sol *= 1.0 - w; stMark(&r, 1.0, w);
      }
      case 2u: {   // fault zone: crushed, weak, leaky
        r.p = r.p * vec3<f32>(1.0 + 2.0 * w, 1.0 + w, 1.0 - 0.45 * w); r.perm *= 1.0 + 19.0 * w; stMark(&r, 2.0, 0.7 * w);
      }
      case 3u: {   // hydrothermal alteration: soft ochre rock
        r.p = r.p * vec3<f32>(1.0 + 1.5 * w, 1.0 + 2.0 * w, 1.0 - 0.4 * w); r.perm *= 1.0 + 2.0 * w; stMark(&r, 3.0, 0.85 * w);
      }
      case 4u: {   // hot spring: warm ground in a halo, an open conduit and travertine at the vent
        r.heat += B.z * (1.0 - smoothstep(0.0, 3.0 * hw, dist)); r.perm *= 1.0 + 9.0 * w; stMark(&r, 4.0, w);
      }
      case 5u: {   // sinkhole seed: dissolution concentrates here
        r.sol *= 1.0 + B.z * w; r.perm *= 1.0 + 4.0 * w;
      }
      case 6u: {   // salt body: caprock on top, then salt
        if (d >= B.w) {
          let cap = 1.0 - smoothstep(B.z - 0.5, B.z + 0.5, d - B.w);
          r.p = mix(r.p, mix(${f3(SALT)}, ${f3(CAPROCK)}, cap), w);
          r.sol = mix(r.sol, mix(30.0, 2.0, cap), w); r.perm = mix(r.perm, mix(0.2, 3.0, cap), w);
          stMark(&r, select(7.0, 6.0, cap > 0.5), w);
        }
      }
      case 7u: {   // breccia pipe: broken, leaky, a little soluble
        r.p = r.p * vec3<f32>(1.0 + 1.5 * w, 1.0 + w, 1.0 - 0.3 * w); r.perm *= 1.0 + 9.0 * w; r.sol = max(r.sol, 0.5 * w); stMark(&r, 8.0, 0.8 * w);
      }
      case 8u: {   // laccolith core: hard porphyry below its top
        if (d >= B.w) { r.p = mix(r.p, ${f3(PORPHYRY)}, w); r.perm = mix(r.perm, 0.3, w); r.sol *= 1.0 - w; stMark(&r, 9.0, w); }
      }
      case 9u: {   // volcanic neck
        r.p = mix(r.p, ${f3(NECK)}, w); r.perm = mix(r.perm, 0.3, w); r.sol *= 1.0 - w; stMark(&r, 10.0, w);
      }
      default: {}
    }
  }
  return r;
}
// (erode multiplier, weather multiplier, cliff tan)
fn stProps(z : f32, g : vec2<f32>) -> vec3<f32> { return stRock(z, g).p; }
`;
}

// Param names for the 16 structure floats, in packStrata order (sim/params.js).
export const STRATA_PARAM_FIELDS = ['strataOn', 'strataTop', 'stDipX', 'stDipY', 'stMonoNx', 'stMonoNy', 'stMonoC', 'stMonoThrow',
  'stMonoW', 'stFoldA', 'stFoldKx', 'stFoldKy', 'stFoldPh', 'stCount', 'stCell', 'stCenter'];

const cpuHash = (px, py) => {
  let qx = px * 0.1031, qy = py * 0.1030; qx -= Math.floor(qx); qy -= Math.floor(qy);
  const d = qx * (qy + 33.33) + qy * (qx + 33.33);
  const rx = qx + d, ry = qy + d;
  const v = (rx + ry) * rx; return v - Math.floor(v);
};
const cpuNoise = (px, py) => {
  const ix = Math.floor(px), iy = Math.floor(py), ux = px - ix, uy = py - iy;
  const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
  const a = cpuHash(ix, iy) + (cpuHash(ix + 1, iy) - cpuHash(ix, iy)) * sx;
  const b = cpuHash(ix, iy + 1) + (cpuHash(ix + 1, iy + 1) - cpuHash(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
};
// CPU mirror of stDepth.
export function strataDepth(z, x, y, T) {
  const c = (T.N - 1) * 0.5, f = T.cellSize / 10;
  const gx = x * f, gy = y * f;
  const warp = (cpuNoise(gx * 0.012, gy * 0.012) - 0.5) * 4 + (cpuNoise(gx * 0.05, gy * 0.05) - 0.5) * 1.5;
  return T.top + structure(T.struct, (x - c) * T.cellSize, (y - c) * T.cellSize) + warp - z;
}
// CPU mirror of stLayer (bed index only), for tests and probes.
export function strataLayer(z, x, y, T) {
  const d = Math.max(0, strataDepth(z, x, y, T));
  let k = 0;
  while (k < T.beds.length - 1 && d >= T.beds[k].base) k++;
  return k;
}
// Anomalies covering cell (x, y), by footprint only (ignores the depth of buried bodies):
// [{ type, w }] with w the same 0..1 weight the GPU uses.
export function anomalyAt(x, y, T) {
  const c = (T.N - 1) * 0.5, px = (x - c) * T.cellSize, py = (y - c) * T.cellSize, bl = 0.5 * T.cellSize;
  const out = [];
  for (const a of T.anoms) {
    const [x0, y0, x1, y1] = a.seg, abx = x1 - x0, aby = y1 - y0;
    const t = Math.max(0, Math.min(1, ((px - x0) * abx + (py - y0) * aby) / Math.max(abx * abx + aby * aby, 1e-6)));
    const dist = Math.hypot(px - x0 - abx * t, py - y0 - aby * t);
    const e = Math.max(0, Math.min(1, (dist - (a.hw - bl)) / (2 * bl)));
    const w = 1 - e * e * (3 - 2 * e);
    if (w > 0) out.push({ type: a.type, w, dist });
  }
  return out;
}
// CPU mirror of the joint weight in stRock (0..1, before the hard-bed test), for tests.
export function jointAt(x, y, T) {
  const c = (T.N - 1) * 0.5, cs = T.cellSize, px = (x - c) * cs, py = (y - c) * cs, f = cs / 10;
  let jw = 0;
  T.struct.joints.forEach((J, j) => {
    const u = (px * J.nx + py * J.ny) / J.spacing + 0.35 * cpuNoise(x * f * 0.015 + j * 7, y * f * 0.015 + j * 7);
    const fr = u - Math.floor(u), dist = (0.5 - Math.abs(fr - 0.5)) * J.spacing;
    const e = Math.max(0, Math.min(1, (dist - 0.2 * cs) / (0.55 * cs)));
    jw = Math.max(jw, J.strength * (1 - e * e * (3 - 2 * e)));
  });
  return jw;
}
