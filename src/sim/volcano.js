// Volcanoes: a vent that throws out cinders into a cone and pours out basalt lava, and the rock they
// leave behind (world.volcRock, see ROCK_WGSL in common.js and VOLCANIC in strata.js).
//
// An eruption (the Volcano brush, or events.add('volcano')) is a small monogenetic cinder cone like
// Sunset Crater or the Black Rock Desert cones in Utah: by default a year of activity building a cone
// about 120 m tall from 5 million m3 of cinders, while 15 million m3 of lava breaks out at its foot
// and runs downhill. The brush strength scales both.
//
// Cone (once per batch while erupting): cinders rain down around the vent in the shape of a cone with
// a crater, ~30 deg flanks (just under the cinders' angle of repose, so it stands but does not fall
// apart). The cone keeps that shape as it grows: each batch adds the difference between the cone of
// the new size and the old one, so it looks the same at any speed. The throat itself fills with
// plug rock, which runs ~200 m down into the old rock; erosion later digs that out as a neck.
//
// Lava (lavaK iterations per batch): a Bingham fluid. A cell passes lava to a lower neighbour only
// where depth x surface slope beats the yield depth (so flows stop in lobes a few metres thick and
// pond on flats), at most the Jeffreys flux rho g h^3 S / (3 eta) over the iteration, through the
// same race-free gather/apply form as the glaciers (exact antisymmetric pairs, RELAX of the excess).
// Lava cools on a time scale that grows with its depth (thin fronts set first, so flows build
// levees), gets stiffer as it cools, and once it is cool enough sets as basalt on the bedrock.
// Lava moves about a cell per iteration at most, so each iteration covers only as much lava time as
// lets the vent add LD_MAX of lava to its source cells (about 20 minutes for the default eruption).
// At time-lapse speeds the iterations per batch run out (K_MAX) and an eruption plays out over a few
// seconds of watching instead of inside one frame, so the flows still find their way downhill.
//
// Whatever a new unit lands on - soil, sediment beds - is welded into its base: the model keeps soil
// only on top of the rock, so the old soil becomes part of the new rock. Solids are unchanged by
// that, and what the vent adds is logged on the CPU in float64 (cum.erupted) for the solids books.
//
// Effects (once per batch where lava is hot): snow flashes to meltwater, glacier ice melts (1 m of
// lava melts ~14 m of ice) and the water runs off through the normal water model, standing water
// boils away (logged as evaporation), plants under the lava die, and plants next to it catch fire.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const VOLCANO_PARAMS = {
  coneTan: 0.58,       // cone flanks (~30 deg), just under the cinders' repose (cliffTan 0.62)
  lavaYield: 0.12,     // m: yield depth; lava moves only where depth x slope is above it
  lavaVisc: 1e6,       // Pa s: effective viscosity of a crusted basalt flow
};
export const ERUPTION_DEFAULTS = { radius: 3, intensity: 1, days: 365, cinders: 5e6, lava: 1.5e7 };
const LAVA_DT = 0.05 * 86400;  // s: most lava time per iteration
const LD_MAX = 0.25;           // m: most new lava per source cell per iteration (the flow moves about
                               // a cell per iteration, so more than this and the vent outruns it)
const K_MAX = 64;              // most lava iterations per batch
const COOL_DAYS = 30;          // days: cooling time of lava 2 m deep (scales with depth)
const FREEZE = 0.15;           // temperature (0..1) at which lava sets
const RELAX = 0.1;           // share of a pair's excess drop moved per iteration (8 pairs: more overshoots into a checkerboard)
const RHO_G = 2700 * 9.81;
const PLUG_DEPTH = 200;        // m: how far the throat's plug reaches down into the old rock
const MAX_VENTS = 2;

