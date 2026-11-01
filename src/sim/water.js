// Water: virtual-pipe shallow water (O'Brien & Hodgins / Mei et al. 2007) with Manning friction,
// open (free outflow) boundaries, and conservative upwind sediment transport.
//
// Per hydraulic sub-step (2 dispatches):
//   flux   : outflow pipes f(-x,+x,-y,+y) += dt*g*hp*dH (pipe area dx*hp), Manning damping, then scaled by K so a
//            cell never ships more water than it has (this is what keeps the scheme positive).
//            Also writes slope = sin(tilt) for erosion.
//   update : depth from net pipe flux (ping-pong water -> water2), velocity, and sediment moved
//            with the water: each outgoing pipe carries the same fraction of the cell's suspended
//            sediment as of its water. Exactly conservative; edge pipes are logged as outflow.
// Registered sub-step hooks (erosion exchange) run right after each update.
//
// The vertical water budget (infiltration, ET, groundwater, baseflow) is per-cell and lives in
// WATER_VERTICAL_WGSL, executed by the fused column kernel once per frame.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const WATER_PARAMS = {
  g: 9.81,
  manning: 0.045,
  kBase: 0.01,        // 1/day groundwater -> local baseflow (the rest moves downhill, see groundwater.js)
  eSurf: 6e-8,        // m/s open-water evaporation at ~20 degC (~5 mm/day)
  kTrans: 1.2e-7,     // m/s channel transmission loss into groundwater (~10 mm/day)
  hDry: 1e-4,         // m, below this a cell is considered dry for erosion
};

export const WATER_VERTICAL_WGSL = /* wgsl */`
// infiltration (capacity limited, frozen ground blocks it), ET from the shallow store, baseflow.
// returns (newGroundwater, runoff, evapotranspiration)
fn soilStep(gw : f32, liquid : f32, T : f32, frozen : f32, dt : f32) -> vec3<f32> {
  let space = max(P.gwMax - gw, 0.0);
  let infil = min(liquid, min(P.ksat * dt * (1.0 - 0.92 * frozen), space));
  var g = gw + infil;
  var runoff = liquid - infil;
  let pet = max(0.0, 0.00018 * (T + 3.0)) * P.etMul * dt;            // ~5 mm/day at 25 degC
  let et = min(g, pet * clamp(g / (0.6 * P.gwMax), 0.0, 1.0));
  g = g - et;
  let base = g * (1.0 - exp(-P.kBase * dt)) * (1.0 - 0.8 * frozen);
  g = g - base;
  runoff = runoff + base;
  return vec3<f32>(g, runoff, et);
}
`;

