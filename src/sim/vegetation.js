// Vegetation: plant cover that grows where water, warmth and soil allow, and dies back in drought,
// after fire, under burial and when stripped by erosion. Runs once per batch on landscape time
// (vegYrs = Deros / 365), after erosion, in the same compute pass as everything else.
//
// State (per cell):
//   veg     total cover V (0..1) = woody cover T + herb/grass cover G
//   eco.x   woody cover T (trees and shrubs)            eco.y  burn severity B (decays, tau 1.5 yr)
//   eco.z   greenness (phenology / drought browning)    eco.w  ground height, lagged by ~1 year
//   clim    growing-season climate from the column kernel (see column.js): last complete calendar
//           year's means of PET x soil moisture, PET, growing-season fraction and T x growing:
//             Wi  = sum(PET * moisture) / sum(PET) over the growing season  (water index 0..1,
//                   in the spirit of AET/PET, Stephenson 1990)
//             Lgs = growing-season length (days, snow-free with daily mean > 0.9 degC)
//             Tgs = growing-season mean temperature
//
// Carrying capacity (what the site can support), all smooth ramps:
//   temperature  trees need Tgs > ~6.4 degC and a season > ~94 days: the global treeline isotherm
//                (Koerner & Paulsen 2004). Grasses and alpine herbs go higher, to Tgs ~2-3 degC and
//                ~40 days (the alpine-nival transition).
//   water        trees need a moister root zone than grasses (Wi ramps 0.30-0.75 vs 0.06-0.45),
//                which puts the lower treeline of dry country where rain rises and evaporation
//                falls with elevation. North faces get less sun, less PET and later snowmelt, so
//                in deserts they are greener; near the upper treeline their shorter, colder season
//                pushes the trees lower.
//   soil         trees need rooting depth (~0.5 m), grasses a few cm; bare rock supports lichens only.
//   channels     standing or flowing water deeper than ~0.1-0.5 m keeps beds bare (scour, drowning),
//                while the banks, fed by groundwater and springs, become green riparian corridors.
//
// Dynamics (exact for any time step, so the same at 1 day/s and 1000 yr/s):
//   growth toward capacity is logistic with a seed-rain term, solved analytically:
//     dX/dt = r (X + s)(1 - (X + s)/(K + s))
//     grasses r = 1.2/yr, s = 0.04 (seed bank, resprouting): recover in 2-5 years after fire
//     trees   r = 0.03-0.15/yr depending on warmth and water, s = 0.003 + seed from woody
//             neighbours within ~40 m: canopy closure in ~30 yr in the wet Pacific NW, 60-150 yr
//             in dry or subalpine forest (Turner et al. 1997 Yellowstone; Agee 1993).
//   die-back above capacity is exponential: trees 0.25/yr (drought mortality; Breshears et al. 2005
//   pinon die-off of 40-80 % in two years), grasses 1.5/yr (they brown and die back within a season).
//   burial and stripping kill cover at a rate set by the sediment added (or soil removed) over about
//   the last year: grasses under 5-40 cm of new sediment, trees under 0.3-1.5 m.
//
// Feedbacks into the other modules (see column.js, erosion.js, freezethaw.js, groundwater.js):
//   infiltration x(0.5 + 1.5 V)(1 - 0.7 B); ET x(0.35 + 0.85 V) from the groundwater store (logged as
//   evaporation, so the water balance stays exact); soil detachment x exp(-3.5 V); creep x(1 - 0.5 V);
//   angle of repose + root cohesion; frost cycles x(1 - 0.5 V); chemical weathering x(1 + 2 V);
//   faster deposition (sediment trapping) x(1 + 1.5 V).
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const VEG_PARAMS = {
  burnTau: 1.5,       // yr, e-folding of post-fire water repellency and loose ash
  rGrass: 1.2,        // 1/yr
  seedGrass: 0.04,
  dieGrass: 1.5,      // 1/yr
  dieTree: 0.25,      // 1/yr
  greenDays: 12,      // phenology response time (days)
};

// WGSL float literal
const fx = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