// Cone shape, height H (m) at distance r (m) from the vent: flanks at coneTan up to the rim at
// rr = 0.25 H / tan, inner crater walls a little gentler, crater floor 0.2 H below the rim.
export function coneProfile(r, H, s = VOLCANO_PARAMS.coneTan) {
  if (H <= 0) return 0;
  const rr = 0.25 * H / s;
  return Math.max(0, Math.min(H - s * (r - rr), H - 0.8 * s * (rr - r)));
}
// volume = CONE_C H^3 / tan^2 (the shape scales with H)
const CONE_C = (() => {
  let v = 0; const du = 1e-4;
  for (let u = du / 2; u < 1.5; u += du) v += 2 * Math.PI * u * coneProfile(u, 1, 1) * du;
  return v;
})();
export const coneHeight = (V, s = VOLCANO_PARAMS.coneTan) => Math.cbrt(Math.max(V, 0) * s * s / CONE_C);

const VR_WRITE_WGSL = /* wgsl */`
// Lay a unit of type ty on cell i, whose rock top was zb before anything was added. Units that
// erosion has since cut away are dropped; the top unit just grows if it is of the same type; a full
// stack merges its two lowest units into the type of the thicker.
fn vrAdd(i : u32, zb : f32, ty : f32) {
  var c = volcRock[2u * i]; var t = volcRock[2u * i + 1u];
  var n = 0;
  if (t.x > 0.5 && c.x < zb) { n = 1;
    if (t.y > 0.5 && c.y < zb) { n = 2;
      if (t.z > 0.5 && c.z < zb) { n = 3;
        if (t.w > 0.5 && c.w < zb) { n = 4; } } } }
  for (var k = n; k < 4; k++) { c[k] = 0.0; t[k] = 0.0; }
  if (n > 0 && abs(t[n - 1] - ty) < 0.5) { volcRock[2u * i] = c; volcRock[2u * i + 1u] = t; return; }
  if (n == 4) {
    let keep = select(t.y, t.x, c.y - c.x >= c.z - c.y);
    c = vec4<f32>(c.x, c.z, c.w, 0.0); t = vec4<f32>(keep, t.z, t.w, 0.0);
    n = 3;
  }
  c[n] = zb; t[n] = ty;
  volcRock[2u * i] = c; volcRock[2u * i + 1u] = t;
}
// The volcano's throat: one plug unit reaching PLUG_DEPTH down into the old rock.
fn vrPlug(i : u32, zb : f32) {
  let t = volcRock[2u * i + 1u];
  if (t.x > 2.5 && t.y < 0.5 && volcRock[2u * i].x < zb) { return; }
  volcRock[2u * i] = vec4<f32>(zb - ${PLUG_DEPTH}.0, 0.0, 0.0, 0.0);
  volcRock[2u * i + 1u] = vec4<f32>(3.0, 0.0, 0.0, 0.0);
}
// New rock buries whatever loose ground was here: soil and its sediment beds join the bedrock.
fn weldSoil(i : u32) -> f32 {
  let b = bedrock[i]; let so = soil[i];
  if (so > 0.0) {
    let nb = b + so;
    bedrock[i] = nb;
    soil[i] = max(so - (nb - b), 0.0);
    for (var k = 0u; k < 4u; k++) { deposit[4u * i + k] = vec4<f32>(0.0); }
  }
  return b;
}
`;

