// Wind: blowing sand (dunes), dust deflation and desert pavement, sandblasted rock, drifting snow.
//
// One prevailing wind per climate (direction it blows FROM, strength, steadiness; climate.js). Each
// batch runs K wind iterations (K grows with the landscape time of the batch, up to KMAX); each
// iteration has its own direction, so an unsteady wind trades off between two directions up to 160
// degrees apart (linear dunes along the mean wind) or swings all around the compass (star dunes).
//
// Per iteration, two kernels:
//   prep      the local wind u at every cell: the prevailing speed, faster up windward slopes and over
//             crests (x(1 + 2.5 slope), at most x1.8), zero in the wind shadow behind anything rising more than
//             ~15 degrees upwind (marched 10 cells), slowed by plants. From u, how much sand, dust and
//             snow the cell gives to the wind this iteration and how readily each settles on it.
//             Sand flux goes as (u^2 - ut^2) u (Bagnold). Only dry, bare, unfrozen, snow-free ground
//             outside water gives up grains; a gravel top bed (desert pavement) armours it.
//   transfer  each parcel hops downwind, M hops of L cells; at every landing a fraction p settles,
//             the rest hops on; what is left after the last hop settles there. Sand hops 1 cell and
//             settles readily on sand, in the lee and among plants, hardly at all on bare rock - this
//             is the Werner (1995) dune instability, which grows dunes with gentle windward slopes
//             and lee slip faces (the 33 degree sand repose is in erosion.js thermal). Dust hops 5
//             cells and settles mostly in plants and wet ground (loess), or leaves the map. Snow
//             hops 2 cells and drifts into the lee of ridges and into hollows.
//             Gather form: each cell walks the same hop paths backwards, so every parcel is split
//             exactly the same way by every cell that receives part of it: soil and snow are exactly
//             conserved. What hops off the map edge is logged (sand and dust as sediment out, snow as
//             water outflow), so the solids and water books stay closed.
//   Sand passing over bare rock abrades it (soft beds faster, exposed windward faces most): over
//   millennia this carves streamlined ridges along the wind (yardangs). Rock worn off becomes sand.
//   Lifting from mixed soil leaves its coarse part behind as a gravel top bed (sim/deposits.js), so
//   bare desert slopes armour themselves after a few cm; sand then comes mostly from washes and fans.
//
// Time scaling: real dunes travel ~1-5 cells (10 m) a year. Each iteration lifts at most ~8 cm per
// cell, so at the fastest speeds (more than about a year per frame) dunes travel slower than they
// really would - believable, not exact, like the thermal-rate caps in the scheduler.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';
import { CLIMATE_WGSL } from './climate.js';
import { DEPOSIT_WGSL } from './deposits.js';

export const KMAX = 8;
export const WIND_PARAMS = {
  kq: 0.4,          // m/yr of sand lifted per cell at full wind (f = 1) on loose dry sand
  kDust: 0.01,      // m/yr of fines deflated at full wind on dry bare silty ground
  kSnow: 0.04,      // fraction of the exposed snowpack moved per day of drifting
  kAbr: 0.0006,     // m of rock worn per m of sand passing over it (soft beds faster)
  ePerIter: 0.08,   // m: most sand one iteration may lift from a cell
  lag: 0.15,        // coarse share left behind as gravel when the wind winnows mixed soil
  crust: 0.02,      // crusted, cohesive ordinary soil gives up sand this much more slowly than loose sand
  sandTan: 0.65,    // ~33 degrees: angle of repose of dry sand (slip faces)
};
const SAND_GRAIN = 0.62, DUST_GRAIN = 0.2;

// per-iteration uniform: a = (dirX, dirY, perpendicular jitter, wind strength U),
// b = (sand per iteration, dust per iteration, snow fraction per iteration, abrasion)
const WIND_UNIFORM_WGSL = /* wgsl */`
struct WindIter { a : vec4<f32>, b : vec4<f32> };
`;
const HOPS_WGSL = /* wgsl */`
// hop k of length L cells along the wind; the perpendicular jitter (one per iteration) dithers the
// rounding so a wind at any angle averages out to that angle instead of the nearest grid direction
fn hop(k : i32, L : f32) -> vec2<i32> {
  let d = W.a.xy;
  let v = f32(k) * L * d + W.a.z * vec2<f32>(-d.y, d.x);
  return vec2<i32>(i32(round(v.x)), i32(round(v.y)));
}
fn inb(q : vec2<i32>) -> bool { let N = i32(P.N); return q.x >= 0 && q.y >= 0 && q.x < N && q.y < N; }
fn qi(q : vec2<i32>) -> u32 { return idx(q.x, q.y); }
`;

