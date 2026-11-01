// Erosion: capacity-based hydraulic erosion/deposition + thermal slumping (talus) + soil creep +
// rock fall on over-steep cliffs.
//
// Hydraulic part (runs as a water sub-step hook, once per hydraulic sub-step):
//   capacity C = kc * |v| * max(sin(slope), minSlope) * min(h, 1.5) * shallowLimiter(h) * MORPH
//   if C > s : erode  e = ks*dt*(C - s)  (soil first, then bedrock at kRock efficiency)
//   else     : deposit d = kd*dt*(s - C)
//   |e|, |d| <= dzMax per sub-step and e <= 0.5*sin(slope)*dx (morphological CFL: no cell moves more
//   than dzMax, and no cell can be dug below its downhill neighbour in one step)
//   Sediment is stored as BED-EQUIVALENT volume (MORFAC formulation): bed and sediment exchange the
//   same amount, so solids are exactly conserved even when the morphological factor changes with the
//   speed dial. MORPH = (climate time represented) / (hydraulic time simulated x routing intensity).
//
// Thermal part (once per frame, gather formulation so it is race-free and exactly conservative):
//   For each 8-neighbour pair the flux from the higher cell is
//     F = thermalRate/2 * max(0, dz - tan(talus)*dist) + creepFrac*(dx/dist)^2 * dz
//   limited to 0.12*dz (explicit-diffusion stability for 8 neighbours) and to soil/8.5 of the donor.
//   Bedrock steeper than rockTan converts to soil (rock fall) at rockRate per frame.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const EROSION_PARAMS = {
  kc: 0.001,         // capacity coefficient (dimensionless concentration per (m/s))
  ks: 0.03,         // 1/s pickup rate
  kd: 0.06,         // 1/s settling rate
  kRock: 0.12,      // bedrock erodibility relative to soil
  minSlope: 0.004,
  talusTan: 0.75,   // ~37 degrees angle of repose for loose soil/talus
  rockTan: 2.2,     // ~65 degrees: steeper rock fails
  creepK: 0.01,     // m^2/yr soil creep diffusivity
  rockFallPerYear: 0.002,
};

const EXCHANGE_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> water : array<f32>;
@group(0) @binding(2) var<storage, read> velX : array<f32>;
@group(0) @binding(3) var<storage, read> velY : array<f32>;
@group(0) @binding(4) var<storage, read> slope : array<f32>;
@group(0) @binding(5) var<storage, read_write> sediment : array<f32>;
@group(0) @binding(6) var<storage, read_write> soil : array<f32>;
@group(0) @binding(7) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(8) var<storage, read> veg : array<f32>;
@group(0) @binding(9) var<storage, read> eco : array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let h = water[i];
  var s = sediment[i];
  var so = soil[i];
  if (h < P.hDry) {                      // dry cell: everything settles
    if (s > 0.0) { soil[i] = so + s; sediment[i] = 0.0; }
    return;
  }
  let sp = length(vec2<f32>(velX[i], velY[i]));
  let sRaw = slope[i];
  let S = max(sRaw, P.minSlope);
  let lim = smoothstep(0.0005, 0.03, h);          // thin sheet flow carries little
  let conc = min(P.kc * sp * S, 0.25);
  let C = conc * min(h, 1.5) * lim * P.morph;     // bed-equivalent capacity (m)
  // Plants: ground cover and roots cut soil detachment roughly exponentially with cover,
  // E/E0 = exp(-b C%) with b ~ 0.035-0.05 per % (Gyssels et al. 2005), i.e. ~3 % of bare at full
  // cover. Deep, fast channel flow rips through it. A fresh burn (ash, no litter, dead roots) adds
  // up to 3x on top of the lost cover: together 30-100x more erosion on a burned slope, the range
  // measured after severe fires (Moody & Martin 2001; Shakesby & Doerr 2006).
  let V = clamp(veg[i], 0.0, 1.0);
  let burn = eco[i].y;
  let protect = mix(exp(-3.0 * V), 1.0, smoothstep(0.4, 2.0, h));
  if (C > s) {
    // local-relief limit: a sub-step can never dig a cell more than ~half the drop to its
    // downhill neighbour, so pits cannot self-deepen (second half of the morphological CFL)
    // burned ground: loose ash and dead roots are picked up faster (bounded by the same CFL limits);
    // cover protection applies after the limits so it always counts, at any speed
    let e = min(min(min(P.ks * P.dtH * (1.0 + 1.5 * burn), 0.5) * (C - s), P.dzMax), 0.5 * sRaw * P.cellSize) * protect;
    let fromSoil = min(e, so);
    let rest = e - fromSoil;
    var br = bedrock[i];
    if (rest > 0.0) {
      let nb = br - rest * P.kRock;
      let actual = br - nb;             // exact f32 change -> exact conservation
      bedrock[i] = nb;
      s = s + actual;
    }
    so = so - fromSoil;
    s = s + fromSoil;
  } else {
    // vegetation slows sheet flow and traps sediment (grass filter strips): faster settling
    let d = min(min(P.kd * P.dtH * (1.0 + 1.5 * V), 0.5) * (s - C), P.dzMax);
    so = so + d;
    s = s - d;
  }
  soil[i] = so;
  sediment[i] = s;
}
`;

const THERMAL_GATHER_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> delta : array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> veg : array<f32>;
@group(0) @binding(5) var<storage, read> eco : array<vec4<f32>>;

// Every pair flux uses the DONOR cell's soil and plants, so both cells compute the same number
// (exact conservation). Tree roots add cohesion (2-15 kPa, Schmidt et al. 2001): forested soil
// stands ~10 degrees steeper before it slumps. Cover slows creep (no rain-splash or frost heave).
fn pairFlux(dz : f32, dist : f32, donorSoil : f32, donorVeg : f32, donorWoody : f32) -> f32 {
  let excess = dz - (P.talusTan + 0.35 * donorWoody) * dist;
  let r = P.cellSize / dist;
  var F = 0.5 * P.thermalRate * max(excess, 0.0) + P.creepFrac * (1.0 - 0.5 * donorVeg) * r * r * dz;
  F = min(F, 0.12 * dz);
  return min(F, donorSoil / 8.5);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let so = soil[i];
  let z = bedrock[i] + so;
  let vi = veg[i]; let wi = eco[i].x;
  var net = 0.0;
  var rockEx = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let nx = x + dx; let ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
      let j = idx(nx, ny);
      let sn = soil[j];
      let dz = z - (bedrock[j] + sn);
      let dist = P.cellSize * select(1.0, 1.41421356, dx != 0 && dy != 0);
      if (dz > 0.0) {
        net -= pairFlux(dz, dist, so, vi, wi);
        rockEx = max(rockEx, dz - P.rockTan * dist);
      } else if (dz < 0.0) {
        net += pairFlux(-dz, dist, sn, veg[j], eco[j].x);
      }
    }
  }
  let rock = min(P.rockRate, 0.5) * max(rockEx, 0.0);
  delta[i] = vec2<f32>(net, rock);
}
`;

