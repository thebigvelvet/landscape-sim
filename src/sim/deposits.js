// Sediment beds: what the water and the slopes lay down is kept as its own stack of beds on top of
// the soil.
//
// world.deposit holds 4 vec4 per cell = 8 beds, bed 0 on top (youngest):
//   [4i+0] thickness of beds 0..3 (m)   [4i+1] thickness of beds 4..7
//   [4i+2] tags of beds 0..3            [4i+3] tags of beds 4..7
//   tag = epoch (mod 8192) + 0.99 * grain, grain 0 = clay, ~0.33 silt, ~0.66 sand, 1 = gravel/rubble.
//
// The stack is a LABEL on the top part of `soil`, not extra material: sum(beds) <= soil always, so
// erosion, the solids books and every other process are unchanged. Weathering adds soil at the
// bottom of the column (from bedrock) and never touches the beds.
//   Water: bookkeeping uses the net hydraulic change of each batch: soil is copied to soilPrev right
//   before the water sub-steps, and afterwards a gain becomes sediment (its grain read from the
//   flow's bed shear: gravel on fans and steep channels, sand and silt on flats, clay in still ponds)
//   and a loss is taken off the top beds, youngest first.
//   Slopes: erosion.js thermal-apply does the same with what slumping and creep move: talus that
//   slides off over-steep ground (rock fall from cliffs ends up here) is coarse rubble, soil creep
//   brings finer slope wash.
// A new bed starts when the epoch has moved on (the
// scheduler advances it about every 2 s of watching) or the grain changes sharply; when all 8 slots
// are full the thinnest neighbouring pair merges.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const DEP_BEDS = 8;
export const DEP_FLOATS = 16;     // floats per cell
export const DEP_EPOCHS = 8192;   // epochs wrap so tag = epoch + 0.99 grain keeps its precision
const MIN_BED = 0.1;              // m: a bed thinner than this keeps growing instead of being buried

// Stack helpers, shared with erosion.js (thermal-apply). Needs `deposit` and the params block P.
export const DEPOSIT_WGSL = /* wgsl */`
struct Beds { th : array<f32, 8>, tg : array<f32, 8> };
fn bedsLoad(i : u32) -> Beds {
  var b : Beds;
  let a = deposit[4u * i]; let c = deposit[4u * i + 1u];
  let t = deposit[4u * i + 2u]; let u = deposit[4u * i + 3u];
  b.th = array<f32, 8>(a.x, a.y, a.z, a.w, c.x, c.y, c.z, c.w);
  b.tg = array<f32, 8>(t.x, t.y, t.z, t.w, u.x, u.y, u.z, u.w);
  return b;
}
fn bedsStore(i : u32, b : Beds) {
  deposit[4u * i] = vec4<f32>(b.th[0], b.th[1], b.th[2], b.th[3]);
  deposit[4u * i + 1u] = vec4<f32>(b.th[4], b.th[5], b.th[6], b.th[7]);
  deposit[4u * i + 2u] = vec4<f32>(b.tg[0], b.tg[1], b.tg[2], b.tg[3]);
  deposit[4u * i + 3u] = vec4<f32>(b.tg[4], b.tg[5], b.tg[6], b.tg[7]);
}
fn bedsTotal(b : Beds) -> f32 {
  var s = 0.0;
  for (var k = 0; k < 8; k++) { s += b.th[k]; }
  return s;
}
// take amount off the top beds (youngest first), then close up the emptied slots
fn bedsRemoveTop(bIn : Beds, amount : f32) -> Beds {
  var b = bIn;
  var a = amount;
  for (var k = 0; k < 8; k++) {
    let take = min(b.th[k], a);
    b.th[k] -= take; a -= take;
  }
  var o : Beds;
  var j = 0;
  for (var k = 0; k < 8; k++) {
    if (b.th[k] > 1e-6) { o.th[j] = b.th[k]; o.tg[j] = b.tg[k]; j++; }
  }
  return o;
}
// lay d metres of grain gr on top: grow the top bed if it is from this epoch and of similar grain
// (or still very thin, then it also takes the new epoch), otherwise bury it under a new bed; when the
// stack is full the thinnest neighbouring pair merges
fn bedsAdd(bIn : Beds, d : f32, gr : f32) -> Beds {
  var b = bIn;
  let ep = P.depEpoch;
  let topEp = floor(b.tg[0]);
  let topGr = fract(b.tg[0]) / 0.99;
  if (b.th[0] <= 1e-6) {
    b.th[0] = d; b.tg[0] = ep + 0.99 * gr;
  } else if (b.th[0] < ${MIN_BED} || (topEp == ep && abs(topGr - gr) < 0.35)) {
    let t = b.th[0] + d;
    let g2 = (topGr * b.th[0] + gr * d) / t;
    b.th[0] = t; b.tg[0] = ep + 0.99 * clamp(g2, 0.0, 1.0);
  } else {
    if (b.th[7] > 0.0) {
      // merge the thinnest neighbouring pair, so the 8 beds stay of similar thickness and a deep
      // fill keeps showing bands all the way down (the merged bed keeps the older epoch)
      var m = 0;
      for (var k = 1; k < 7; k++) { if (b.th[k] + b.th[k + 1] < b.th[m] + b.th[m + 1]) { m = k; } }
      let t = b.th[m] + b.th[m + 1];
      let g2 = (fract(b.tg[m]) * b.th[m] + fract(b.tg[m + 1]) * b.th[m + 1]) / t;
      b.th[m] = t; b.tg[m] = floor(b.tg[m + 1]) + min(g2, 0.99);
      for (var k = m + 1; k < 7; k++) { b.th[k] = b.th[k + 1]; b.tg[k] = b.tg[k + 1]; }
      b.th[7] = 0.0; b.tg[7] = 0.0;
    }
    for (var k = 7; k > 0; k--) { b.th[k] = b.th[k - 1]; b.tg[k] = b.tg[k - 1]; }
    b.th[0] = d; b.tg[0] = ep + 0.99 * gr;
  }
  return b;
}
// keep the stack inside the soil (sculpting or anything else that strips soil)
fn bedsClamp(b : Beds, soilDepth : f32) -> Beds {
  let over = bedsTotal(b) - max(soilDepth, 0.0);
  if (over > 0.0) { return bedsRemoveTop(b, over); }
  return b;
}
`;

