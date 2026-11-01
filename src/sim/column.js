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
@group(0) @binding(9) var<storage, read> veg : array<f32>;
@group(0) @binding(10) var<storage, read> eco : array<vec4<f32>>;
@group(0) @binding(11) var<storage, read_write> evt : array<vec4<f32>>;
@group(0) @binding(12) var<storage, read_write> clim : array<vec4<f32>>;

struct Col { swe : f32, g : f32, d : f32, fr : f32, mn : f32 };
// per-cell constants for one integration
struct Env { z : f32, so : f32, asp : f32, cap : f32, kInf : f32, kEt : f32, veg : f32, pMul : f32, dT : f32, ev : f32 };
// a = (precip, ET, runoff, weathering); b = growing-season sums (PET x moisture, PET, days, T x days)
struct Out { a : vec4<f32>, b : vec4<f32> };

// Integrate n inner steps of length dt from day "start".
// asp: slope aspect, +1 steep sun-facing (south) .. -1 steep shaded (north). Sunny slopes run warmer,
// melt faster and have a higher evaporative demand; shaded ones are cooler, slower and moister.
fn integrate(st : ptr<function, Col>, n : u32, dt : f32, start : f32, e : Env) -> Out {
  var a = vec4<f32>(0.0);
  var b = vec4<f32>(0.0);
  for (var k = 0u; k < n; k++) {
    let doy = start + (f32(k) + 0.5) * dt;
    let T = airTemp(doy, e.z) + select(1.5, 1.0, e.asp > 0.0) * e.asp + e.dT;
    let pr = precipRate(doy, e.z) * dt * e.pMul + e.ev * dt;
    let sn = snowStep((*st).swe, T, pr, dt, 1.0 + 0.5 * e.asp);
    (*st).swe = sn.x;
    (*st).mn = min((*st).mn, sn.x);
    a.y += sn.z;
    (*st).d = frostStep((*st).d, T, (*st).swe, dt);
    (*st).fr = frozenFactor((*st).d, T);
    let cyc = ftCycles(T, dt) * select(0.0, 1.0, (*st).swe < 0.03);   // snow cover damps surface cycles
    let pet = potET(T, dt, 1.0 + 0.3 * e.asp);
    let s4 = soilStep((*st).g, sn.y, (*st).fr, dt, e.cap, e.kInf, e.kEt, pet);
    (*st).g = s4.x; a.z += s4.y; a.y += s4.z;
    a.w += weathering(cyc, (*st).g / e.cap, e.so, dt, e.veg);
    a.x += pr;
    // growing season: snow-free days with a daily mean above ~0.9 degC (Koerner & Paulsen 2004)
    let grow = smoothstep(0.4, 1.4, T) * select(0.0, 1.0, (*st).swe < 0.01);
    // treeline warmth uses canopy-level air, which differs less between aspects than the ground does
    let Tcan = T - 0.5 * select(1.5, 1.0, e.asp > 0.0) * e.asp;
    b += vec4<f32>(pet * s4.w, pet, dt, Tcan * dt) * grow;
  }
  return Out(a, b);
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
  let V = clamp(veg[i], 0.0, 1.0);
  let burn = eco[i].y;
  let cap = gwCap(so);
  // Plants raise infiltration (2-4x under shrub canopies vs bare interspaces, Bhark & Small 2003);
  // fresh burns are water-repellent and cut it by up to 70 % (DeBano 2000; Robichaud 2000).
  let kInf = (0.5 + 1.5 * V) * (1.0 - 0.7 * burn);
  let kEt = 0.35 + 0.85 * V;
  // painted events: storm water still to fall, and drought (less rain, hotter: a "hot drought")
  let ev = evt[i];
  let Dd = max(P.D, 1e-6);
  let E = select(0.0, min(ev.x, ev.y * P.D), ev.x > 0.0 && P.spinup < 0.5);
  let cD = min(max(ev.z, 0.0), P.D) / Dd;
  let pMul = 1.0 - (1.0 - ev.w) * cD;
  let dT = 2.5 * (1.0 - ev.w) * cD;
  let multi = P.yrs > 1.0001;
  let env = Env(z, so, asp, cap, kInf, kEt, V, pMul, dT, select(E / max(P.spanDays, 1e-6), 0.0, multi));
  let swe0 = snowSWE[i];
  let g0 = groundwater[i];
  var st = Col(swe0, g0, frostDepth[i], 0.0, 1e9);
  let n = max(1u, u32(P.nInner));
  let dt = P.spanDays / f32(n);
  let o1 = integrate(&st, n, dt, P.dayStart, env);
  let a = o1.a;
  var bS = o1.b;
  var aP = a.x; var aET = a.y; var aR = a.z; var aW = a.w;
  var swe = st.swe; var g = st.g;
  if (multi) {
    // Multi-year frame. Year 1 (above) removes the transient from the initial state; year 2 is the
    // periodic cycle. Only a genuine secular trend is extrapolated over the remaining yrs-1 years:
    // perennial snow (never melted out during year 2 -> glacier mass balance). Seasonal snow and
    // the bounded groundwater store are periodic, so they take their year-2 end state. Fluxes are
    // then rescaled so that P_total = dStorage + runoff + ET holds exactly.
    let s1 = st.swe;
    st.mn = 1e9;
    let o2 = integrate(&st, n, dt, P.dayStart, env);
    let a2 = o2.a;
    bS = o2.b;
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
  // growing-season climate for the vegetation module: a running one-year mean, or this frame's
  // representative year directly when the frame spans a year or more
  let span = max(P.spanDays, 1e-6);
  let bm = bS / span;
  if (P.spanDays >= 364.9 || P.spinup > 0.5) { clim[i] = bm; }
  else { clim[i] = mix(clim[i], bm, 1.0 - exp(-P.D / 365.0)); }
  if (P.spinup > 0.5) { return; }          // diagnostic pass at load: climate indices only
  if (multi && E > 0.0) {
    // storm water in a multi-year frame arrives as one pulse at the end of the frame
    let Te = airTemp(P.dayStart + P.spanDays, z) + select(1.5, 1.0, asp > 0.0) * asp + dT;
    let sf = clamp((1.5 - Te) / 3.0, 0.0, 1.0);
    swe = swe + E * sf;
    let liquid = E * (1.0 - sf);
    let infil = min(liquid, max(cap - g, 0.0));
    g = g + infil;
    aR = aR + (liquid - infil);
    aP = aP + E;
  }
  let left = ev.x - E;
  evt[i] = vec4<f32>(max(left, 0.0), select(0.0, ev.y, left > 1e-7), max(ev.z - P.D, 0.0), select(1.0, ev.w, ev.z - P.D > 0.0));
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
  let tl = min(h, min(P.kTrans * tau * (1.0 - 0.9 * fr) * clamp(h / 0.02, 0.0, 1.0), max(cap - g, 0.0)));
  h = h - tl;
  g = g + tl;
  water[i] = h;
  snowSWE[i] = swe;
  frostDepth[i] = d;
  groundwater[i] = g;
  temp[i] = airTemp(P.dayStart + P.spanDays, z) + select(1.5, 1.0, asp > 0.0) * asp + dT;
  acc[i] = acc[i] + vec4<f32>(aP, fast, aET + e, 0.0);
}
`;

class ColumnKernel {
  constructor() { this.name = 'column'; this.lastFrame = -1; this.world = null; }
  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'column', COLUMN_WGSL(), ['rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'r', 'r', 'rw', 'rw']);
    this.bg = this.k.bind(world.params.buffer, [B.bedrock, B.soil, B.water, B.snowSWE, B.frostDepth, B.temp, B.groundwater, B.acc, B.veg, B.eco, B.evt, B.clim]);
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