const PREP_WGSL = /* wgsl */`
${COMMON_WGSL}
${CLIMATE_WGSL}
${WIND_UNIFORM_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(5) var<storage, read> frostDepth : array<f32>;
@group(0) @binding(6) var<storage, read> veg : array<f32>;
@group(0) @binding(7) var<storage, read> plant : array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> deposit : array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> give : array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> field : array<vec4<f32>>;
@group(0) @binding(11) var<uniform> W : WindIter;
${HOPS_WGSL}

fn surf(x : i32, y : i32) -> f32 { let j = idxc(x, y); return bedrock[j] + soil[j] + snowSWE[j] / 0.33; }

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let d = W.a.xy;
  let U = W.a.w;
  let z = surf(x, y);
  // slope rising into the wind (stoss side positive, lee side negative), over two cells
  let zu = surf(i32(round(f32(x) - 2.0 * d.x)), i32(round(f32(y) - 2.0 * d.y)));
  let s = (z - zu) / (2.0 * P.cellSize);
  // wind shadow: the steepest rise upwind seen from this cell
  var shade = 0.0;
  for (var m = 1; m <= 10; m++) {
    let zm = surf(i32(round(f32(x) - f32(m) * d.x)), i32(round(f32(y) - f32(m) * d.y)));
    shade = max(shade, (zm - z) / (f32(m) * P.cellSize));
  }
  let shelter = 1.0 - smoothstep(0.22, 0.35, shade);
  let v = clamp(veg[i], 0.0, 1.0);
  let u = U * clamp(1.0 + 2.5 * s, 0.25, 1.8) * shelter * (1.0 - 0.7 * v);
  let f = min(max(u * u - 0.36, 0.0) * u / 0.64, 4.0);   // = 1 at u = 1 (threshold 0.6)
  let fs = max(u * u - 0.16, 0.0) * u / 0.84;         // snow moves at a lower threshold

  let so = soil[i];
  let wet = water[i] >= P.hDry;
  let sn = snowSWE[i];
  let dry = 1.0 - smoothstep(0.2, 0.55, plant[i].y);
  let bare = (1.0 - v) * (1.0 - v);
  let open = bare * select(1.0, 0.0, wet) * (1.0 - smoothstep(0.002, 0.01, sn)) * (1.0 - smoothstep(0.02, 0.1, frostDepth[i]));
  // what the surface is made of: the top sediment bed if there is one, else the preset's soil mix
  // loose sand beds on top (dunes, washes, fans), however many, then the first bed below them
  let a0 = deposit[4u * i]; let a1 = deposit[4u * i + 1u];
  let t0 = deposit[4u * i + 2u]; let t1 = deposit[4u * i + 3u];
  let th = array<f32, 8>(a0.x, a0.y, a0.z, a0.w, a1.x, a1.y, a1.z, a1.w);
  let tg = array<f32, 8>(t0.x, t0.y, t0.z, t0.w, t1.x, t1.y, t1.z, t1.w);
  var looseTh = 0.0;
  var nTh = 0.0;
  var nG = 0.5;
  for (var k = 0; k < 8; k++) {
    if (th[k] <= 0.0) { break; }
    let g = fract(tg[k]) / 0.99;
    // a dust film under 2 cm is winnowed out with the sand; a thicker fine bed is a crust
    if (g < 0.45 && th[k] < 0.02) { continue; }
    if (g < 0.45 || g > 0.85) { nTh = th[k]; nG = g; break; }
    looseTh += th[k];
  }
  var sandF = P.windSandy;
  var fineF = 1.0 - P.windSandy;
  var armour = 0.0;
  if (nTh > 0.0) {
    let w = smoothstep(0.0, 0.02, nTh);
    if (nG > 0.85) { armour = w; }
    else { sandF = mix(sandF, 0.15, w); fineF = mix(fineF, 0.85, w); }
  }
  let sandTop = select(0.0, smoothstep(0.02, 0.1, th[0]), looseTh > 0.0);
  let lift = f * dry * open * smoothstep(0.01, 0.05, so);
  // the loose sand goes first, at the full rate, however thin it is. Once it is used up the wind
  // meets what lies beneath: a gravel pavement shuts it out; ordinary soil is crusted and cohesive
  // and gives up its sand only slowly (and its fines as dust)
  let cap = W.b.x * lift;
  let fromLoose = min(cap, looseTh);
  let rest = select(0.0, (1.0 - fromLoose / cap) * (1.0 - armour), cap > 0.0);
  let Es = min(fromLoose + cap * rest * ${WIND_PARAMS.crust} * sandF, 0.4 * so);
  let Ed = min(W.b.y * lift * rest * fineF, max(0.4 * so - Es, 0.0));
  // settling: sand lands on sand, in the lee and in plants; it bounces off bare rock
  var pS = clamp(0.3 + 0.35 * sandTop + 0.7 * (1.0 - shelter) + 0.5 * v, 0.0, 1.0);
  pS = mix(pS * 0.3, pS, max(smoothstep(0.02, 0.1, so), 1.0 - shelter));
  var pD = clamp(0.04 + 0.4 * v + 0.3 * (1.0 - dry) + 0.2 * (1.0 - shelter), 0.0, 1.0);
  if (wet) { pS = 1.0; pD = 0.8; }
  // snow drifts while it is cold and dry; it settles in the lee, in hollows and among trees
  let T = airTemp(P.dayStart + P.spanDays, P.zRef);
  let En = sn * clamp(W.b.z * fs * (1.0 - smoothstep(-3.0, 1.0, T)) * (1.0 - 0.6 * v), 0.0, 0.6);
  let pN = clamp(0.08 + 0.85 * (1.0 - shelter) + 0.5 * v, 0.0, 1.0);
  give[i] = vec4<f32>(Es, pS, Ed, pD);
  field[i] = vec4<f32>(En, pN, u, shelter);
}
`;

