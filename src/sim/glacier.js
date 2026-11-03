// Glaciers: ice that forms from old snow (column.js turns snow above firnSWE into ice and melts bare
// ice), flows downhill, scrapes its bed and drops the rock it carried where it melts.
//
// world.glacier, vec4 per cell: (ice thickness m, rock debris carried m, surface speed m/yr, debris
// released by melting and waiting to be dropped m).
//
// Flow (glacK iterations per batch): the same race-free gather/apply form as the snow avalanches in
// snow.js. Every 8-neighbour pair moves an antisymmetric amount of ice, so ice is exactly conserved.
// Ice can flow off the map edge (towards a ghost cell continuing the slope of the ground); it is
// logged as outflow (water) and sediment out (its rock), like water leaving the map. The amount is
// the smaller of
//   - the plastic excess: ice behaves like a material with a yield stress (Nye's perfectly plastic
//     glacier, tauY ~ 60 kPa), so it flows only where its surface is steeper than
//     tauY / (rho g H). Thick ice creeps on gentle slopes and thin ice holds steep ones, which gives
//     glaciers their convex snouts and long flat tongues at any speed;
//   - the physical flux over the iteration's time: shallow-ice deformation (2A/5) (rho g)^3 H^5 S^3,
//     doubled for basal sliding of temperate ice. At slow speeds this sets a real creep rate of a
//     few to ~100 m/yr.
// But no glacier surface stands steeper than ICE_MAX_TAN: ice beyond that breaks off and falls
// straight away (icefalls, hanging glaciers), so cliffs stay bare and the ice gathers below them.
// Rock debris travels with the ice at the donor's concentration.
//
// Carving (apply): moving ice bulldozes the soil under it into its debris load, then abrades the
// bedrock at kGlac x sliding speed (soft beds faster, see strata.js). Soil shields the rock. That rock
// joins the debris too, so solids are conserved. Valleys turn into U-shapes and the heads of glaciers
// into cirques, because that is where the ice is thickest and fastest.
//
// Moraines (finish, once per batch): debris released by melting is laid down as soil, plus a coarse
// "till" sediment bed. It piles up where the ice front stays put (end moraines) and along the
// melting margins (lateral moraines). Trees cannot grow under the ice.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';
import { DEPOSIT_WGSL } from './deposits.js';

export const GLACIER_PARAMS = {
  firnSWE: 1.5,      // m water: snow beyond this compacts into ice
  firnTau: 3,        // years for that excess to turn to ice
  ddfIce: 0.008,     // m water / (degC day): bare ice melts faster than snow (darker, no cold content)
  iceYield: 60000,   // Pa: plastic yield stress of glacier ice (real glaciers: 50-150 kPa)
  iceA: 2.4e-24,     // Pa^-3 s^-1: Glen's flow-law rate factor for temperate ice
  kGlac: 1e-4,       // bedrock abrasion per metre of basal sliding
};
const RHO_G = 917 * 9.81;
const TILL_GRAIN = 0.85;   // till: unsorted, mostly coarse
const RELAX = 0.15;        // share of a pair's excess surface drop moved per iteration
const ICE_MAX_TAN = 0.45;  // steepest glacier surface (about 24 degrees)
const MAX_LOAD = 0.08;     // most rock a glacier carries, as a share of its thickness
const MAX_SLIDE = 150;     // m/yr: sliding speed used for carving is capped (icefalls move faster but
                           // mostly as broken ice falling, not as a sole grinding its bed)

const GATHER_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(4) var<storage, read> glacier : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> delta : array<vec4<f32>>;

