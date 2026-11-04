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
export const ERUPTION_DEFAULTS = { radius: 3, intensity: 1, days: 365, cinders: 5e6, lava: 1.5e7, style: 'strombolian' };

// Eruption styles (the Volcano brush's drop-down). Volumes are for strength 1 (the brush strength
// scales volumes; crater and ring sizes scale with its cube root).
//   cinders/coneTan/coneRim/coneType  the cone built around the vent (rim radius = coneRim H / tan)
//   lava/lavaW/lavaAt/lavaR           lava volume, its stiffness (log10 viscosity, Pa s: 5 runny
//                                     basalt .. 10 dacite that piles into a dome), where it comes
//                                     out ('foot' of the cone, or the 'vent' itself) and source radius
//   pyro                              pyroclastic flows: hot avalanches of ash and gas, run through the
//                                     lava model as a very runny, fast-cooling flow that sets as tuff
//   crater {D, R, late}               explosion crater depth and radius (m), dug below the ground;
//                                     late: share of the eruption before it starts to open (a
//                                     Plinian crater collapses as the magma chamber empties)
//   ring {L, type, bulk}              ejecta thrown out of the crater (bulk x its volume) in a ring
//                                     falling off over L metres
//   ash {T, L}                        ash fall: T m at the vent, thinning over L m, stretched downwind
export const ERUPTION_STYLES = {
  hawaiian: { name: 'Hawaiian', group: 'magmatic', days: 365, cinders: 1.2e6, coneTan: 0.5, coneRim: 0.35, coneType: 2,
    lava: 4e7, lavaW: 5, lavaAt: 'foot', lavaR: 3.5,
    tip: 'Runny basalt pours out in fountains and rivers of lava that run far down the valleys; only a small spatter cone grows at the vent. Like Kilauea and Mauna Loa.' },
  strombolian: { name: 'Strombolian', group: 'magmatic', days: 365, cinders: 5e6, coneTan: 0.58, coneRim: 0.25, coneType: 2,
    lava: 1.5e7, lavaW: 6, lavaAt: 'foot', lavaR: 2.5,
    tip: 'Bursts of glowing cinders build a steep cinder cone about 120 m tall while basalt lava breaks out at its foot. Like Stromboli, Paricutin and Sunset Crater.' },
  vulcanian: { name: 'Vulcanian', group: 'magmatic', days: 365, cinders: 7e6, coneTan: 0.6, coneRim: 0.35, coneType: 5,
    lava: 5e6, lavaW: 8.5, lavaAt: 'foot', lavaR: 2.5, ash: { T: 0.8, L: 900 },
    tip: 'Sticky andesite magma plugs the vent until gas pressure blasts it open: cannon-shot explosions throw out blocks and ash that build a steep cone and dust the land downwind, and a short, thick lava flow creeps out. Like Sakurajima.' },
  pelean: { name: 'Pelean', group: 'magmatic', days: 730, lava: 2.5e7, lavaW: 10, lavaAt: 'vent', lavaR: 3,
    pyro: 6e6, ash: { T: 0.4, L: 800 },
    tip: 'Very stiff dacite lava swells up into a dome over the vent. Its front keeps collapsing into glowing avalanches of hot ash and blocks (pyroclastic flows) that rush down the valleys and burn everything. Like Mont Pelee in 1902.' },
  plinian: { name: 'Plinian', group: 'magmatic', days: 6, crater: { D: 120, R: 350, late: 0.65 }, pyro: 2.5e7, ash: { T: 4, L: 1800 },
    tip: 'The giant one: a column of ash and pumice shoots kilometres high for a few days, burying the land downwind under metres of pumice, while collapsing parts of the column pour pyroclastic flows down the valleys and a deep crater opens. Rain then washes the loose ash into mudflows. Like Vesuvius in 79 AD and Pinatubo.' },
  phreatic: { name: 'Phreatic', group: 'steam', days: 3, crater: { D: 25, R: 90 }, ring: { L: 50, type: 7, bulk: 1.3 }, ash: { T: 0.05, L: 300 },
    tip: 'No new magma reaches the surface: groundwater heated by magma below flashes to steam and blasts a crater out of the old rock, throwing the broken rock around it. Over in a few days. Like the steam blasts at Yellowstone and Ontake.' },
  phreatomagmatic: { name: 'Phreatomagmatic', group: 'steam', days: 60, crater: { D: 70, R: 260 }, ring: { L: 140, type: 6, bulk: 1.2 }, ash: { T: 0.4, L: 700 },
    tip: 'Rising magma meets groundwater and explodes into fine ash: blasts dig a wide crater below the old ground (a maar) and build a low ring of tuff around it. Groundwater often fills the crater into a lake. Like the maars of the Eifel and Zuni Salt Lake.' },
};
export const STYLE_ORDER = Object.keys(ERUPTION_STYLES);
const PYRO_W = 2;              // stiffness of pyroclastic flows (log10 Pa s)
const PYRO_R = 5;              // cells: radius of their source
const PYRO_LD = 3.0;           // m: most pyroclastic flow per source cell per iteration
const PYRO_DT = 300;           // s: lava step while a pyroclastic flow runs
const PYRO_BURSTS = 12;        // pyroclastic flows come as this many collapses (each a share of the total),
                               // thick enough to run downhill rather than settle at the source
