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
@group(0) @binding(6) var<storage, read_write> temp : array<f32>;
@group(0) @binding(7) var<storage, read_write> groundwater : array<f32>;
@group(0) @binding(8) var<storage, read_write> acc : array<vec4<f32>>;

struct Col { swe : f32, g : f32, d : f32, fr : f32, mn : f32 };

// Integrate n inner steps of length dt from day "start". Returns (precip, ET, runoff, weathering).
// asp: slope aspect, +1 steep sun-facing (south) .. -1 steep shaded (north). Sunny slopes run warmer
// and melt faster; shaded ones cooler and slower (ported from the Physicist build's insolation model).
fn integrate(st : ptr<function, Col>, n : u32, dt : f32, start : f32, z : f32, so : f32, asp : f32) -> vec4<f32> {
  var a = vec4<f32>(0.0);
  for (var k = 0u; k < n; k++) {
    let doy = start + (f32(k) + 0.5) * dt;
    let T = airTemp(doy, z) + select(1.5, 1.0, asp > 0.0) * asp;
    let pr = precipRate(doy, z) * dt;
    let sn = snowStep((*st).swe, T, pr, dt, 1.0 + 0.5 * asp);
    (*st).swe = sn.x;
    (*st).mn = min((*st).mn, sn.x);
    a.y += sn.z;
    (*st).d = frostStep((*st).d, T, (*st).swe, dt);
    (*st).fr = frozenFactor((*st).d, T);
    let cyc = ftCycles(T, dt) * select(0.0, 1.0, (*st).swe < 0.03);   // snow cover damps surface cycles
    let s3 = soilStep((*st).g, sn.y, T, (*st).fr, dt);
    (*st).g = s3.x; a.z += s3.y; a.y += s3.z;
    a.w += weathering(cyc, (*st).g / max(P.gwMax, 1e-3), so, dt);
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
  let swe0 = snowSWE[i];
  let g0 = groundwater[i];
  var st = Col(swe0, g0, frostDepth[i], 0.0, 1e9);
  let n = max(1u, u32(P.nInner));
  let dt = P.spanDays / f32(n);
  var a = integrate(&st, n, dt, P.dayStart, z, so, asp);
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
    let a2 = integrate(&st, n, dt, P.dayStart, z, so, asp);
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
  }
  let fr = st.fr;
  let d = st.d;
  // weathering: bedrock -> soil, exact f32 change so solids are conserved
  let w = min(aW, 2.0);
  if (w > 0.0) {
    let nb = br - w;
    bedrock[i] = nb;
    soil[i] = so + (br - nb);
  }
  // runoff: routed part to the surface layer, the rest leaves as fast event flow
  let routed = aR * P.fR;
  let fast = aR - routed;
  var h = water[i] + routed;
  // open-water evaporation and channel transmission loss over the climate time the routed water
  // represents (aW * nSub * dtH seconds)
  let tau = P.aW * f32(P.nSub) * P.dtH;
  let tMean = P.tSea - P.lapse * z * 0.001;
  // Both act only on ponded / channel water (depth-gated): the thin runoff film has already paid
  // its ET in soilStep, and gating keeps the result independent of how runoff is spread in time.
  let e = min(h, P.eSurf * clamp((tMean + 5.0) / 25.0, 0.05, 2.0) * tau * clamp(h / 0.05, 0.0, 1.0));
  h = h - e;
  let tl = min(h, min(P.kTrans * tau * (1.0 - 0.9 * fr) * clamp(h / 0.02, 0.0, 1.0), max(P.gwMax - g, 0.0)));
  h = h - tl;
  g = g + tl;
  water[i] = h;
  snowSWE[i] = swe;
  frostDepth[i] = d;
  groundwater[i] = g;
  temp[i] = airTemp(P.dayStart + P.spanDays, z) + select(1.5, 1.0, asp > 0.0) * asp;
  acc[i] = acc[i] + vec4<f32>(aP, fast, aET + e, 0.0);
}
`;

class ColumnKernel {
  constructor() { this.name = 'column'; this.lastFrame = -1; this.world = null; }
  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'column', COLUMN_WGSL(), ['rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw']);
    this.bg = this.k.bind(world.params.buffer, [B.bedrock, B.soil, B.water, B.snowSWE, B.frostDepth, B.temp, B.groundwater, B.acc]);
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