fn surf(i : u32) -> f32 { return bedrock[i] + soil[i] + snowSWE[i] / 0.33 + glacier[i].x; }
// ice and debris moved from donor a to b, d = surface drop (> 0)
fn tr1(a : u32, d : f32, dist : f32) -> vec2<f32> {
  let g = glacier[a];
  let H = g.x;
  if (H < 0.5) { return vec2<f32>(0.0); }
  // RELAX of the excess per pair: a cell trades with up to 8 neighbours at once, and taking half of
  // each excess would overshoot into a washboard of cell-sized steps
  let ex = ${RELAX} * (d - min(P.iceYield / (${RHO_G} * H), ${ICE_MAX_TAN}) * dist);
  if (ex <= 0.0) { return vec2<f32>(0.0); }
  let tau = ${RHO_G} * H * d / dist;
  let q = 2.0 * 0.4 * P.iceA * tau * tau * tau * H;                // m^2/s, deformation + sliding
  let phys = 0.5 * q * (P.D * 86400.0 / P.glacK) / P.cellSize;    // m of ice over this cell
  let brk = ${RELAX} * (d - ${ICE_MAX_TAN} * dist);                 // breaks off at once
  let t = min(max(min(ex, phys), brk), H / 8.5);
  return vec2<f32>(t, t * g.y / H);
}
// both cells of a pair evaluate the same expression, so the transfer is exactly antisymmetric
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
  var out = 0.0;
  if (glacier[i].x > 0.0 || glacier[idxc(x - 1, y)].x > 0.0 || glacier[idxc(x + 1, y)].x > 0.0
      || glacier[idxc(x, y - 1)].x > 0.0 || glacier[idxc(x, y + 1)].x > 0.0
      || glacier[idxc(x - 1, y - 1)].x > 0.0 || glacier[idxc(x + 1, y - 1)].x > 0.0
      || glacier[idxc(x - 1, y + 1)].x > 0.0 || glacier[idxc(x + 1, y + 1)].x > 0.0) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) { continue; }
        let nx = x + dx; let ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
        let dist = P.cellSize * select(1.0, 1.41421356, dx != 0 && dy != 0);
        let t = tr(i, idx(nx, ny), dist);
        net -= t;
        out += max(t.x, 0.0);
      }
    }
  }
  // off the map edge: the ghost cell outside continues the slope of the ground, without ice
  var lost = 0.0;
  if (glacier[i].x > 0.5 && (x == 0 || y == 0 || x == N - 1 || y == N - 1)) {
    let z0 = bedrock[i] + soil[i];
    let s0 = surf(i);
    for (var k = 0; k < 4; k++) {
      let o = array<vec2<i32>, 4>(vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1))[k];
      let gx = x + o.x; let gy = y + o.y;
      if (gx >= 0 && gy >= 0 && gx < N && gy < N) { continue; }
      let inner = idxc(x - o.x, y - o.y);
      let zg = 2.0 * z0 - (bedrock[inner] + soil[inner]);
      let dd = s0 - zg;
      if (dd > 0.0) {
        let t = tr1(i, dd, P.cellSize);
        net -= t; out += t.x; lost += t.x;
      }
    }
  }
  delta[i] = vec4<f32>(net, out, lost);
}
`;

const APPLY_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> glacier : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> delta : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> deposit : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> acc : array<vec4<f32>>;
${DEPOSIT_WGSL}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var g = glacier[i];
  let d = delta[i];
  if (d.w > 0.0) {
    // ice (and its rock) that flowed off the map: books as outflow and sediment out
    acc[i] = acc[i] + vec4<f32>(0.0, 0.9 * d.w, 0.0, d.w * g.y / g.x);
  }
  if (g.x <= 0.0 && d.x == 0.0 && d.y == 0.0) { if (g.z != 0.0) { g.z = 0.0; glacier[i] = g; } return; }
  let H0 = g.x;
  g.x = max(g.x + d.x, 0.0);
  g.y = max(g.y + d.y, 0.0);
  let yrs = max(P.D / 365.0 / P.glacK, 1e-9);
  // surface speed from the ice leaving the cell (flux / thickness)
  let u = select(0.0, min(d.z * P.cellSize / max(H0, 1.0) / yrs, 1000.0), H0 > 0.5);
  g.z = u;
  if (P.glacOn > 0.5 && g.x > 2.0 && u > 0.0) {
    let ub = min(0.5 * u, ${MAX_SLIDE}.0);       // sliding share of the surface speed
    // ice can hold only so much rock (dirty basal ice); beyond that it slides over its bed
    let room = max(${MAX_LOAD} * g.x - g.y, 0.0);
    // bulldozing: soil under moving ice is pushed along with it
    var so = soil[i];
    let take = min(so * (1.0 - exp(-ub * yrs / 100.0)), room);
    if (take > 0.0) {
      let ns = so - take;
      soil[i] = ns;
      g.y += so - ns;
      if (P.depOn > 0.5) { let b = bedsLoad(i); if (b.th[0] > 0.0) { bedsStore(i, bedsRemoveTop(b, so - ns)); } }
      so = ns;
    }
    // abrasion of the rock bed; a soil layer shields it
    let br = bedrock[i];
    let e = min(min(P.kGlac * ub * yrs * rockAt(br, x, y).x * exp(-so / 0.5), 0.5 * P.dzMax), max(room - take, 0.0));
    if (e > 0.0) {
      let nb = br - e;
      bedrock[i] = nb;
      g.y += br - nb;
    }
  }
  glacier[i] = g;
}
`;

