// Fused per-cell "column" kernel: climate + snow + frozen ground + infiltration/ET/groundwater +
// frost weathering, run ONCE per frame for the whole climate interval of the frame.
//
// Why fused: these processes are purely local (no neighbours) but strongly coupled day by day
// (snowmelt on frozen ground runs off; snow insulates the ground). A single kernel sub-cycles
// through the interval at <= 1-day resolution (up to 48 inner steps) entirely in registers, so the
// cost is one read + one write of each layer per frame no matter how many days the frame spans.
//
// Multi-year frames (D >= 365 days): the kernel integrates ONE representative year ending at the
// frame's end date and scales it by yrs = D/365 in a mass-consistent way:
//   - storage changes (snow, groundwater) over that year are multiplied by yrs (seasonal snow
//     that melts out gives ~0, a glacier's net annual accumulation is multiplied),
//   - precipitation is multiplied by yrs and the remaining outputs (runoff, ET) are rescaled so
//     that P = dStorage + runoff + ET holds exactly,
//   - weathering is multiplied by yrs.
//
// Runoff is split: the fraction fR that the hydraulic solver can carry at its routing intensity
// is added to the surface water layer; the rest is "fast runoff" (event flow that leaves the basin
// within the frame) and is logged as outflow, so the water balance stays exact at every speed.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';
import { CLIMATE_WGSL } from './climate.js';
import { SNOW_WGSL } from './snow.js';
import { FREEZETHAW_WGSL } from './freezethaw.js';
import { WATER_VERTICAL_WGSL } from './water.js';

