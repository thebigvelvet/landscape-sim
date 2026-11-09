// Snow: accumulation when cold, positive-degree-day melt with a diurnal cycle, sublimation, and
// avalanches.
//
// The per-day physics lives in SNOW_WGSL and is executed inside the fused column kernel
// (column.js) so snow, frozen ground and infiltration see each other every sub-day. `step()`
// encodes that column kernel (deduplicated per frame, so calling snow.step and freezethaw.step
// in the same frame dispatches it once).
//
// Avalanches (once per batch, after the column has added the new snow): snow slides off slopes
// where the SNOW SURFACE (ground + snow depth, depth = SWE / 0.33) is steeper than ~38 degrees and
// piles up at the foot. Same race-free gather/apply form as the talus kernel in erosion.js: every
// 8-neighbour pair moves an antisymmetric amount, so snow is exactly conserved (the water balance
// does not change). A few iterations per batch let it run several cells down a gully.
// Where a lot of snow runs through a cell, trees are knocked down (the woody share of the cover,
// plant.x, shrinks); over decades this keeps open avalanche chutes through the forest.
import { column } from './column.js';
import { COMMON_WGSL, QUAKE_WGSL, makeKernel, dispatchGrid } from './common.js';

export const SNOW_PARAMS = {
  ddf: 0.0045,      // m water / (degC day)  (4.5 mm/degC/day, typical for open snow)
  sublim: 0.0002,   // m/day sublimation while T < 0
  avalTan: Math.tan((38 * Math.PI) / 180),   // snow surfaces steeper than this release
  avalKill: 2.0,    // tree loss per metre of snow (water equivalent) running out of a cell
};
export const AVAL_ITERS = 4;

export const SNOW_WGSL = /* wgsl */`
// Expected positive part of temperature over a day with uniform diurnal range dtr.
fn pdd(T : f32) -> f32 {
  let a = max(0.5 * P.dtr, 0.1);
  if (T - a >= 0.0) { return T; }
  if (T + a <= 0.0) { return 0.0; }
  return (T + a) * (T + a) / (4.0 * a);
}
// returns (newSWE, liquid water released = rain + melt, sublimation loss)   all in metres
// sunF scales melt by how much sun the slope gets (enhanced temperature index, Hock 1999):
// ~0.5 on steep north faces, ~1.5 on steep south faces, 1 on flat ground.
fn snowStep(swe : f32, T : f32, precip : f32, dt : f32, sunF : f32) -> vec3<f32> {
  let sf = clamp((1.5 - T) / 3.0, 0.0, 1.0);          // rain/snow transition -1.5..+1.5 degC
  let snowfall = precip * sf;
  let rain = precip - snowfall;
  var s = swe + snowfall;
  let melt = min(s, P.ddf * sunF * pdd(T) * dt);
  s = s - melt;
  let sub = min(s, P.sublim * dt * select(0.0, 1.0, T < 0.0));
  s = s - sub;
  return vec3<f32>(s, rain + melt, sub);
}
`;

const SNOW_DEN = 0.33;   // snow density relative to water (also used by the renderer)

const AVAL_GATHER_WGSL = /* wgsl */`
${COMMON_WGSL}
${QUAKE_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(4) var<storage, read_write> delta : array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> glacier : array<vec4<f32>>;

// snow slides off steep glacier ice too (the ice is part of the surface)
fn surf(i : u32) -> f32 { return bedrock[i] + soil[i] + snowSWE[i] / ${SNOW_DEN} + glacier[i].x; }
// SWE moved from a to b (negative: b to a). Half the excess height above the release angle moves,
// at most 1/8.5 of the donor's snow per neighbour (so a cell can never give more than it has).
// Both cells of a pair evaluate the same expression, so the transfer is exactly antisymmetric.
fn tr(a : u32, b : u32, dist : f32, sh : f32) -> f32 {
  let d = surf(a) - surf(b);
  let T = P.avalTan * sh * dist;
  if (d > T) { return min(0.5 * (d - T) * ${SNOW_DEN}, snowSWE[a] / 8.5); }
  if (-d > T) { return -min(0.5 * (-d - T) * ${SNOW_DEN}, snowSWE[b] / 8.5); }
  return 0.0;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var net = 0.0;
  var out = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let nx = x + dx; let ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
      let dist = P.cellSize * select(1.0, 1.41421356, dx != 0 && dy != 0);
      // quake shaking (sim/quake.js) lowers the release angle; the pair mean keeps it antisymmetric
      let t = tr(i, idx(nx, ny), dist, 0.5 * (quakeShake(x, y) + quakeShake(nx, ny)));
      net -= t;
      out += max(t, 0.0);
    }
  }
  delta[i] = vec2<f32>(net, out);
}
`;

const AVAL_APPLY_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> snowSWE : array<f32>;
@group(0) @binding(2) var<storage, read> delta : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> plant : array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let d = delta[i];
  if (d.x == 0.0 && d.y == 0.0) { return; }
  snowSWE[i] = max(snowSWE[i] + d.x, 0.0);
  // snow running out of a cell flattens its trees; one avalanche season per simulated year, so a
  // batch that spans many years counts that many seasons
  if (d.y > 0.01) {                 // a real slide, not snow creeping a few mm
    var pl = plant[i];
    pl.x = pl.x * exp(-P.avalKill * d.y * max(1.0, P.D / 365.0));
    plant[i] = pl;
  }
}
`;

export const avalanche = {
  enabled: true,
  init(device, world) {
    this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kg = makeKernel(device, 'snow.avalGather', AVAL_GATHER_WGSL, ['r', 'r', 'r', 'rw', 'r']);
    this.ka = makeKernel(device, 'snow.avalApply', AVAL_APPLY_WGSL, ['rw', 'r', 'rw']);
    // thermalDelta is free scratch here: erosion's thermal step has already used it this batch
    this.gBG = this.kg.bind(prm, [B.bedrock, B.soil, B.snowSWE, B.thermalDelta, B.glacier]);
    this.aBG = this.ka.bind(prm, [B.snowSWE, B.thermalDelta, B.plant]);
  },
  record(pass) {
    if (!this.enabled) return;
    const N = this.world.N;
    for (let k = 0; k < AVAL_ITERS; k++) {
      pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.gBG); dispatchGrid(pass, N);
      pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.aBG); dispatchGrid(pass, N);
    }
  },
};

export default {
  name: 'snow',
  init(device, world) { column.init(device, world); },
  step(encoder, dtDays, climate) { column.step(encoder, dtDays, climate); },
};