const TRANSFER_WGSL = /* wgsl */`
${COMMON_WGSL}
${WIND_UNIFORM_WGSL}
@group(0) @binding(1) var<storage, read> give : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> field : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(4) var<storage, read_write> soil : array<f32>;
@group(0) @binding(5) var<storage, read_write> snowSWE : array<f32>;
@group(0) @binding(6) var<storage, read_write> deposit : array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> acc : array<vec4<f32>>;
@group(0) @binding(8) var<uniform> W : WindIter;
${HOPS_WGSL}
${DEPOSIT_WGSL}
// put a bed of thickness d (tag tg) on top as its own bed, however thin (bedsAdd would blend a thin
// lag into the bed below and lose it); when the stack is full the bottom pair merges
fn bedsPush(bIn : Beds, d : f32, tg : f32) -> Beds {
  var b = bIn;
  if (b.th[7] > 0.0) {
    let t = b.th[6] + b.th[7];
    b.tg[6] = floor(b.tg[7]) + min((fract(b.tg[6]) * b.th[6] + fract(b.tg[7]) * b.th[7]) / t, 0.99);
    b.th[6] = t;
  }
  for (var k = 7; k > 0; k--) { b.th[k] = b.th[k - 1]; b.tg[k] = b.tg[k - 1]; }
  b.th[0] = d; b.tg[0] = tg;
  return b;
}
// blown sand or dust settling: on a gravel pavement it starts its own bed, so the pavement is buried intact and comes back when the sand blows on; dust landing
// on loose sand is worked into it
fn windAdd(bIn : Beds, d : f32, gr : f32) -> Beds {
  var b = bIn;
  if (b.th[0] > 0.0) {
    let g = fract(b.tg[0]) / 0.99;
    if (g > 0.85 && gr < 0.85) { return bedsPush(b, d, P.depEpoch + 0.99 * gr); }
    if (g >= 0.45 && gr < 0.45) {
      let t = b.th[0] + d;
      b.tg[0] = floor(b.tg[0]) + 0.99 * clamp((g * b.th[0] + gr * d) / t, 0.0, 1.0);
      b.th[0] = t;
      return b;
    }
  }
  return bedsAdd(b, d, gr);
}

// channel c: 0 sand, 1 dust, 2 snow -> (amount given to the wind, settling fraction)
fn ch(c : i32, j : u32) -> vec2<f32> {
  if (c == 0) { return give[j].xy; }
  if (c == 1) { return give[j].zw; }
  return field[j].xy;
}
// (settled here, passed over here, own parcel lost over the map edge)
fn gather(c : i32, M : i32, L : f32, p0 : vec2<i32>) -> vec3<f32> {
  let i = qi(p0);
  let pHere = ch(c, i).y;
  var dep = 0.0;
  var arr = 0.0;
  for (var k = 1; k <= M; k++) {
    let s = p0 - hop(k, L);
    if (!inb(s)) { continue; }
    let e = ch(c, qi(s)).x;
    if (e <= 0.0) { continue; }
    var S = 1.0;
    var ok = true;
    for (var m = 1; m < k; m++) {
      let q = s + hop(m, L);
      if (!inb(q)) { ok = false; break; }
      S *= 1.0 - ch(c, qi(q)).y;
    }
    if (!ok) { continue; }
    let a = e * S;
    arr += a;
    dep += select(a * pHere, a, k == M);
  }
  var lost = 0.0;
  let e0 = ch(c, i).x;
  if (e0 > 0.0) {
    var S = 1.0;
    for (var k = 1; k <= M; k++) {
      let q = p0 + hop(k, L);
      if (!inb(q)) { lost = e0 * S; break; }
      S *= 1.0 - ch(c, qi(q)).y;
    }
  }
  return vec3<f32>(dep, arr, lost);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let p0 = vec2<i32>(x, y);
  let gv = give[i];
  let fl = field[i];
  let sand = gather(0, 6, 1.0, p0);
  let dust = gather(1, 6, 5.0, p0);
  let snow = gather(2, 4, 2.0, p0);
  let so0 = soil[i];
  var so = so0 - gv.x - gv.z + sand.x + dust.x;
  // sandblasting: sand passing over bare rock wears it (soft beds faster, exposed faces most)
  var abr = 0.0;
  let br = bedrock[i];
  if (sand.y > 0.0 && so0 < 0.05) {
    let nb = br - min(W.b.w * sand.y * rockAt(br, x, y).x * fl.z / max(W.a.w, 0.05), 0.05);
    bedrock[i] = nb;
    abr = br - nb;
    so += abr;
  }
  soil[i] = max(so, 0.0);
  if (fl.x > 0.0 || snow.x > 0.0) { snowSWE[i] = max(snowSWE[i] - fl.x + snow.x, 0.0); }
  if (sand.z + dust.z + snow.z > 0.0) { acc[i] = acc[i] + vec4<f32>(0.0, snow.z, 0.0, sand.z + dust.z); }
  if (P.depOn > 0.5 && (gv.x + gv.z + sand.x + dust.x + abr) > 1e-7) {
    var b = bedsLoad(i);
    let lifted = gv.x + gv.z;
    if (lifted > 0.0) {
      // winnowing mixed soil or a fine bed leaves the coarse part behind as a gravel lag on top. Under
      // a lag the fines come out from between and beneath the stones, which stay: the pavement only
      // thickens until it shuts the wind out (it must never be carried off with the dust)
      let gTop = fract(b.tg[0]) / 0.99;
      let LAG = ${WIND_PARAMS.lag};
      if (b.th[0] > 0.0 && gTop > 0.85) {
        let lagTh = b.th[0]; let lagTg = b.tg[0];
        b.th[0] = 0.0;
        b = bedsRemoveTop(b, (1.0 + LAG) * lifted);
        b = bedsPush(b, lagTh + LAG * lifted, lagTg);
      } else if (b.th[0] <= 0.0 || gTop < 0.45) {
        b = bedsRemoveTop(b, (1.0 + LAG) * lifted);
        b = bedsPush(b, LAG * lifted, P.depEpoch + 0.99);
      } else {
        b = bedsRemoveTop(b, lifted);
      }
    }
    if (sand.x + abr > 0.0) { b = windAdd(b, sand.x + abr, ${SAND_GRAIN}); }
    if (dust.x > 0.0) { b = windAdd(b, dust.x, ${DUST_GRAIN}); }
    bedsStore(i, bedsClamp(b, so));
  }
}
`;

