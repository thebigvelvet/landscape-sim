// Vegetation and burn scars (round 2).
//
// State: `veg` (cover 0..1), `burn` (recent burn severity 0..1), plus `vegAux` (W = growing-season
// soil moisture written by the column kernel, the infiltration multiplier, a copy of veg for the
// column kernel, and the ground height at the previous plant step for burial/stripping).
//
// Carrying capacity K (the cover the place can support) is a product of
//   warmth    smoothstep(vegTmin, vegTmin + 7, Tw), Tw = warmest-month mean air temperature of the
//             cell (lapse rate + sunny/shady aspect). This makes the treeline: cover fades out where
//             July averages below ~4-11 degC (about 3300-3700 m in the Colorado preset).
//   water     smoothstep(0.05, 0.6, W): W is how full the root zone is during the growing season
//             (mean of groundwater / half its capacity, weighted by warm days), integrated by the
//             column kernel, so it includes rain, snowmelt, groundwater flowing into hollows, ET,
//             droughts and the plants' own water use.
//   soil      0.15 + 0.85 smoothstep(0, 0.15 m, soil depth) (bare rock keeps only plants in cracks)
//   slope     1 - 0.85 smoothstep(0.9, 1.8, tan slope) (cliffs)
//
// Dynamics over a batch of D days, with K and the burial/stripping rate mu held constant:
//   below K:  dV/dt = r V (1 - V/K) - mu V             (logistic growth from a seed floor)
//   above K:  dV/dt = -m (V - K) - mu V                 (drought / cold dieback toward K)
//   mu = (deposition / 0.3 m + erosion / 0.6 m) / D     (buried by sediment, stripped by gullies)
// Both have closed-form solutions, used here, so the update is exact for any D: the result does not
// depend on the batch length, and 16-year frames at 1000 years/s are as stable as 1-minute frames.
// Burn severity decays as exp(-D / burnTau).
//
// Outputs for the other modules (each kernel stays within 8 storage bindings):
//   vegAux.y  infiltration multiplier (0.6 + 0.8 V)(1 - 0.7 burn)       -> column (soilStep)
//   vegAux.z  copy of V: transpiration 0.45 + 0.75 V, frost/chemical weathering -> column
//   erodMul   (1 - 0.65 V)(1 + 4 burn): hydraulic erosion capacity       -> erosion exchange
//   temp      air temperature at the end of the batch (moved here from the column kernel)
//   light[2i+1] = (V, burn, drought stress, Tw) for the renderer
// Creep under cover is slowed directly in erosion.js (thermal gather reads veg).
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';
import { CLIMATE_WGSL } from './climate.js';

export const VEG_PARAMS = {
  vegTmin: 4.0,          // degC warmest-month mean where cover starts (full at +7 degC above)
  vegR: 0.32 / 365,      // 1/day intrinsic growth rate in warm places (x0.25 at the treeline)
  vegM: 0.35 / 365,      // 1/day dieback rate toward K when above it (drought, cooling)
  burnTau: 3 * 365,      // days, e-folding time of burn severity (litter, water-repellent soil)
  vegSeed: 0.004,        // seed rain: minimum cover where K > 0.02
};