const CONE_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> volcRock : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> deposit : array<vec4<f32>>;
${VR_WRITE_WGSL}
fn prof(r : f32, H : f32) -> f32 {
  if (H <= 0.0) { return 0.0; }
  let s = P.coneTan; let rr = 0.25 * H / s;
  return max(0.0, min(H - s * (r - rr), H - 0.8 * s * (rr - r)));
}
fn addCone(i : u32, p : vec2<f32>, c : vec2<f32>, vr : f32, h0 : f32, h1 : f32) {
  if (h1 <= h0) { return; }
  let d = length(p - c);
  let dz = prof(d * P.cellSize, h1) - prof(d * P.cellSize, h0);
  if (dz <= 0.0) { return; }
  let zb = weldSoil(i);
  if (d <= vr) { vrPlug(i, zb); } else { vrAdd(i, zb, 2.0); }
  bedrock[i] = bedrock[i] + dz;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let p = vec2<f32>(f32(x), f32(y));
  addCone(i, p, vec2<f32>(P.v0x, P.v0y), P.v0r, P.v0h0, P.v0h1);
  addCone(i, p, vec2<f32>(P.v1x, P.v1y), P.v1r, P.v1h0, P.v1h1);
}
`;

const GATHER_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> lava : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> delta : array<vec4<f32>>;

fn surf(i : u32) -> f32 { return bedrock[i] + soil[i] + lava[i].x; }
// lava and its heat moved from donor a, d = surface drop (> 0)
fn tr1(a : u32, d : f32, dist : f32) -> vec2<f32> {
  let L = lava[a];
  let h = L.x;
  if (h < 0.05 || L.y < ${FREEZE}) { return vec2<f32>(0.0); }
  let ex = ${RELAX} * (d - P.lavaYield / h * dist);
  if (ex <= 0.0) { return vec2<f32>(0.0); }
  // Jeffreys flux over the iteration; cooling lava stiffens (viscosity ~ 1/T^2)
  let q = ${RHO_G} * h * h * h * (d / dist) * L.y * L.y / (3.0 * P.lavaVisc);
  let t = min(min(ex, q * P.lavaDt / P.cellSize), h / 8.5);
  return vec2<f32>(t, t * L.y);
}
fn tr(a : u32, b : u32, dist : f32) -> vec2<f32> {
  let d = surf(a) - surf(b);
  if (d > 0.0) { return tr1(a, d, dist); }
  if (d < 0.0) { return -tr1(b, -d, dist); }
  return vec2<f32>(0.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var net = vec2<f32>(0.0);
  var lost = 0.0;
  var near = false;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { if (lava[idxc(x + dx, y + dy)].y >= ${FREEZE}) { near = true; } } }
  if (near) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) { continue; }
        let nx = x + dx; let ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
        let dist = P.cellSize * select(1.0, 1.41421356, dx != 0 && dy != 0);
        net -= tr(i, idx(nx, ny), dist);
      }
    }
    // off the map edge: the ghost cell outside continues the slope of the ground
    if (x == 0 || y == 0 || x == N - 1 || y == N - 1) {
      let z0 = bedrock[i] + soil[i];
      let s0 = surf(i);
      for (var k = 0; k < 4; k++) {
        let o = array<vec2<i32>, 4>(vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1))[k];
        let gx = x + o.x; let gy = y + o.y;
        if (gx >= 0 && gy >= 0 && gx < N && gy < N) { continue; }
        let inner = idxc(x - o.x, y - o.y);
        let dd = s0 - (2.0 * z0 - (bedrock[inner] + soil[inner]));
        if (dd > 0.0) { let t = tr1(i, dd, P.cellSize); net -= t; lost += t.x; }
      }
    }
  }
  delta[i] = vec4<f32>(net, lost, 0.0);
}
`;