// lava stiffness W (log10 viscosity): yield depth and viscosity relative to basalt (W = 6), cooling
// time (pyroclastic flows lose their heat in about a day, a thick dome cools slowly) and the rock it
// sets into
const STIFF_WGSL = /* wgsl */`
fn stiffW(w : f32) -> f32 { return select(w, 6.0, w < 0.5); }
fn yieldOf(w : f32) -> f32 { return P.lavaYield * pow(10.0, 0.5 * (stiffW(w) - 6.0)); }
fn viscOf(w : f32) -> f32 { return P.lavaVisc * pow(10.0, stiffW(w) - 6.0); }
fn coolOf(w : f32) -> f32 { let s = stiffW(w); return select(select(1.0, 2.0, s > 7.5), 0.03, s < 4.0); }
fn rockOf(w : f32) -> f32 { let s = stiffW(w); return select(select(1.0, 4.0, s > 7.0), 6.0, s < 4.0); }
`;
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
export function coneProfile(r, H, s = VOLCANO_PARAMS.coneTan, k = 0.25) {
  if (H <= 0) return 0;
  const rr = k * H / s;
  return Math.max(0, Math.min(H - s * (r - rr), H - 0.8 * s * (rr - r)));
}
// volume = CONE_C H^3 / tan^2 (the shape scales with H)
const CONE_C = (() => {
  let v = 0; const du = 1e-4;
  for (let u = du / 2; u < 1.5; u += du) v += 2 * Math.PI * u * coneProfile(u, 1, 1) * du;
  return v;
})();
export const coneHeight = (V, s = VOLCANO_PARAMS.coneTan, k = 0.25) => Math.cbrt(Math.max(V, 0) * s * s / coneC(k));
const coneCs = {};
function coneC(k) {
  if (k === 0.25) return CONE_C;
  if (!coneCs[k]) { let v = 0; const du = 1e-4; for (let u = du / 2; u < 3; u += du) v += 2 * Math.PI * u * coneProfile(u, 1, 1, k) * du; coneCs[k] = v; }
  return coneCs[k];
}
// Ejecta ring around an explosion crater of radius R (m): height rH at the rim, a steep inner wall,
// falling off over rL outside. Ash: T at the vent thinning over L, reaching ~3x farther downwind.
// (CPU twins of ringProf / ashProf in CONE_WGSL, for the solids books.)
export function ringProfile(r, R, rH, rL) {
  if (rH <= 0) return 0;
  if (r < R) return rH * Math.min(Math.max(1 - (R - r) / (0.2 * R), 0), 1);
  return rH * Math.exp(-(r - R) / rL);
}
export function ashProfile(qx, qy, T, L, wx, wy) {
  const d = Math.hypot(qx, qy), along = qx * wx + qy * wy;
  return T * Math.exp(-Math.max(d - 0.7 * along, 0.2 * d) / L);
}

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