const VEG_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> veg : array<f32>;
@group(0) @binding(2) var<storage, read_write> eco : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> clim : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> soil : array<f32>;
@group(0) @binding(5) var<storage, read> bedrock : array<f32>;
@group(0) @binding(6) var<storage, read> water : array<f32>;
@group(0) @binding(7) var<storage, read> groundwater : array<f32>;
@group(0) @binding(8) var<storage, read> temp : array<f32>;
@group(0) @binding(9) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(10) var<storage, read_write> scratch : array<vec2<f32>>;
@group(0) @binding(11) var<storage, read> spring : array<f32>;
@group(0) @binding(12) var<storage, read_write> rip : array<f32>;

// logistic growth with seed rain s toward K, exact over t; exponential die-back when above K
fn grow(v : f32, K : f32, r : f32, s : f32, die : f32, t : f32) -> f32 {
  if (v > K) { return K + (v - K) * exp(-die * t); }
  let u0 = v + s;
  let Kp = K + s;
  let u = Kp / (1.0 + (Kp / u0 - 1.0) * exp(-r * t));
  return clamp(u - s, 0.0, K);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let spin = P.spinup > 0.5;
  let yrs = max(P.vegYrs, 0.0);
  let c = clim[3u * i + 1u];     // last complete year (see column.js)
  let Wi0 = select(0.0, clamp(c.x / c.y, 0.0, 1.0), c.y > 1e-9);
  let Lgs = c.z * 365.0;
  let Tgs = select(-20.0, c.w / c.z, c.z > 1e-4);
  // Riparian water access: phreatophytes (willow, cottonwood, alder) root into the water table beside
  // streams and springs, so they stay green whatever the rain does. Streams or springs within 2 cells
  // (~20 m), remembered over ~2 years so ephemeral desert washes count too.
  var hN = 0.0; var sN = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let j = idxc(x + dx, y + dy);
      hN = max(hN, water[j]); sN = max(sN, spring[j]);
    }
  }
  let ripNow = max(smoothstep(0.01, 0.08, hN), smoothstep(3e-5, 1e-3, sN));
  let ripE = select(mix(rip[i], ripNow, 1.0 - exp(-yrs / 2.0)), ripNow, spin);
  rip[i] = clamp(finite(ripE), 0.0, 1.0);
  let Wi = max(Wi0, 0.8 * ripE);
  // --- carrying capacity
  let tT = smoothstep(4.8, 7.6, Tgs) * smoothstep(60.0, 100.0, Lgs);
  let tG = smoothstep(1.0, 4.0, Tgs) * smoothstep(20.0, 55.0, Lgs);
  let wT = smoothstep(0.18, 0.60, Wi);
  let wG = smoothstep(0.05, 0.70, Wi);
  let so = soil[i];
  let sT = 0.35 + 0.65 * smoothstep(0.05, 0.6, so);    // trees also root into fractured rock
  let sG = 0.45 + 0.55 * smoothstep(0.0, 0.12, so);    // grasses and shrubs take hold in thin regolith
  let h = water[i];
  let fl = 1.0 - smoothstep(0.08, 0.5, h);
  let KT = 0.92 * tT * wT * sT * fl;
  let KV = max(KT, tG * wG * sG * fl);

  let e = eco[i];
  var V = clamp(finite(veg[i]), 0.0, 1.0);
  var T = clamp(finite(e.x), 0.0, V);
  var G = V - T;
  var B = finite(e.y);
  let ground = bedrock[i] + so;
  if (spin) {
    // load-time spin-up: relax straight toward the equilibrium (iterated with the column's climate)
    T = mix(T, KT, 0.6);
    G = mix(G, max(KV - T, 0.0), 0.6);
    scratch[i] = vec2<f32>(T + G, T);
    eco[i] = vec4<f32>(e.x, 0.0, 1.0, ground);
    return;
  }
  // --- burial and stripping. eco.w is a reference ground level that follows the real ground with
  // a 1-year lag, so (ground - ref) is the sediment piled on (or soil stripped off) within about the
  // last year, whatever the step length. Plants die at a RATE set by that depth, so the outcome is
  // the same at every speed: slow deposition is grown through, half a metre of mud in one flood kills
  // the grass within months and young trees over a year or two.
  let dz = (ground - e.w) * min(1.0, 1.0 / max(yrs, 1e-6));
  let dep = max(dz, 0.0);
  let ero = max(-dz, 0.0);
  let muT = 4.0 * max(smoothstep(0.3, 1.5, dep), smoothstep(0.2, 1.0, ero));
  let muG = 6.0 * max(smoothstep(0.05, 0.4, dep), smoothstep(0.08, 0.5, ero));
  T = T * exp(-muT * yrs);
  G = G * exp(-muG * yrs);
  let gRef = ground - (ground - e.w) * exp(-yrs);
  // --- seed sources: woody neighbours within ~40 m
  var nb = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398;
    let d = vec2<f32>(cos(a), sin(a));
    nb += eco[idxc(x + i32(round(d.x)), y + i32(round(d.y)))].x;
    nb += eco[idxc(x + i32(round(d.x * 4.0)), y + i32(round(d.y * 4.0)))].x;
  }
  nb = nb / 16.0;
  let rT = 0.03 + 0.12 * tT * wT;
  T = grow(T, KT, rT, 0.003 + 0.04 * nb, ${fx(VEG_PARAMS.dieTree)}, yrs);
  G = grow(G, max(KV - T, 0.0), ${fx(VEG_PARAMS.rGrass)}, ${fx(VEG_PARAMS.seedGrass)}, ${fx(VEG_PARAMS.dieGrass)}, yrs);
  B = B * exp(-yrs / ${fx(VEG_PARAMS.burnTau)});
  // --- greenness: leaves out when warm, snow-free and the root zone is moist; brown otherwise
  let f = clamp(groundwater[i] / (0.6 * gwCap(so)), 0.0, 1.0);
  let gi = smoothstep(0.0, 5.0, temp[i]) * smoothstep(0.08, 0.45, f) * select(1.0, 0.0, snowSWE[i] > 0.01);
  let green = mix(e.z, gi, 1.0 - exp(-yrs * 365.0 / ${fx(VEG_PARAMS.greenDays)}));
  scratch[i] = vec2<f32>(finite(T + G), finite(T));
  eco[i] = vec4<f32>(e.x, clamp(B, 0.0, 1.0), clamp(finite(green), 0.0, 1.0), gRef);
}
`;

const COMMIT_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> veg : array<f32>;
@group(0) @binding(2) var<storage, read_write> eco : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> scratch : array<vec2<f32>>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let s = scratch[i];
  veg[i] = clamp(s.x, 0.0, 1.0);
  var e = eco[i];
  e.x = clamp(s.y, 0.0, 1.0);
  eco[i] = e;
}
`;