const COLUMN_WGSL = () => /* wgsl */`
${COMMON_WGSL}
${CLIMATE_WGSL}
${SNOW_WGSL}
${FREEZETHAW_WGSL}
${WATER_VERTICAL_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> water : array<f32>;
@group(0) @binding(4) var<storage, read_write> snowSWE : array<f32>;
@group(0) @binding(5) var<storage, read_write> frostDepth : array<f32>;
@group(0) @binding(6) var<storage, read> veg : array<f32>;
@group(0) @binding(7) var<storage, read_write> groundwater : array<f32>;
@group(0) @binding(8) var<storage, read_write> acc : array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> burn : array<f32>;
@group(0) @binding(10) var<storage, read_write> plant : array<vec4<f32>>;

// m: moisture memory (groundwater fill smoothed over ~1 year) that plants respond to
struct Col { swe : f32, g : f32, d : f32, fr : f32, mn : f32, m : f32 };
struct Cell { z : f32, so : f32, asp : f32, extra : f32, cap : f32, vg : f32, bn : f32 };

// Painted local storms (sim/events.js): extra precipitation in m/day at this cell, already averaged
// over the batch, so a 3-day storm adds 3 storm-days of water at any speed. Smooth cosine bell.
fn stormBell(cx : f32, cy : f32, r : f32, a : f32, p : vec2<f32>) -> f32 {
  if (a <= 0.0 || r <= 0.0) { return 0.0; }
  let d = length(p - vec2<f32>(cx, cy)) / r;
  if (d >= 1.0) { return 0.0; }
  return a * (0.5 + 0.5 * cos(PI * d));
}
fn localStorms(p : vec2<f32>) -> f32 {
  return stormBell(P.s0x, P.s0y, P.s0r, P.s0a, p) + stormBell(P.s1x, P.s1y, P.s1r, P.s1a, p)
       + stormBell(P.s2x, P.s2y, P.s2r, P.s2a, p) + stormBell(P.s3x, P.s3y, P.s3r, P.s3a, p);
}

// Integrate n inner steps of length dt from day "start". Returns (precip, ET, runoff, weathering).
// asp: slope aspect, +1 steep sun-facing (south) .. -1 steep shaded (north). Sunny slopes run warmer
// and melt faster; shaded ones cooler and slower (ported from the Physicist build's insolation model).
fn integrate(st : ptr<function, Col>, n : u32, dt : f32, start : f32, c : Cell) -> vec4<f32> {
  var a = vec4<f32>(0.0);
  let mk = 1.0 - exp(-dt / 365.0);
  for (var k = 0u; k < n; k++) {
    let doy = start + (f32(k) + 0.5) * dt;
    let T = airTemp(doy, c.z) + select(1.5, 1.0, c.asp > 0.0) * c.asp;
    let pr = (precipRate(doy, c.z) + c.extra) * dt;
    let sn = snowStep((*st).swe, T, pr, dt, 1.0 + 0.5 * c.asp);
    (*st).swe = sn.x;
    (*st).mn = min((*st).mn, sn.x);
    a.y += sn.z;
    (*st).d = frostStep((*st).d, T, (*st).swe, dt);
    (*st).fr = frozenFactor((*st).d, T);
    let cyc = ftCycles(T, dt) * select(0.0, 1.0, (*st).swe < 0.03);   // snow cover damps surface cycles
    let s3 = soilStep((*st).g, sn.y, T, (*st).fr, dt, c.cap, c.vg, c.bn);
    (*st).g = s3.x; a.z += s3.y; a.y += s3.z;
    let fill = clamp((*st).g / c.cap, 0.0, 1.0);
    (*st).m = (*st).m + (fill - (*st).m) * mk;
    a.w += weathering(cyc, fill, c.so, dt, c.vg);
    a.x += pr;
  }
  return a;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let br = bedrock[i];
  let so = soil[i];
  let z = br + so + P.datum;                 // absolute elevation for lapse rate
  // north-south slope (grid +y points south): ground falling away to the south faces the sun
  let gy = (bedrock[idxc(x, y + 1)] + soil[idxc(x, y + 1)] - bedrock[idxc(x, y - 1)] - soil[idxc(x, y - 1)]) / (2.0 * P.cellSize);
  let asp = clamp(-gy / 0.6, -1.0, 1.0);
  let pl = plant[i];
  let c = Cell(z, so, asp, localStorms(vec2<f32>(f32(x), f32(y))), gwCap(so), clamp(veg[i], 0.0, 1.0), clamp(burn[i], 0.0, 1.0));
  let swe0 = snowSWE[i];
  let g0 = groundwater[i];
  var st = Col(swe0, g0, frostDepth[i], 0.0, 1e9, pl.y);
  let n = max(1u, u32(P.nInner));
  let dt = P.spanDays / f32(n);
  var a = integrate(&st, n, dt, P.dayStart, c);
  var aP = a.x; var aET = a.y; var aR = a.z; var aW = a.w;
  var swe = st.swe; var g = st.g;
  if (P.yrs > 1.0001) {
    // Multi-year frame. Year 1 (above) removes the transient from the initial state; year 2 is the
    // periodic cycle. Only a genuine secular trend is extrapolated over the remaining yrs-1 years:
    // perennial snow (never melted out during year 2 -> glacier mass balance). Seasonal snow and
    // the bounded groundwater store are periodic, so they take their year-2 end state. Fluxes are
    // then rescaled so that P_total = dStorage + runoff + ET holds exactly.
    let s1 = st.swe;
    st.mn = 1e9;
    let a2 = integrate(&st, n, dt, P.dayStart, c);
    let perennial = st.mn > 0.005;
    swe = select(st.swe, max(0.0, s1 + (st.swe - s1) * (P.yrs - 1.0)), perennial);
    g = st.g;
    let pT = a2.x * P.yrs;
    let outT = max(0.0, pT - (swe - swe0) - (g - g0));
    let out2 = a2.y + a2.z;
    let rET = select(0.0, a2.y / out2, out2 > 1e-12);
    aET = outT * rET;
    aR = outT - aET;
    aP = pT;
    aW = a2.w * P.yrs;
  } else {
    // Exact per-cell closure (same idea as the multi-year path): with very short batches the
    // stores change by far less than their own f32 rounding steps, so the summed fluxes and the
    // actual change in storage drift apart. Take the outputs as P - dStorage (exact by Sterbenz)
    // and split them between runoff and ET in the integrated ratio.
    let outT = max(0.0, aP - (swe - swe0) - (g - g0));
    let out1 = aET + aR;
    let rET = select(0.0, aET / out1, out1 > 1e-20);
    aET = outT * rET;
    aR = outT - aET;
  }
  let fr = st.fr;
  let d = st.d;
  // weathering: bedrock -> soil, exact f32 change so solids are conserved; shale crumbles faster
  // than sandstone (sim/strata.js)
  let w = min(aW * rockAt(br, x, y).y, 2.0);
  if (w > 0.0) {
    let nb = br - w;
    bedrock[i] = nb;
    soil[i] = so + (br - nb);
  }
  // runoff: routed part to the surface layer, the rest leaves as fast event flow
  let routed = aR * P.fR;
  let fast = aR - routed;
  let h0 = water[i];
  var h = h0 + routed;
  // open-water evaporation and channel transmission loss over the climate time the routed water
  // represents (aW * nSub * dtH seconds)
  let tau = P.aW * f32(P.nSub) * P.dtH;
  let tMean = P.tSea - P.lapse * z * 0.001;
  // Both act only on ponded / channel water (depth-gated): the thin runoff film has already paid
  // its ET in soilStep, and gating keeps the result independent of how runoff is spread in time.
  let e = min(h, P.eSurf * clamp((tMean + 5.0) / 25.0, 0.05, 2.0) * tau * clamp(h / 0.05, 0.0, 1.0));
  h = h - e;
  let tl = min(h, min(P.kTrans * tau * (1.0 - 0.9 * fr) * clamp(h / 0.02, 0.0, 1.0), max(c.cap - g, 0.0)));
  h = h - tl;
  let gPre = g;
  g = g + tl;
  // f32 rounding of the surface-water and transmission updates, logged so the books stay exact
  let roundoff = ((h - h0) - (routed - e - tl)) + ((g - gPre) - tl);
  water[i] = h;
  snowSWE[i] = swe;
  frostDepth[i] = d;
  groundwater[i] = g;
  plant[i] = vec4<f32>(pl.x, clamp(st.m, 0.0, 1.0), pl.z, pl.w);
  // (air temperature 'temp' is written by the vegetation kernel, which runs later in the batch)
  acc[i] = acc[i] + vec4<f32>(aP, fast - roundoff, aET + e, 0.0);
}
`;

class ColumnKernel {
  constructor() { this.name = 'column'; this.lastFrame = -1; this.world = null; }
  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'column', COLUMN_WGSL(), ['rw', 'rw', 'rw', 'rw', 'rw', 'r', 'rw', 'rw', 'r', 'rw']);
    this.bg = this.k.bind(world.params.buffer, [B.bedrock, B.soil, B.water, B.snowSWE, B.frostDepth, B.veg, B.groundwater, B.acc, B.burn, B.plant]);
    this.lastFrame = -1;
  }
  record(pass) {
    pass.setPipeline(this.k.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, this.world.N);
  }
  // contract-style step, deduplicated per frame (snow.step and freezethaw.step both route here)
  step(encoder, dtDays, climate) {
    const f = climate?.plan?.frame ?? -2;
    if (f === this.lastFrame) return;
    this.lastFrame = f;
    const pass = encoder.beginComputePass({ label: 'column' });
    this.record(pass);
    pass.end();
  }
}

export const column = new ColumnKernel();