const APPLY_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> lava : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> delta : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> volcRock : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> deposit : array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> acc : array<vec4<f32>>;
${VR_WRITE_WGSL}
fn src(p : vec2<f32>, cx : f32, cy : f32, r : f32, d : f32) -> f32 {
  return select(0.0, d, d > 0.0 && length(p - vec2<f32>(cx, cy)) <= r);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var L = lava[i];
  let d = delta[i];
  let p = vec2<f32>(f32(x), f32(y));
  let add = src(p, P.v0lx, P.v0ly, P.v0lr, P.v0ld) + src(p, P.v1lx, P.v1ly, P.v1lr, P.v1ld);
  if (L.x <= 0.0 && L.z <= 0.0 && d.x == 0.0 && add == 0.0) { return; }
  // lava (and its rock) that ran off the map: books as sediment out
  if (d.z > 0.0) { acc[i] = acc[i] + vec4<f32>(0.0, 0.0, 0.0, d.z); }
  var h = max(L.x + d.x, 0.0);
  var Q = max(L.x * L.y + d.y, 0.0);       // heat content
  h += add; Q += add;                      // fresh lava from the vent is at full heat
  var T = select(0.0, min(Q / max(h, 1e-6), 1.0), h > 1e-6);
  // cooling: thin lava loses its heat fastest
  T = T * exp(-P.lavaDt / (${COOL_DAYS}.0 * 86400.0 * max(h, 0.3) / 2.0));
  L.z = L.z * exp(-P.lavaDt / (5.0 * 86400.0));
  if (T < ${FREEZE}) {
    T = 0.0;
    if (h > 1e-3) {
      // the lava sets: it becomes basalt on top of the rock, burying the soil it covered
      let zb = weldSoil(i);
      vrAdd(i, zb, 1.0);
      let b = bedrock[i];
      let nb = b + h;
      bedrock[i] = nb;
      h = h - (nb - b);                     // whatever f32 could not add stays (cold) as lava
      L.z = 1.0;
    }
  }
  lava[i] = vec4<f32>(h, T, select(L.z, 0.0, L.z < 0.01), 0.0);
}
`;

const EFFECTS_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> lava : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> water : array<f32>;
@group(0) @binding(3) var<storage, read_write> snowSWE : array<f32>;
@group(0) @binding(4) var<storage, read_write> glacier : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> veg : array<f32>;
@group(0) @binding(6) var<storage, read_write> burn : array<f32>;
@group(0) @binding(7) var<storage, read_write> plant : array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> acc : array<vec4<f32>>;
fn hotness(i : u32) -> f32 {
  let L = lava[i];
  return max(select(0.0, L.y, L.x > 0.05), 0.5 * L.z);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let L = lava[i];
  let hot = hotness(i);
  if (hot > ${FREEZE}) {
    var w = water[i];
    // snow flashes to meltwater; glacier ice melts (1 m of lava melts ~14 m of ice)
    let sn = snowSWE[i];
    if (sn > 0.0) { snowSWE[i] = 0.0; w += sn; }
    var g = glacier[i];
    if (g.x > 0.0) {
      let m = min(g.x, 14.0 * max(L.x, 0.5) * hot);
      g.x -= m; w += 0.9 * m;
      glacier[i] = g;
    }
    // standing water on hot lava boils away
    let boil = min(w, 0.5 * hot);
    w -= boil;
    if (boil > 0.0) { acc[i] = acc[i] + vec4<f32>(0.0, 0.0, boil, 0.0); }
    water[i] = w;
    // nothing lives under the lava
    veg[i] = 0.0;
    burn[i] = 1.0;
    let pl = plant[i];
    plant[i] = vec4<f32>(0.0, pl.y, pl.z, 0.0);
    return;
  }
  // plants next to hot lava catch fire; the fire model carries it on from there
  if (veg[i] > 0.03) {
    var h = 0.0;
    for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { h = max(h, hotness(idxc(x + dx, y + dy))); } }
    if (h > 0.5) {
      var pl = plant[i];
      let a = min(0.9, smoothstep(0.03, 0.25, veg[i]) * h);
      if (a > pl.w) { pl.w = a; plant[i] = pl; }
    }
  }
}
`;

function discCells(cx, cy, r, N) {
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) n++;
    }
  }
  return n;
}

class Volcanoes {
  constructor() { this.vents = []; this.hasLava = false; this.K = 0; this.seq = 0; this.coneOn = false; this.params = { ...VOLCANO_PARAMS }; }