const RECORD_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> soil : array<f32>;
@group(0) @binding(2) var<storage, read> soilPrev : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read> slope : array<f32>;
@group(0) @binding(5) var<storage, read> velX : array<f32>;
@group(0) @binding(6) var<storage, read> velY : array<f32>;
@group(0) @binding(7) var<storage, read_write> deposit : array<vec4<f32>>;
${DEPOSIT_WGSL}

// Grain of what settles out, from the flow's bed shear (depth x slope, rho g h S): strong flows keep
// the fines moving and drop only the coarse load (gravel on fans and in steep channels), gentle flows
// over flats drop sand and silt. log10(h S) about -4.8 -> clay, -3.2 -> silt/sand, -1.5 -> gravel.
// A cell that has drained counts as a 5 cm sheet of flow. Standing water (a lake or pond: deep and
// slow, whatever the slope of its bed) lets even clay settle.
fn grainOf(h : f32, S : f32, sp : f32) -> f32 {
  let hs = max(h, 0.05) * max(S, 1e-5);
  let g = clamp((log(hs) / log(10.0) + 4.8) / 3.3, 0.0, 1.0);
  let still = smoothstep(0.15, 0.6, h) * (1.0 - smoothstep(0.05, 0.4, sp));
  return mix(g, 0.03, still);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let s = soil[i];
  var b = bedsLoad(i);
  if (P.depOn > 0.5) {
    let d = s - soilPrev[i];
    if (d > 1e-6) {
      b = bedsAdd(b, d, grainOf(water[i], slope[i], length(vec2<f32>(velX[i], velY[i]))));
    } else if (d < -1e-6) {
      b = bedsRemoveTop(b, -d);
    }
  }
  b = bedsClamp(b, s);
  bedsStore(i, b);
}
`;

const SNAPSHOT_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> soil : array<f32>;
@group(0) @binding(2) var<storage, read_write> soilPrev : array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  soilPrev[i] = soil[i];
}
`;

class Deposits {
  init(device, world) {
    this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.ks = makeKernel(device, 'deposits.snapshot', SNAPSHOT_WGSL, ['r', 'rw']);
    this.kr = makeKernel(device, 'deposits.record', RECORD_WGSL, ['r', 'r', 'r', 'r', 'r', 'r', 'rw']);
    this.sBG = this.ks.bind(prm, [B.soil, B.soilPrev]);
    this.rBG = this.kr.bind(prm, [B.soil, B.soilPrev, B.water, B.slope, B.velX, B.velY, B.deposit]);
  }
  snapshot(pass) {
    pass.setPipeline(this.ks.pipeline); pass.setBindGroup(0, this.sBG); dispatchGrid(pass, this.world.N);
  }
  record(pass) {
    pass.setPipeline(this.kr.pipeline); pass.setBindGroup(0, this.rBG); dispatchGrid(pass, this.world.N);
  }
}

export const deposits = new Deposits();

// CPU helpers for probes and the panel: decode one cell's stack from a readLayer('deposit') copy.
export function bedsAt(dep, i) {
  const o = DEP_FLOATS * i, out = [];
  for (let k = 0; k < DEP_BEDS; k++) {
    const th = dep[o + k], tg = dep[o + 8 + k];
    if (th > 1e-6) out.push({ thickness: th, epoch: Math.floor(tg), grain: (tg - Math.floor(tg)) / 0.99 });
  }
  return out;
}
export function grainName(g) { return g < 0.18 ? 'clay' : g < 0.5 ? 'silt' : g < 0.8 ? 'sand' : 'gravel'; }

// Summary over the whole map: deepest fill, most beds in one place, volume by top-bed grain.
export function depositSummary(dep, cells, cellArea) {
  let maxT = 0, maxBeds = 0, vol = 0, covered = 0;
  const byGrain = { clay: 0, silt: 0, sand: 0, gravel: 0 };
  for (let i = 0; i < cells; i++) {
    const o = DEP_FLOATS * i;
    let t = 0, n = 0;
    for (let k = 0; k < DEP_BEDS; k++) {
      const th = dep[o + k];
      if (th > 1e-6) {
        t += th; n++;
        const tg = dep[o + 8 + k];
        byGrain[grainName((tg - Math.floor(tg)) / 0.99)] += th * cellArea;
      }
    }
    if (t > maxT) maxT = t;
    if (n > maxBeds) maxBeds = n;
    if (t > 0.05) covered++;
    vol += t * cellArea;
  }
  return { maxThickness_m: maxT, maxBeds, volume_m3: vol, coveredFrac: covered / cells, volumeByGrain_m3: byGrain };
}
export { MIN_BED };