class VegetationModule {
  constructor() { this.name = 'vegetation'; this.world = null; }
  init(device, world) {
    if (this.world === world && this.kg) return;
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kg = makeKernel(device, 'vegetation.grow', VEG_WGSL, ['r', 'rw', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'rw', 'r', 'rw']);
    this.kc = makeKernel(device, 'vegetation.commit', COMMIT_WGSL, ['rw', 'rw', 'r']);
    // thermalDelta is free scratch at this point of the batch (the thermal kernels are done with it)
    this.bg = this.kg.bind(prm, [B.veg, B.eco, B.clim, B.soil, B.bedrock, B.water, B.groundwater, B.temp, B.snowSWE, B.thermalDelta, B.spring, B.rip]);
    this.bc = this.kc.bind(prm, [B.veg, B.eco, B.thermalDelta]);
  }
  record(pass) {
    pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, this.world.N);
    pass.setPipeline(this.kc.pipeline); pass.setBindGroup(0, this.bc); dispatchGrid(pass, this.world.N);
  }
  // contract-style step (the scheduler records it into its batch pass instead)
  step(encoder) {
    const pass = encoder.beginComputePass({ label: 'vegetation' });
    this.record(pass);
    pass.end();
  }
}

export const vegetation = new VegetationModule();
export default vegetation;