  init(device, world) {
    this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kc = makeKernel(device, 'volcano.cone', CONE_WGSL, ['rw', 'rw', 'rw', 'rw']);
    this.kg = makeKernel(device, 'volcano.gather', GATHER_WGSL, ['r', 'r', 'r', 'rw']);
    this.ka = makeKernel(device, 'volcano.apply', APPLY_WGSL, ['rw', 'rw', 'rw', 'r', 'rw', 'rw', 'rw']);
    this.ke = makeKernel(device, 'volcano.effects', EFFECTS_WGSL, ['r', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw']);
    this.cBG = this.kc.bind(prm, [B.bedrock, B.soil, B.volcRock, B.deposit]);
    // thermalDelta is free scratch here: erosion, wind, avalanches and glaciers are done with it
    this.gBG = this.kg.bind(prm, [B.bedrock, B.soil, B.lava, B.thermalDelta]);
    this.aBG = this.ka.bind(prm, [B.bedrock, B.soil, B.lava, B.thermalDelta, B.volcRock, B.deposit, B.acc]);
    this.eBG = this.ke.bind(prm, [B.lava, B.water, B.snowSWE, B.glacier, B.veg, B.burn, B.plant, B.acc]);
  }

  reset() { this.vents = []; this.hasLava = false; this.K = 0; this.coneOn = false; }

  get erupting() { return this.vents.some((e) => e.left > 0); }

  /**
   * Start an eruption at grid cell (x, y). o: radius (throat, cells), intensity, days. readLayer
   * reads the ground once to find where the lava breaks out (the low side of the cone's foot).
   */
  erupt(x, y, o, readLayer) {
    const D = ERUPTION_DEFAULTS;
    const I = Math.max(0.05, +(o.intensity ?? D.intensity) || D.intensity);
    const days = Math.max(1, +(o.days ?? D.days) || D.days);
    const r = Math.max(1.5, Math.min(+(o.radius ?? D.radius) || D.radius, 8));
    const e = { id: o.id ?? ++this.seq, x, y, r, days, left: days, cinders: D.cinders * I, lava: D.lava * I, src: null, z0: null };
    e.Hfinal = coneHeight(e.cinders);
    if (this.vents.length >= MAX_VENTS) this.vents.shift();
    this.vents.push(e);
    this.hasLava = true;
    e.ready = Promise.all([readLayer('bedrock'), readLayer('soil')]).then(([b, s]) => { this._breach(e, b, s); });
    return e;
  }

  // Where the lava comes out: the lowest point just beyond the finished cone's foot.
  _breach(e, b, s) {
    const N = this.world.N, dx = this.world.cellSize;
    const H = (gx, gy) => { const i = Math.min(N - 1, Math.max(0, Math.round(gy))) * N + Math.min(N - 1, Math.max(0, Math.round(gx))); return b[i] + s[i]; };
    e.z0 = H(e.x, e.y);
    const Rb = (1.25 * e.Hfinal / VOLCANO_PARAMS.coneTan) / dx + 2.5;
    let best = null;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI, cx = Math.cos(a), cy = Math.sin(a);
      let z = 0;
      for (let t = 0; t < 4; t++) z += H(e.x + cx * (Rb + 2 * t), e.y + cy * (Rb + 2 * t));
      if (!best || z < best.z) best = { z, cx, cy };
    }
    const lx = Math.min(N - 2, Math.max(1, e.x + best.cx * Rb)), ly = Math.min(N - 2, Math.max(1, e.y + best.cy * Rb));
    e.src = { x: lx, y: ly, r: 2.5, cells: discCells(lx, ly, 2.5, N) };
  }

  // Cinders added to the map by growing vent e's cone from H0 to H1 (m3, float64 like the GPU sum).
  _coneVolume(e, H0, H1) {
    const N = this.world.N, dx = this.world.cellSize, s = VOLCANO_PARAMS.coneTan;
    const R = Math.ceil((1.25 * H1 / s) / dx) + 2;
    let v = 0;
    for (let y = Math.max(0, Math.floor(e.y - R)); y <= Math.min(N - 1, Math.ceil(e.y + R)); y++) {
      for (let x = Math.max(0, Math.floor(e.x - R)); x <= Math.min(N - 1, Math.ceil(e.x + R)); x++) {
        const r = Math.hypot(x - e.x, y - e.y) * dx;
        const dz = coneProfile(r, H1) - coneProfile(r, H0);
        if (dz > 0) v += dz;
      }
    }
    return v * dx * dx;
  }

  /**
   * Uniform fields for a batch of D days. Returns { fields, eruptedM3 }: what the vents add to the
   * map this batch (cinders + lava), for the solids books.
   */
  plan(D) {
    const N = this.world.N, A = this.world.cellSize ** 2;
    const active = this.vents.filter((e) => e.left > 0);
    let dtMax = LAVA_DT;
    for (const e of active) if (e.src) dtMax = Math.min(dtMax, (LD_MAX * e.src.cells * A) / (e.lava / e.days) * 86400);
    this.K = active.length || this.hasLava ? Math.min(K_MAX, Math.max(2, Math.ceil((D * 86400) / dtMax))) : 0;
    const dt = this.K ? Math.min((D * 86400) / this.K, dtMax) : 0;
    const lavaDays = (this.K * dt) / 86400;
    const f = { volcOn: 1, lavaK: this.K, lavaDt: dt, ...this.params };
    let erupted = 0;
    this.coneOn = false;
    for (let k = 0; k < MAX_VENTS; k++) {
      const e = active[k];
      let h0 = 0, h1 = 0, ld = 0;
      if (e && e.src && lavaDays > 0) {
        const used = Math.min(lavaDays, e.left);
        const done0 = e.days - e.left, done1 = done0 + used;
        h0 = coneHeight(e.cinders * done0 / e.days); h1 = coneHeight(e.cinders * done1 / e.days);
        const vc = this._coneVolume(e, h0, h1);
        ld = (e.lava * used / e.days) / (this.K * e.src.cells * A);
        erupted += vc + ld * this.K * e.src.cells * A;
        e.left -= used;
        e.H = h1;
        if (h1 > h0) this.coneOn = true;
      }
      Object.assign(f, {
        [`v${k}x`]: e?.x ?? 0, [`v${k}y`]: e?.y ?? 0, [`v${k}r`]: e?.r ?? 0, [`v${k}h0`]: h0, [`v${k}h1`]: h1,
        [`v${k}lx`]: e?.src?.x ?? 0, [`v${k}ly`]: e?.src?.y ?? 0, [`v${k}lr`]: e?.src?.r ?? 0, [`v${k}ld`]: ld,
      });
    }
    // finished eruptions stay listed (for the visuals) until a new one pushes them out
    if (active.length) this.hasLava = true;
    return { fields: f, eruptedM3: erupted, N };
  }

  record(pass) {
    if (!this.K) return;
    const N = this.world.N;
    if (this.coneOn) { pass.setPipeline(this.kc.pipeline); pass.setBindGroup(0, this.cBG); dispatchGrid(pass, N); }
    for (let k = 0; k < this.K; k++) {
      pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.gBG); dispatchGrid(pass, N);
      pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.aBG); dispatchGrid(pass, N);
    }
    pass.setPipeline(this.ke.pipeline); pass.setBindGroup(0, this.eBG); dispatchGrid(pass, N);
  }

  // Remaining eruption days of vent id (0 when over).
  remaining(id) { const e = this.vents.find((q) => q.id === id); return e ? Math.max(e.left, 0) : 0; }
}

export const volcano = new Volcanoes();

// CPU mirror of rockAt's volcanic part: unit type at bedrock height z in cell i (0 = plateau rock).
export function volcLayer(vr, i, z) {
  const c = vr.subarray(8 * i, 8 * i + 4), t = vr.subarray(8 * i + 4, 8 * i + 8);
  if (t[0] < 0.5 || z < c[0]) return 0;
  let k = 0;
  while (k < 3 && t[k + 1] > 0.5 && z >= c[k + 1]) k++;
  return t[k];
}