const FINISH_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> soil : array<f32>;
@group(0) @binding(2) var<storage, read_write> glacier : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> deposit : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> veg : array<f32>;
@group(0) @binding(5) var<storage, read_write> plant : array<vec4<f32>>;
${DEPOSIT_WGSL}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var g = glacier[i];
  // rock left behind where the ice has flowed away entirely
  if (g.x < 0.05 && g.y > 0.0) { g.w += g.y; g.y = 0.0; glacier[i] = g; }
  if (g.w > 0.0) {
    // debris let go by the melting ice becomes till
    let so = soil[i];
    let ns = so + g.w;
    soil[i] = ns;
    g.w = g.w - (ns - so);          // whatever f32 could not add stays for the next batch
    if (P.depOn > 0.5) { bedsStore(i, bedsAdd(bedsLoad(i), ns - so, ${TILL_GRAIN})); }
    glacier[i] = g;
  }
  if (g.x > 1.0) {
    if (veg[i] > 0.0) { veg[i] = 0.0; }
    let pl = plant[i];
    if (pl.x > 0.0) { plant[i] = vec4<f32>(0.0, pl.y, pl.z, pl.w); }
  }
}
`;

class Glaciers {
  constructor() { this.enabled = true; this.hasIce = true; this.K = 2; }
  init(device, world) {
    this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kg = makeKernel(device, 'glacier.gather', GATHER_WGSL, ['r', 'r', 'r', 'r', 'rw']);
    this.ka = makeKernel(device, 'glacier.apply', APPLY_WGSL, ['rw', 'rw', 'rw', 'r', 'rw', 'rw']);
    this.kf = makeKernel(device, 'glacier.finish', FINISH_WGSL, ['rw', 'rw', 'rw', 'rw', 'rw']);
    // thermalDelta is free scratch here: erosion's thermal step, wind and avalanches are done with it
    this.gBG = this.kg.bind(prm, [B.bedrock, B.soil, B.snowSWE, B.glacier, B.thermalDelta]);
    this.aBG = this.ka.bind(prm, [B.bedrock, B.soil, B.glacier, B.thermalDelta, B.deposit, B.acc]);
    this.fBG = this.kf.bind(prm, [B.soil, B.glacier, B.deposit, B.veg, B.plant]);
  }
  // flow iterations for a batch of D days. Ice moves at most about a cell per iteration, so a fast
  // icefall needs many: about 24 per year, 2..48 per batch (at the very fastest speeds that cap
  // makes glaciers thicker and slower than real ones); just 2 while the map has no ice at all (it
  // can only start from snow, and the stats readback switches the full count on)
  // Glaciers off: no new ice and no flow; ice already there just melts (column.js), and the rock it
  // lets go is still laid down.
  iterations(D) {
    this.K = !this.enabled ? 0 : this.hasIce ? Math.min(48, Math.max(2, Math.ceil((D / 365) * 24))) : 2;
    return this.K;
  }
  record(pass) {
    const N = this.world.N;
    for (let k = 0; k < this.K; k++) {
      pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.gBG); dispatchGrid(pass, N);
      pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.aBG); dispatchGrid(pass, N);
    }
    pass.setPipeline(this.kf.pipeline); pass.setBindGroup(0, this.fBG); dispatchGrid(pass, N);
  }
}

export const glacier = new Glaciers();