// One vent's landforms for this batch: crater dug, ejecta ring, ash fall, cone (WGSL, vent k).
const ventWGSL = (k) => /* wgsl */`
  {
    let c = vec2<f32>(P.v${k}x, P.v${k}y);
    let dg = P.v${k}g1 - P.v${k}g0;
    let r = length(p - c) * P.cellSize;
    if (dg > 0.0) {
      // explosion crater: dug out of whatever is here, soil first
      if (P.v${k}cD > 0.0 && r < P.v${k}cR && P.v${k}k1 > P.v${k}k0) {
        let u = r / P.v${k}cR;
        let dz = P.v${k}cD * (1.0 - u * u) * (P.v${k}k1 - P.v${k}k0);
        let so = soil[i]; let t = min(so, dz);
        soil[i] = so - t; bedrock[i] = bedrock[i] - (dz - t);
        veg[i] = 0.0; let pl = plant[i]; plant[i] = vec4<f32>(0.0, pl.y, pl.z, 0.0);
      }
      // the rock thrown out of it, in a ring
      let rz = ringProf(r, P.v${k}cR, P.v${k}rH, P.v${k}rL) * dg;
      // (like the ash: a thick layer becomes rock, the thin far edge of it just mixes into the soil)
      if (rz > 0.0) {
        if (ringProf(r, P.v${k}cR, P.v${k}rH, P.v${k}rL) >= max(0.3, soil[i])) { let zb = weldSoil(i); vrAdd(i, zb, P.v${k}ru); bedrock[i] = bedrock[i] + rz; }
        else { soil[i] = soil[i] + rz; }
        killPlants(i, rz);
      }
      // ash fall: a thick blanket becomes a unit of ash and pumice over the old ground; a thin
      // dusting just mixes into the soil
      if (P.v${k}aT > 0.0) {
        let q = (p - c) * P.cellSize;
        let T = ashProf(q, P.v${k}aT, P.v${k}aL, vec2<f32>(P.v${k}awx, P.v${k}awy));
        let dz = T * dg;
        if (dz > 0.0) {
          if (T >= max(0.3, soil[i])) { let zb = weldSoil(i); vrAdd(i, zb, 5.0); bedrock[i] = bedrock[i] + dz; }
          else { soil[i] = soil[i] + dz; }
          killPlants(i, dz);
        }
      }
    }
    addCone(i, p, c, P.v${k}r, P.v${k}h0, P.v${k}h1, P.v${k}ct, P.v${k}ck, P.v${k}cu);
  }`;