const FLUX_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read_write> flux : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> slope : array<f32>;
@group(0) @binding(6) var<storage, read> velX : array<f32>;
@group(0) @binding(7) var<storage, read> velY : array<f32>;
@group(0) @binding(8) var<storage, read> initHeight : array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let b = bedrock[i] + soil[i];
  let h = water[i];
  // Open boundary with a FIXED BASE LEVEL: outside the grid the ground stays at the edge cell's
  // initial height and holds no water. Water leaves freely while the edge is at/above base level;
  // an edge cell can never be incised below base level by its own outflow (no runaway).
  // dH = (b - bn) + (h - hn): split so millimetre water differences survive f32 at 3 km elevation.
  let dOut = b - initHeight[i];
  var db = vec4<f32>(dOut); var hn = vec4<f32>(0.0);
  if (x > 0)     { let j = i - 1u;  db.x = b - (bedrock[j] + soil[j]); hn.x = water[j]; }
  if (x < N - 1) { let j = i + 1u;  db.y = b - (bedrock[j] + soil[j]); hn.y = water[j]; }
  if (y > 0)     { let j = i - P.N; db.z = b - (bedrock[j] + soil[j]); hn.z = water[j]; }
  if (y < N - 1) { let j = i + P.N; db.w = b - (bedrock[j] + soil[j]); hn.w = water[j]; }

  // slope for erosion = steepest DESCENT from this cell (uses the cell's own height, unlike a
  // central difference). A pit has zero descent, so it cannot be scoured deeper: this removes the
  // checkerboard pit-digging instability of central-difference capacity models.
  let dmax = max(max(db.x, db.y), max(db.z, db.w));
  let gd = max(dmax, 0.0) / P.cellSize;
  slope[i] = gd / sqrt(1.0 + gd * gd);

  if (h <= 0.0) { flux[i] = vec4<f32>(0.0); return; }
  let dH = db + vec4<f32>(h) - hn;
  let sp = length(vec2<f32>(velX[i], velY[i]));
  let hf = max(h, 0.002);
  let fric = 1.0 / (1.0 + P.dtH * P.g * P.manning * P.manning * sp / pow(hf, 1.3333));
  // Pipe cross-section A = dx * hp, hp = mean depth of the two cells (upwind-ish), capped at
  // hCap = (0.5 dx/dt)^2 / g. With A = dx*h the scheme is a real shallow-water discretisation
  // (CFL = dt sqrt(g h)/dx); capping hp keeps the gravity-wave Courant number <= 0.5 even in deep
  // lakes, so lakes never develop the classic pipe-model checkerboard sloshing.
  let hCap = pow(0.5 * P.cellSize / P.dtH, 2.0) / P.g;
  let hp = min(0.5 * (vec4<f32>(h) + hn), vec4<f32>(hCap));
  var f = max(vec4<f32>(0.0), flux[i] * fric + (P.dtH * P.g) * hp * dH);
  let out = (f.x + f.y + f.z + f.w) * P.dtH;
  let vol = h * P.cellArea;
  if (out > vol) { f = f * (vol / out); }
  flux[i] = f;
}
`;

const UPDATE_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> wIn : array<f32>;
@group(0) @binding(2) var<storage, read_write> wOut : array<f32>;
@group(0) @binding(3) var<storage, read> sIn : array<f32>;
@group(0) @binding(4) var<storage, read_write> sOut : array<f32>;
@group(0) @binding(5) var<storage, read> flux : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> velX : array<f32>;
@group(0) @binding(7) var<storage, read_write> velY : array<f32>;
@group(0) @binding(8) var<storage, read_write> acc : array<vec4<f32>>;

// fraction of a cell's content that leaves through pipe flow q (m^3/s) this step
fn frac(q : f32, h : f32) -> f32 {
  if (h <= 1e-9) { return 0.0; }
  return min(1.0, q * P.dtH / (h * P.cellArea));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let h = wIn[i];
  let s = sIn[i];
  let f = flux[i];
  var inL = 0.0; var inR = 0.0; var inD = 0.0; var inU = 0.0;
  var sedIn = 0.0;
  if (x > 0)     { let j = i - 1u;  inL = flux[j].y; sedIn += sIn[j] * frac(inL, wIn[j]); }
  if (x < N - 1) { let j = i + 1u;  inR = flux[j].x; sedIn += sIn[j] * frac(inR, wIn[j]); }
  if (y > 0)     { let j = i - P.N; inD = flux[j].w; sedIn += sIn[j] * frac(inD, wIn[j]); }
  if (y < N - 1) { let j = i + P.N; inU = flux[j].z; sedIn += sIn[j] * frac(inU, wIn[j]); }
  let outQ = f.x + f.y + f.z + f.w;
  let hn = finite(max(0.0, h + P.dtH * ((inL + inR + inD + inU) - outQ) / P.cellArea));
  wOut[i] = hn;

  // velocity from the mean discharge through the cell
  let hAvg = 0.5 * (h + hn);
  var vel = vec2<f32>(0.0);
  if (hAvg > 1e-4) {
    let qx = 0.5 * (inL - f.x + f.y - inR);
    let qy = 0.5 * (inD - f.z + f.w - inU);
    vel = vec2<f32>(qx, qy) / (P.cellSize * hAvg);
    let m = length(vel);
    if (m > P.vMax) { vel = vel * (P.vMax / m); }
  }
  velX[i] = vel.x; velY[i] = vel.y;

  // conservative upwind sediment transport (bed-equivalent volume per cell, metres)
  let fo = frac(outQ, h);
  sOut[i] = finite(max(0.0, s * (1.0 - fo) + sedIn));

  // open boundary: log what leaves through edge pipes
  var edgeQ = 0.0;
  if (x == 0) { edgeQ += f.x; }
  if (x == N - 1) { edgeQ += f.y; }
  if (y == 0) { edgeQ += f.z; }
  if (y == N - 1) { edgeQ += f.w; }
  if (edgeQ > 0.0) {
    acc[i] = acc[i] + vec4<f32>(0.0, edgeQ * P.dtH / P.cellArea, 0.0, s * frac(edgeQ, h));
  }
}
`;

class WaterModule {
  constructor() { this.name = 'water'; this.hooks = []; }

  init(device, world) {
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    const kf = makeKernel(device, 'water.flux', FLUX_WGSL, ['r', 'r', 'r', 'rw', 'rw', 'r', 'r', 'r']);
    const ku = makeKernel(device, 'water.update', UPDATE_WGSL, ['r', 'rw', 'r', 'rw', 'r', 'rw', 'rw', 'rw']);
    this.kf = kf; this.ku = ku;
    // parity 0: water -> water2 ; parity 1: water2 -> water
    const W = [B.water, B.water2], S = [B.sediment, B.sediment2];
    this.fluxBG = [0, 1].map((p) => kf.bind(prm, [B.bedrock, B.soil, W[p], B.flux, B.slope, B.velX, B.velY, B.initHeight]));
    this.updBG = [0, 1].map((p) => ku.bind(prm, [W[p], W[1 - p], S[p], S[1 - p], B.flux, B.velX, B.velY, B.acc]));
    this.hooks = world.substepHooks || (world.substepHooks = []);
  }

  // Record nSub (forced even) hydraulic sub-steps into an open compute pass. After an even number
  // of swaps the canonical buffers (water, sediment) hold the result.
  record(pass, nSub) {
    const N = this.world.N;
    const n = Math.max(2, nSub + (nSub & 1));
    for (let k = 0; k < n; k++) {
      const p = k & 1;
      pass.setPipeline(this.kf.pipeline); pass.setBindGroup(0, this.fluxBG[p]); dispatchGrid(pass, N);
      pass.setPipeline(this.ku.pipeline); pass.setBindGroup(0, this.updBG[p]); dispatchGrid(pass, N);
      for (const h of this.hooks) h(pass, 1 - p);   // 1-p = parity of the buffer now holding the state
    }
    return n;
  }

  step(encoder, dtDays, climate) {
    const pass = encoder.beginComputePass({ label: 'water' });
    this.record(pass, climate?.plan?.nSub ?? 2);
    pass.end();
  }
}

export const water = new WaterModule();
export default water;