const THERMAL_APPLY_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read> delta : array<vec2<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let d = delta[i];
  var so = soil[i] + d.x;
  if (d.y > 0.0) {
    let br = bedrock[i];
    let nb = br - d.y;
    bedrock[i] = nb;
    so = so + (br - nb);
  }
  soil[i] = max(so, 0.0);
}
`;

class ErosionModule {
  constructor() { this.name = 'erosion'; this.enabled = true; }

  init(device, world) {
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kx = makeKernel(device, 'erosion.exchange', EXCHANGE_WGSL, ['r', 'r', 'r', 'r', 'rw', 'rw', 'rw', 'r', 'r']);
    this.kg = makeKernel(device, 'erosion.thermalGather', THERMAL_GATHER_WGSL, ['r', 'r', 'rw', 'r', 'r']);
    this.ka = makeKernel(device, 'erosion.thermalApply', THERMAL_APPLY_WGSL, ['rw', 'rw', 'r']);
    const W = [B.water, B.water2], S = [B.sediment, B.sediment2];
    this.xBG = [0, 1].map((p) => this.kx.bind(prm, [W[p], B.velX, B.velY, B.slope, S[p], B.soil, B.bedrock, B.veg, B.eco]));
    this.gBG = this.kg.bind(prm, [B.bedrock, B.soil, B.thermalDelta, B.veg, B.eco]);
    this.aBG = this.ka.bind(prm, [B.bedrock, B.soil, B.thermalDelta]);
    // register the per-sub-step exchange with the water module's hydraulic loop
    const hooks = world.substepHooks || (world.substepHooks = []);
    this.hook = (pass, parity) => {
      if (!this.enabled) return;
      pass.setPipeline(this.kx.pipeline); pass.setBindGroup(0, this.xBG[parity]); dispatchGrid(pass, world.N);
    };
    hooks.push(this.hook);
  }

  recordThermal(pass) {
    const N = this.world.N;
    pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.gBG); dispatchGrid(pass, N);
    pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.aBG); dispatchGrid(pass, N);
  }

  // Contract step: the slow, once-per-frame part (thermal). The hydraulic exchange runs inside
  // water.step's sub-step loop via the registered hook.
  step(encoder) {
    const pass = encoder.beginComputePass({ label: 'erosion.thermal' });
    this.recordThermal(pass);
    pass.end();
  }
}

export const erosion = new ErosionModule();
export default erosion;