function mulberry(seed) {
  let a = seed | 0;
  return () => {
    let t = (a = (a + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Direction the wind blows TOWARD, in grid coordinates (+x east, +y south), from a compass bearing
// it blows FROM (0 = north wind, 90 = east wind, 225 = south-west wind).
export function towardVector(fromDeg) {
  const a = (fromDeg * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

class WindModule {
  constructor() { this.enabled = true; this.rand = mulberry(7); this.iters = 0; this.last = null; }

  init(device, world) {
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kp = makeKernel(device, 'wind.prep', PREP_WGSL, ['r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'rw', 'rw', 'u']);
    this.kt = makeKernel(device, 'wind.transfer', TRANSFER_WGSL, ['r', 'r', 'rw', 'rw', 'rw', 'rw', 'rw', 'u']);
    this.ubufs = []; this.pBG = []; this.tBG = [];
    for (let k = 0; k < KMAX; k++) {
      const u = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `wind.iter${k}` });
      this.ubufs.push(u);
      // thermalDelta is free scratch here: erosion's thermal step has used it, avalanches come after
      this.pBG.push(this.kp.bind(prm, [B.bedrock, B.soil, B.water, B.snowSWE, B.frostDepth, B.veg, B.plant, B.deposit, B.thermalDelta, B.wind, u]));
      this.tBG.push(this.kt.bind(prm, [B.thermalDelta, B.wind, B.bedrock, B.soil, B.snowSWE, B.deposit, B.acc, u]));
    }
  }

  reset(seed = 1) { this.rand = mulberry(seed * 977 + 13); }

  // Plan this batch's iterations: Deros landscape days, Dcol climate days, day = start of the batch,
  // w = { from, speed, steady } (climate.windSettings()). Writes the per-iteration uniforms.
  plan(Deros, Dcol, day, w) {
    this.iters = 0;
    if (!this.enabled || !(w.speed > 0.01) || !(Deros > 0)) return 0;
    const P = WIND_PARAMS, years = Deros / 365;
    // large maps get fewer iterations per batch (the transfer gathers ~70 cells per cell), so at the
    // fastest speeds their dunes travel a little slower still
    const kMax = this.world.N > 512 ? KMAX / 2 : KMAX;
    const K = Math.min(kMax, Math.max(1, Math.ceil((P.kq * years * 1.5) / P.ePerIter)));
    const eSand = Math.min((P.kq * years) / K, P.ePerIter);
    const eDust = Math.min((P.kDust * years) / K, 0.02);
    const eSnow = Math.min(1, (P.kSnow * Math.min(Dcol, 120)) / K);
    // unsteady winds: two directions +-A about the mean, plus a random swing B that covers the whole compass at 0
    const s = Math.min(1, Math.max(0, w.steady));
    const A = 80 * Math.min(1, (1 - s) / 0.5), Bw = 180 * Math.max(0, (0.4 - s) / 0.4);
    const dirs = [];
    for (let k = 0; k < K; k++) {
      // the two winds trade off every iteration: a dune has to feel both before it can reshape
      // (when they trade off by whole seasons each one rebuilds crests across itself)
      const side = (this.flip = -(this.flip || 1));
      const from = w.from + side * A + Bw * (2 * this.rand() - 1) + 6 * (2 * this.rand() - 1);
      const [dx, dy] = towardVector(from);
      const U = w.speed * (0.85 + 0.3 * this.rand());
      const jit = this.rand() - 0.5;
      this.device.queue.writeBuffer(this.ubufs[k], 0, new Float32Array([dx, dy, jit, U, eSand, eDust, eSnow, P.kAbr]));
      dirs.push(from);
    }
    this.iters = K;
    this.last = { K, eSand, eDust, eSnow, dirs };
    return K;
  }

  record(pass) {
    const N = this.world.N;
    for (let k = 0; k < this.iters; k++) {
      pass.setPipeline(this.kp.pipeline); pass.setBindGroup(0, this.pBG[k]); dispatchGrid(pass, N);
      pass.setPipeline(this.kt.pipeline); pass.setBindGroup(0, this.tBG[k]); dispatchGrid(pass, N);
    }
  }
}

export const wind = new WindModule();
export default wind;