const CONE_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> volcRock : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> deposit : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> veg : array<f32>;
@group(0) @binding(6) var<storage, read_write> plant : array<vec4<f32>>;
${VR_WRITE_WGSL}
fn prof(r : f32, H : f32, s : f32, k : f32) -> f32 {
  if (H <= 0.0) { return 0.0; }
  let rr = k * H / s;
  return max(0.0, min(H - s * (r - rr), H - 0.8 * s * (rr - r)));
}
fn ringProf(r : f32, R : f32, rH : f32, rL : f32) -> f32 {
  if (rH <= 0.0) { return 0.0; }
  if (r < R) { return rH * clamp(1.0 - (R - r) / (0.2 * R), 0.0, 1.0); }
  return rH * exp(-(r - R) / rL);
}
fn ashProf(q : vec2<f32>, T : f32, L : f32, w : vec2<f32>) -> f32 {
  let d = length(q);
  return T * exp(-max(d - 0.7 * dot(q, w), 0.2 * d) / L);
}
// buried plants: the share that dies adds up the same at any speed (survivors exp(-depth / 0.25 m))
fn killPlants(i : u32, dz : f32) {
  let f = exp(-dz / 0.25);
  veg[i] = veg[i] * f;
  let pl = plant[i]; plant[i] = vec4<f32>(pl.x * f, pl.y, pl.z, pl.w);
}
fn addCone(i : u32, p : vec2<f32>, c : vec2<f32>, vr : f32, h0 : f32, h1 : f32, s : f32, k : f32, ty : f32) {
  if (h1 <= h0) { return; }
  let d = length(p - c);
  let dz = prof(d * P.cellSize, h1, s, k) - prof(d * P.cellSize, h0, s, k);
  if (dz <= 0.0) { return; }
  let zb = weldSoil(i);
  if (d <= vr) { vrPlug(i, zb); } else { vrAdd(i, zb, ty); }
  bedrock[i] = bedrock[i] + dz;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let p = vec2<f32>(f32(x), f32(y));
${ventWGSL(0)}
${ventWGSL(1)}
}
`;

const GATHER_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> lava : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> delta : array<vec4<f32>>;

${STIFF_WGSL}
fn surf(i : u32) -> f32 { return bedrock[i] + soil[i] + lava[i].x; }
// lava, its heat and its stiffness moved from donor a, d = surface drop (> 0)
fn tr1(a : u32, d : f32, dist : f32) -> vec3<f32> {
  let L = lava[a];
  let h = L.x;
  if (h < 0.05 || L.y < ${FREEZE}) { return vec3<f32>(0.0); }
  let ex = ${RELAX} * (d - yieldOf(L.w) / h * dist);
  if (ex <= 0.0) { return vec3<f32>(0.0); }
  // Jeffreys flux over the iteration; cooling lava stiffens (viscosity ~ 1/T^2)
  let q = ${RHO_G} * h * h * h * (d / dist) * L.y * L.y / (3.0 * viscOf(L.w));
  let t = min(min(ex, q * P.lavaDt / P.cellSize), h / 8.5);
  return vec3<f32>(t, t * L.y, t * stiffW(L.w));
}
fn tr(a : u32, b : u32, dist : f32) -> vec3<f32> {
  let d = surf(a) - surf(b);
  if (d > 0.0) { return tr1(a, d, dist); }
  if (d < 0.0) { return -tr1(b, -d, dist); }
  return vec3<f32>(0.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var net = vec3<f32>(0.0);
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
  delta[i] = vec4<f32>(net.xy, lost, net.z);
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
${STIFF_WGSL}
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
  let a0 = src(p, P.v0lx, P.v0ly, P.v0lr, P.v0ld); let a1 = src(p, P.v1lx, P.v1ly, P.v1lr, P.v1ld);
  let b0 = src(p, P.v0px, P.v0py, P.v0pr, P.v0pd); let b1 = src(p, P.v1px, P.v1py, P.v1pr, P.v1pd);
  let add = a0 + a1 + b0 + b1;
  if (L.x <= 0.0 && L.z <= 0.0 && d.x == 0.0 && add == 0.0) { return; }
  // lava (and its rock) that ran off the map: books as sediment out
  if (d.z > 0.0) { acc[i] = acc[i] + vec4<f32>(0.0, 0.0, 0.0, d.z); }
  var h = max(L.x + d.x, 0.0);
  var Q = max(L.x * L.y + d.y, 0.0);       // heat content
  var S = max(L.x * stiffW(L.w) + d.w, 0.0); // stiffness content (moves with the lava)
  h += add; Q += add;                      // fresh lava from the vent is at full heat
  S += a0 * stiffW(P.v0lw) + a1 * stiffW(P.v1lw) + (b0 + b1) * ${PYRO_W}.0;
  var T = select(0.0, min(Q / max(h, 1e-6), 1.0), h > 1e-6);
  let W = select(6.0, S / max(h, 1e-6), h > 1e-6);
  // cooling: thin lava loses its heat fastest
  T = T * exp(-P.lavaDt / (${COOL_DAYS}.0 * 86400.0 * coolOf(W) * max(h, 0.3) / 2.0));
  L.z = L.z * exp(-P.lavaDt / (5.0 * 86400.0));
  if (T < ${FREEZE}) {
    T = 0.0;
    if (h > 1e-3) {
      // the lava sets: it becomes basalt on top of the rock, burying the soil it covered
      let zb = weldSoil(i);
      vrAdd(i, zb, rockOf(W));
      let b = bedrock[i];
      let nb = b + h;
      bedrock[i] = nb;
      h = h - (nb - b);                     // whatever f32 could not add stays (cold) as lava
      L.z = 1.0;
    }
  }
  lava[i] = vec4<f32>(h, T, select(L.z, 0.0, L.z < 0.01), select(W, 0.0, h <= 1e-6));
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
    // nothing lives under the lava; a pyroclastic flow (stiffness < 4) buries the ground in fresh
    // pale ash instead of leaving a black burn scar
    veg[i] = 0.0;
    burn[i] = select(1.0, 0.0, L.w > 0.5 && L.w < 4.0);
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
    this.kc = makeKernel(device, 'volcano.cone', CONE_WGSL, ['rw', 'rw', 'rw', 'rw', 'rw', 'rw']);
    this.kg = makeKernel(device, 'volcano.gather', GATHER_WGSL, ['r', 'r', 'r', 'rw']);
    this.ka = makeKernel(device, 'volcano.apply', APPLY_WGSL, ['rw', 'rw', 'rw', 'r', 'rw', 'rw', 'rw']);
    this.ke = makeKernel(device, 'volcano.effects', EFFECTS_WGSL, ['r', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw']);
    this.cBG = this.kc.bind(prm, [B.bedrock, B.soil, B.volcRock, B.deposit, B.veg, B.plant]);
    // thermalDelta is free scratch here: erosion, wind, avalanches and glaciers are done with it
    this.gBG = this.kg.bind(prm, [B.bedrock, B.soil, B.lava, B.thermalDelta]);
    this.aBG = this.ka.bind(prm, [B.bedrock, B.soil, B.lava, B.thermalDelta, B.volcRock, B.deposit, B.acc]);
    this.eBG = this.ke.bind(prm, [B.lava, B.water, B.snowSWE, B.glacier, B.veg, B.burn, B.plant, B.acc]);
  }

  reset() { this.vents = []; this.hasLava = false; this.K = 0; this.coneOn = false; }

  get erupting() { return this.vents.some((e) => e.left > 0 || e.bank > 1); }

  /**
   * Start an eruption at grid cell (x, y). o: style (ERUPTION_STYLES key), radius (throat, cells),
   * intensity, days, wind (downwind unit vector in grid cells, for the ash). readLayer reads the
   * ground once to find where the lava and pyroclastic flows break out.
   */
  erupt(x, y, o, readLayer) {
    const D = ERUPTION_DEFAULTS;
    const style = ERUPTION_STYLES[o.style] ? o.style : D.style;
    const S = ERUPTION_STYLES[style];
    const I = Math.max(0.05, +(o.intensity ?? D.intensity) || D.intensity);
    const L1 = Math.cbrt(I);
    const days = Math.max(1, +(o.days ?? S.days) || S.days);
    const r = Math.max(1.5, Math.min(+(o.radius ?? D.radius) || D.radius, 8));
    const w = o.wind || [0, 0], wl = Math.hypot(w[0], w[1]);
    const e = {
      id: o.id ?? ++this.seq, x, y, r, days, left: days, style, styleIndex: STYLE_ORDER.indexOf(style),
      cinders: (S.cinders || 0) * I, lava: (S.lava || 0) * I, pyro: (S.pyro || 0) * I,
      coneTan: S.coneTan || VOLCANO_PARAMS.coneTan, coneRim: S.coneRim || 0.25, coneType: S.coneType || 2,
      lavaW: S.lavaW || 6, lavaAt: S.lavaAt || 'foot', lavaR: S.lavaR || 2.5,
      craterD: S.crater ? S.crater.D * L1 : 0, craterLate: S.crater?.late || 0, craterR: S.crater ? S.crater.R * L1 : 0,
      ringH: 0, ringL: S.ring ? S.ring.L * L1 : 0, ringType: S.ring?.type || 7,
      ashT: S.ash ? S.ash.T * I : 0, ashL: S.ash?.L || 1, wind: wl > 1e-6 ? [w[0] / wl, w[1] / wl] : [0, 0],
      src: null, src2: null, z0: null, bank: 0,
    };
    if (S.ring) {
      const Vc = Math.PI * e.craterR ** 2 * e.craterD / 2;
      e.ringH = S.ring.bulk * Vc / (2 * Math.PI * (e.craterR * e.ringL + e.ringL ** 2));
    }
    e.Hfinal = coneHeight(e.cinders, e.coneTan, e.coneRim);
    // a rough height for a lava dome of this size (for framing the view)
    e.domeH = e.lavaAt === 'vent' && e.lava > 0 ? 0.45 * Math.cbrt(e.lava) : 0;
    // footprint (cells): the cone's foot, the dome, the crater and its ring
    const dx = this.world.cellSize;
    e.footprint = Math.max(4, (1.25 * e.Hfinal / e.coneTan + Math.max(e.craterR + 2 * e.ringL, e.domeH * 2.5)) / dx);
    if (this.vents.length >= MAX_VENTS) this.vents.shift();
    this.vents.push(e);
    this.hasLava = true;
    e.ready = Promise.all([readLayer('bedrock'), readLayer('soil')]).then(([b, s]) => { this._breach(e, b, s); });
    return e;
  }

  // Where the lava and pyroclastic flows come out: the lowest point just beyond the finished cone's
  // foot (or the dome's / the crater's edge), or the vent itself.
  _breach(e, b, s) {
    const N = this.world.N, dx = this.world.cellSize;
    const H = (gx, gy) => { const i = Math.min(N - 1, Math.max(0, Math.round(gy))) * N + Math.min(N - 1, Math.max(0, Math.round(gx))); return b[i] + s[i]; };
    e.z0 = H(e.x, e.y);
    const lowest = (Rb, rs) => {
      let best = null;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * 2 * Math.PI, cx = Math.cos(a), cy = Math.sin(a);
        let z = 0;
        for (let t = 0; t < 4; t++) z += H(e.x + cx * (Rb + 2 * t), e.y + cy * (Rb + 2 * t));
        if (!best || z < best.z) best = { z, cx, cy };
      }
      const lx = Math.min(N - 2, Math.max(1, e.x + best.cx * Rb)), ly = Math.min(N - 2, Math.max(1, e.y + best.cy * Rb));
      return { x: lx, y: ly, r: rs, cells: discCells(lx, ly, rs, N) };
    };
    if (e.lava > 0) {
      e.src = e.lavaAt === 'vent'
        ? { x: e.x, y: e.y, r: e.lavaR, cells: discCells(e.x, e.y, e.lavaR, N) }
        : lowest((1.25 * e.Hfinal / e.coneTan) / dx + 2.5, e.lavaR);
    } else {
      e.src = { x: e.x, y: e.y, r: 0, cells: 0 };
    }
    // pyroclastic flows start beyond the crater's edge or the dome's full spread (~40 m thick), so
    // they run away downhill instead of mixing into the dome or ponding in the crater
    if (e.pyro > 0) e.src2 = lowest(Math.max(e.craterR > 0 ? e.craterR / dx + PYRO_R + 6 : 0, e.lavaAt === 'vent' ? Math.sqrt(e.lava / (Math.PI * 40)) / dx + PYRO_R + 2 : 0, PYRO_R + 3), PYRO_R);
  }

  // Ground added to the map by vent e this batch (m3, float64 like the GPU sum): the cone growing
  // from H0 to H1, plus the share g0..g1 of the crater (taken away), ring and ash.
  // share of the crater dug by the time a share g of the eruption is done
  _kf(e, g) { return e.craterLate > 0 ? Math.min(Math.max((g - e.craterLate) / (1 - e.craterLate), 0), 1) : g; }

  _landVolume(e, H0, H1, g0, g1) {
    const N = this.world.N, dx = this.world.cellSize, s = e.coneTan, kr = e.coneRim;
    let v = 0;
    if (H1 > H0) {
      const R = Math.ceil((1.25 * H1 / s + kr * H1 / s) / dx) + 2;
      for (let y = Math.max(0, Math.floor(e.y - R)); y <= Math.min(N - 1, Math.ceil(e.y + R)); y++) {
        for (let x = Math.max(0, Math.floor(e.x - R)); x <= Math.min(N - 1, Math.ceil(e.x + R)); x++) {
          const r = Math.hypot(x - e.x, y - e.y) * dx;
          const dz = coneProfile(r, H1, s, kr) - coneProfile(r, H0, s, kr);
          if (dz > 0) v += dz;
        }
      }
    }
    const dg = g1 - g0;
    if (dg > 0 && (e.craterD > 0 || e.ringH > 0 || e.ashT > 0)) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const qx = (x - e.x) * dx, qy = (y - e.y) * dx, r = Math.hypot(qx, qy);
          if (e.craterD > 0 && r < e.craterR) { const u = r / e.craterR; v -= e.craterD * (1 - u * u) * (this._kf(e, g1) - this._kf(e, g0)); }
          if (e.ringH > 0) v += ringProfile(r, e.craterR, e.ringH, e.ringL) * dg;
          if (e.ashT > 0) v += ashProfile(qx, qy, e.ashT, e.ashL, e.wind[0], e.wind[1]) * dg;
        }
      }
    }
    return v * dx * dx;
  }

  /**
   * Uniform fields for a batch of D days. Returns { fields, eruptedM3 }: what the vents add to the
   * map this batch (cinders, lava, pyroclastic flows and ash, less what craters blow away), for the
   * solids books.
   */
  plan(D) {
    const N = this.world.N, A = this.world.cellSize ** 2;
    const active = this.vents.filter((e) => e.left > 0 || e.bank > 1);
    let dtMax = LAVA_DT;
    for (const e of active) {
      if (e.src?.cells && e.lava > 0 && e.left > 0) dtMax = Math.min(dtMax, (LD_MAX * e.src.cells * A) / (e.lava / e.days) * 86400);
      // a collapse pours out this batch: short steps, so the flow runs before it cools
      e.burst = e.pyro > 0 && !!e.src2 && (e.bank >= e.pyro / PYRO_BURSTS || (e.left <= 0 && e.bank > 1));
      if (e.burst) dtMax = Math.min(dtMax, PYRO_DT);
    }
    this.K = active.length || this.hasLava ? Math.min(K_MAX, Math.max(2, Math.ceil((D * 86400) / dtMax))) : 0;
    const dt = this.K ? Math.min((D * 86400) / this.K, dtMax) : 0;
    const lavaDays = (this.K * dt) / 86400;
    const f = { volcOn: 1, lavaK: this.K, lavaDt: dt, ...this.params };
    let erupted = 0;
    this.coneOn = false;
    for (let k = 0; k < MAX_VENTS; k++) {
      const e = active[k];
      let h0 = 0, h1 = 0, ld = 0, pd = 0, g0 = 0, g1 = 0;
      if (e && e.src && lavaDays > 0) {
        const used = Math.max(Math.min(lavaDays, e.left), 0);
        const done0 = e.days - e.left, done1 = done0 + used;
        g0 = done0 / e.days; g1 = done1 / e.days;
        h0 = coneHeight(e.cinders * g0, e.coneTan, e.coneRim); h1 = coneHeight(e.cinders * g1, e.coneTan, e.coneRim);
        erupted += this._landVolume(e, h0, h1, g0, g1);
        if (e.lava > 0 && e.src.cells) { ld = (e.lava * used / e.days) / (this.K * e.src.cells * A); erupted += ld * this.K * e.src.cells * A; }
        if (e.pyro > 0 && e.src2) {
          // collapses: the pyroclastic material banks up and pours out once there is a burst's worth
          // (or at the end), at most PYRO_LD per source cell per iteration
          e.bank += e.pyro * used / e.days;
          if (e.burst) {
            const out = Math.min(e.bank, PYRO_LD * this.K * e.src2.cells * A);
            pd = out / (this.K * e.src2.cells * A);
            e.bank -= out;
            erupted += pd * this.K * e.src2.cells * A;
          }
        }
        e.left -= used;
        e.H = h1;
        if (h1 > h0 || e.craterD > 0 || e.ringH > 0 || e.ashT > 0) this.coneOn = true;
      }
      const on = !!(e && e.src && lavaDays > 0);
      Object.assign(f, {
        [`v${k}x`]: e?.x ?? 0, [`v${k}y`]: e?.y ?? 0, [`v${k}r`]: e?.r ?? 0, [`v${k}h0`]: h0, [`v${k}h1`]: h1,
        [`v${k}lx`]: e?.src?.x ?? 0, [`v${k}ly`]: e?.src?.y ?? 0, [`v${k}lr`]: e?.src?.r ?? 0, [`v${k}ld`]: ld,
        [`v${k}lw`]: e?.lavaW ?? 6,
        [`v${k}px`]: e?.src2?.x ?? 0, [`v${k}py`]: e?.src2?.y ?? 0, [`v${k}pr`]: e?.src2?.r ?? 0, [`v${k}pd`]: pd,
        [`v${k}ct`]: e?.coneTan ?? VOLCANO_PARAMS.coneTan, [`v${k}ck`]: e?.coneRim ?? 0.25, [`v${k}cu`]: e?.coneType ?? 2,
        [`v${k}g0`]: on ? g0 : 0, [`v${k}g1`]: on ? g1 : 0,
        [`v${k}cD`]: e?.craterD ?? 0, [`v${k}cR`]: e?.craterR || 1, [`v${k}rH`]: e?.ringH ?? 0, [`v${k}rL`]: e?.ringL || 1,
        [`v${k}ru`]: e?.ringType ?? 7, [`v${k}aT`]: e?.ashT ?? 0, [`v${k}aL`]: e?.ashL || 1,
        [`v${k}awx`]: e?.wind[0] ?? 0, [`v${k}awy`]: e?.wind[1] ?? 0, [`v${k}sp`]: e?.styleIndex ?? 1,
        [`v${k}k0`]: on && e ? this._kf(e, g0) : 0, [`v${k}k1`]: on && e ? this._kf(e, g1) : 0,
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