const VEG_WGSL = /* wgsl */`
${COMMON_WGSL}
${CLIMATE_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> veg : array<f32>;
@group(0) @binding(4) var<storage, read_write> burn : array<f32>;
@group(0) @binding(5) var<storage, read_write> vegAux : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> erodMul : array<f32>;
@group(0) @binding(7) var<storage, read_write> temp : array<f32>;
@group(0) @binding(8) var<storage, read_write> light : array<vec4<f32>>;

fn zAt(x : i32, y : i32) -> f32 { let j = idxc(x, y); return bedrock[j] + soil[j]; }

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let so = soil[i];
  let z = bedrock[i] + so;
  let zAbs = z + P.datum;
  let gx = (zAt(x + 1, y) - zAt(x - 1, y)) / (2.0 * P.cellSize);
  let gy = (zAt(x, y + 1) - zAt(x, y - 1)) / (2.0 * P.cellSize);
  let tanS = length(vec2<f32>(gx, gy));
  let asp = clamp(-gy / 0.6, -1.0, 1.0);
  let aspT = select(1.5, 1.0, asp > 0.0) * asp;
  temp[i] = airTemp(P.dayStart + P.spanDays, zAbs) + aspT;
  let Tw = P.tSea + P.tAmp - P.lapse * zAbs * 0.001 + aspT;      // warmest-month mean temperature
  var aux = vegAux[i];
  var V = veg[i];
  var B = burn[i];
  if (P.vegMode > 1.5) {                 // init (on load, before the spin-up)
    V = 0.0; B = 0.0; aux = vec4<f32>(0.5, 1.0, 0.0, z);
  }
  let Kw = smoothstep(P.vegTmin, P.vegTmin + 7.0, Tw);
  let Kwat = smoothstep(0.05, 0.6, aux.x);
  let Ks = 0.15 + 0.85 * smoothstep(0.0, 0.15, so);
  let Kl = 1.0 - 0.85 * smoothstep(0.9, 1.8, tanS);
  let K = clamp(Kw * Kwat * Ks * Kl, 0.0, 0.97);
  let D = P.vegD;
  if (P.vegMode < 0.5 && D > 0.0) {
    let dz = z - aux.w;
    let mu = (max(dz, 0.0) / 0.3 + max(-dz, 0.0) / 0.6) / D;
    let r = P.vegR * (0.25 + 0.75 * Kw);
    if (K > 0.02) { V = max(V, min(P.vegSeed, K)); }
    if (V <= K) {
      let a = r - mu;
      let b = r / max(K, 1e-3);
      let aD = clamp(a * D, -60.0, 60.0);
      if (abs(aD) < 1e-5) {
        V = V / (1.0 + b * V * D);
      } else {
        let E = exp(aD);
        V = a * V * E / (a + b * V * (E - 1.0));
      }
    } else {
      let k = P.vegM + mu;
      let Vinf = P.vegM * K / k;
      V = Vinf + (V - Vinf) * exp(-min(k * D, 60.0));
    }
    B = B * exp(-D / P.burnTau);
    aux.w = z;
  }
  V = clamp(finite(V), 0.0, 1.0);
  B = clamp(finite(B), 0.0, 1.0);
  let stress = clamp((V - K) / max(V, 0.02), 0.0, 1.0);
  veg[i] = V;
  burn[i] = B;
  vegAux[i] = vec4<f32>(aux.x, (0.6 + 0.8 * V) * (1.0 - 0.7 * B), V, aux.w);
  erodMul[i] = (1.0 - 0.65 * V) * (1.0 + 4.0 * B);
  light[2u * i + 1u] = vec4<f32>(V, B, stress, Tw);
}
`;

class VegetationModule {
  constructor() { this.name = 'vegetation'; this.world = null; }
  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'vegetation', VEG_WGSL, ['r', 'r', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw']);
    this.bg = this.k.bind(world.params.buffer, [B.bedrock, B.soil, B.veg, B.burn, B.vegAux, B.erodMul, B.temp, B.light]);
  }
  record(pass) {
    pass.setPipeline(this.k.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, this.world.N);
  }
  // contract-style step: plan.vegD (days) is set by the scheduler in the shared params block
  step(encoder) {
    const pass = encoder.beginComputePass({ label: 'vegetation' });
    this.record(pass);
    pass.end();
  }
  /** Recompute the derived fields (no time passes): after a wildfire or on load (mode 2 = init). */
  sync(mode = 1) {
    const p = this.world.params;
    const keep = { vegMode: p.values.vegMode ?? 0, vegD: p.values.vegD ?? 0 };
    p.set({ vegMode: mode, vegD: 0 });
    p.upload();
    const enc = this.device.createCommandEncoder({ label: 'veg.sync' });
    this.step(enc);
    this.device.queue.submit([enc.finish()]);
    p.set(keep);
  }
}

export const vegetation = new VegetationModule();
export default vegetation;
