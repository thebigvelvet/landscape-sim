// Plants, burn scars and wildfire.
//
// Layers (world.js): veg (cover 0..1), burn (recent burn severity 0..1), plant = vec4(woody share of
// the cover, moisture memory, ground height at the last batch, active fire 0..1), fireNext (scratch).
//
// Each batch (Dcol climate days, exact at any speed):
//   1. fire  : race-free spread of active fire to neighbouring cells (reads plant.w of the
//              neighbours, writes fireNext). Spread needs fuel (cover), dry ground (moisture memory)
//              and no snow; it runs faster uphill and downwind.
//   2. grow  : the cover relaxes towards an equilibrium V* set by warmth, water, soil, slope and
//              standing water, with exact exponential integration over the batch:
//                 dV/dt = r (V* - V) - mu V      r = 0.35/yr growing, 0.8/yr dying back (drought)
//                 mu    = burial / stripping rate from the ground-height change since the last batch
//              Woody plants (trees, shrubs) follow their own, slower target W* (about 22 years).
//              Fire consumes cover and woody plants and leaves a burn scar that fades over ~3 years.
//              Also writes the contract layer `temp` (air temperature at the end of the batch).
//
// V* (all factors 0..1):
//   warmth  smoothstep(1, 7, Tw)      Tw = warmest-month mean air temperature at the cell
//   trees   smoothstep(8.5, 11.5, Tw)  -> a treeline near the 10 degC July isotherm
//   water   from the climate's aridity index P/PET (drought lowers it at once) and the moisture
//           memory (groundwater fill smoothed over ~1 year, kept by the column kernel), so hollows
//           and springs stay green in a desert and a drought browns the land over a year or two
//   soil    bare rock carries only lichens; slope: cliffs stay bare; channels and lakes stay bare
//
// Plants feed back on the rest of the model elsewhere: infiltration, transpiration and soil
// production (column.js / water.js / freezethaw.js), erodibility, transport capacity and creep
// (erosion.js). Groundwater capacity depends on soil depth (common.js gwCap).
//
// Fire spreads one cell-step per batch ("visual time"): a real wildfire runs its course within a
// day or two, which is a blink at every speed of the dial, so the front is animated over a few
// seconds instead. Its consequences (lost cover, burn scar, extra runoff and erosion, regrowth)
// all play out in simulated time.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';
import { CLIMATE_WGSL } from './climate.js';

export const VEG_PARAMS = {
  growRate: 0.35,      // 1/yr: grass and herbs reach ~70% of their target in 3.5 years
  dieRate: 0.8,        // 1/yr: die-back when conditions worsen (drought)
  woodyGrow: 0.045,    // 1/yr: trees take decades to come back
  woodyDie: 0.25,      // 1/yr
  burnFade: 3.0,       // years: e-folding time of a burn scar (ash, water-repellent soil)
  buryDepth: 0.25,     // m of fresh deposit that kills ~63% of the cover
  stripDepth: 0.15,    // m of ground stripped away that kills ~63% of the cover
};

const HASH_WGSL = /* wgsl */`
fn pcg(v : u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(i : u32, f : u32) -> f32 { return f32(pcg(i ^ pcg(f + 0x9e3779b9u)) & 0xffffffu) / 16777216.0; }
`;

const FIRE_WGSL = /* wgsl */`
${COMMON_WGSL}
${HASH_WGSL}
@group(0) @binding(1) var<storage, read> veg : array<f32>;
@group(0) @binding(2) var<storage, read> plant : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(4) var<storage, read> bedrock : array<f32>;
@group(0) @binding(5) var<storage, read> soil : array<f32>;
@group(0) @binding(6) var<storage, read_write> fireNext : array<f32>;
@group(0) @binding(7) var<storage, read> water : array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let pl = plant[i];
  let f = pl.w;
  let v = veg[i];
  var fn_ = 0.0;
  if (f > 0.02) {
    // a burning cell keeps burning while it has fuel, then dies down (~60-120 batches: 1-2 s)
    fn_ = f * (0.955 + 0.04 * smoothstep(0.04, 0.35, v));
    if (fn_ < 0.03) { fn_ = 0.0; }
  } else if (P.fireWeather > 0.01) {
    let fuel = smoothstep(0.12, 0.6, v);
    let dry = clamp(1.25 - 1.4 * pl.y, 0.0, 1.0);
    let wet = (1.0 - smoothstep(0.005, 0.03, snowSWE[i])) * (1.0 - smoothstep(0.005, 0.05, water[i]));
    let k = fuel * dry * wet;
    if (k > 0.0) {
      let z = bedrock[i] + soil[i];
      var s = 0.0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) { continue; }
          let nx = x + dx; let ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
          let j = idx(nx, ny);
          let fj = plant[j].w;
          if (fj <= 0.02) { continue; }
          let diag = dx != 0 && dy != 0;
          let dist = P.cellSize * select(1.0, 1.41421356, diag);
          let dir = -vec2<f32>(f32(dx), f32(dy)) / select(1.0, 1.41421356, diag);   // travel direction j -> i
          let up = clamp((z - bedrock[j] - soil[j]) / dist, -1.0, 1.0);             // fire runs uphill
          let wind = dot(dir, vec2<f32>(P.windX, P.windY));
          s += fj * select(1.0, 0.7, diag) * max(0.15, 1.0 + 1.2 * up + 0.6 * wind);
        }
      }
      let p = P.fireWeather * 0.035 * s * k;               // front advances a few cells per second
      if (s > 0.0 && rnd(i, P.frame) < p) { fn_ = 0.95; }
    }
  }
  fireNext[i] = fn_;
}
`;

const GROW_WGSL = /* wgsl */`
${COMMON_WGSL}
${CLIMATE_WGSL}
@group(0) @binding(1) var<storage, read_write> veg : array<f32>;
@group(0) @binding(2) var<storage, read_write> burn : array<f32>;
@group(0) @binding(3) var<storage, read_write> plant : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> fireNext : array<f32>;
@group(0) @binding(5) var<storage, read> bedrock : array<f32>;
@group(0) @binding(6) var<storage, read> soil : array<f32>;
@group(0) @binding(7) var<storage, read> water : array<f32>;
@group(0) @binding(8) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(9) var<storage, read_write> temp : array<f32>;

fn H(x : i32, y : i32) -> f32 { let j = idxc(x, y); return bedrock[j] + soil[j]; }

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let so = soil[i];
  let z = bedrock[i] + so;
  let zAbs = z + P.datum;
  let gx = (H(x + 1, y) - H(x - 1, y)) / (2.0 * P.cellSize);
  let gy = (H(x, y + 1) - H(x, y - 1)) / (2.0 * P.cellSize);
  let slopeTan = length(vec2<f32>(gx, gy));
  let asp = clamp(-gy / 0.6, -1.0, 1.0);
  let aspT = select(1.5, 1.0, asp > 0.0) * asp;

  // ---- climate at this cell (annual) ----
  let Tm = P.tSea - P.lapse * zAbs * 0.001 + aspT;      // annual mean air temperature
  let Tw = Tm + P.tAmp;                                  // warmest-month mean
  var petSum = 0.0;                                      // PET of the soil-water model over a year
  for (var k = 0; k < 12; k++) {
    petSum += max(0.0, Tm + P.tAmp * cos(2.0 * PI * (f32(k) + 0.5) / 12.0) + 3.0);
  }
  let pet = 0.00018 * petSum / 12.0 * 365.0 * P.etMul + 0.02;
  let oro = clamp(1.0 + P.orog * (zAbs - P.zRef) * 0.001, 0.3, 2.5);
  let pAnn = P.pMean * 0.001 * 365.0 * oro;
  let ai = pAnn / pet;

  let pl = plant[i];
  let m = pl.y;
  let w = clamp(0.45 * min(ai, 1.5) + 0.6 * m, 0.0, 1.2);
  let fWarm = smoothstep(3.0, 9.5, Tw);                         // alpine tundra thins out above treeline
  let fTree = smoothstep(8.5, 11.5, Tw);
  let fWater = smoothstep(0.0, 0.8, w);
  let fSoil = 0.55 + 0.45 * smoothstep(0.02, 0.4, so);         // thin soil in rock cracks still carries plants
  let fSlope = 1.0 - 0.85 * smoothstep(1.5, 3.0, slopeTan);     // only cliffs stay bare
  let fWet = 1.0 - 0.9 * smoothstep(0.03, 0.3, water[i]);
  let fIce = 1.0 - smoothstep(1.0, 3.0, snowSWE[i]);
  let vStar = fWarm * fWater * fSoil * fSlope * fWet * fIce;
  // woody share: forest where warm and moist enough, shrubland where dry
  let forest = fTree * smoothstep(0.35, 0.8, w) * (0.35 + 0.65 * smoothstep(0.02, 0.4, so));
  let shrub = 0.55 * fWarm * (1.0 - smoothstep(0.25, 0.6, w)) * (0.4 + 0.6 * smoothstep(0.02, 0.3, so));
  let wStar = max(forest, shrub) * fSlope;

  var V = clamp(veg[i], 0.0, 1.0);
  var W = clamp(pl.x, 0.0, 1.0);
  var B = clamp(burn[i], 0.0, 1.0);
  let fire = fireNext[i];
  let t = max(P.D, 0.0) / 365.0;                         // years in this batch

  if (P.vegInit > 0.5) {
    V = vStar; W = wStar; B = 0.0;
    plant[i] = vec4<f32>(W, m, z, 0.0);
  } else {
    // burial by fresh deposits / stripping by erosion, as a mortality rate over the batch
    let dz = z - pl.z;
    let mu = (max(dz, 0.0) / ${'$'}{BURY} + max(-dz, 0.0) / ${'$'}{STRIP}) / max(t, 1e-6);
    B = B * exp(-t / ${'$'}{BURNFADE});
    if (fire > 0.02) {
      // the flames eat the cover and the trees; severity grows with the fuel that was there
      let fuel0 = V;
      V = V * exp(-0.06 * fire);
      W = W * exp(-0.08 * fire);
      B = max(B, clamp(fire * (0.35 + 0.65 * smoothstep(0.05, 0.6, fuel0)), 0.0, 1.0));
    }
    let r = select(${'$'}{DIE}, ${'$'}{GROW} * (0.3 + 0.7 * fWarm), V < vStar);
    let kk = r + mu;
    let vEq = r * vStar / max(kk, 1e-9);
    V = vEq + (V - vEq) * exp(-kk * t);
    let rw = select(${'$'}{WDIE}, ${'$'}{WGROW}, W < wStar);
    let kw = rw + mu;
    let wEq = rw * wStar / max(kw, 1e-9);
    W = wEq + (W - wEq) * exp(-kw * t);
    plant[i] = vec4<f32>(clamp(W, 0.0, 1.0), m, z, fire);
  }
  veg[i] = clamp(finite(V), 0.0, 1.0);
  burn[i] = clamp(finite(B), 0.0, 1.0);
  temp[i] = airTemp(P.dayStart + P.spanDays, zAbs) + aspT;
}
`;

// Brush ignition (immediate, also while paused). Own uniform block: centre, radius (cells), intensity.
const IGNITE_WGSL = /* wgsl */`
struct B { cx : f32, cy : f32, r : f32, a : f32, N : u32, p0 : u32, p1 : u32, p2 : u32 };
@group(0) @binding(0) var<uniform> U : B;
@group(0) @binding(1) var<storage, read> veg : array<f32>;
@group(0) @binding(2) var<storage, read_write> plant : array<vec4<f32>>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= i32(U.N) || y >= i32(U.N)) { return; }
  let d = length(vec2<f32>(f32(x), f32(y)) - vec2<f32>(U.cx, U.cy));
  if (d > U.r) { return; }
  let i = u32(y) * U.N + u32(x);
  let fuel = smoothstep(0.03, 0.25, veg[i]);
  let a = U.a * fuel * (1.0 - smoothstep(0.8 * U.r, U.r, d));
  var pl = plant[i];
  if (a > pl.w) { pl.w = min(a, 1.0); plant[i] = pl; }
}
`;

function fill(code) {
  const P = VEG_PARAMS;
  const f = (v) => v.toFixed(6);
  return code.replaceAll('${BURY}', f(P.buryDepth)).replaceAll('${STRIP}', f(P.stripDepth)).replaceAll('${BURNFADE}', f(P.burnFade))
    .replaceAll('${DIE}', f(P.dieRate)).replaceAll('${GROW}', f(P.growRate)).replaceAll('${WDIE}', f(P.woodyDie)).replaceAll('${WGROW}', f(P.woodyGrow));
}

class VegetationModule {
  constructor() { this.name = 'vegetation'; this.world = null; }

  init(device, world) {
    if (this.world === world && this.kf) return;
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.kf = makeKernel(device, 'veg.fire', FIRE_WGSL, ['r', 'r', 'r', 'r', 'r', 'rw', 'r']);
    this.kg = makeKernel(device, 'veg.grow', fill(GROW_WGSL), ['rw', 'rw', 'rw', 'r', 'r', 'r', 'r', 'r', 'rw']);
    this.ki = makeKernel(device, 'veg.ignite', IGNITE_WGSL, ['r', 'rw']);
    this.bf = this.kf.bind(prm, [B.veg, B.plant, B.snowSWE, B.bedrock, B.soil, B.fireNext, B.water]);
    this.bg = this.kg.bind(prm, [B.veg, B.burn, B.plant, B.fireNext, B.bedrock, B.soil, B.water, B.snowSWE, B.temp]);
    this.iub = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ignite' });
    this.bi = this.ki.bind(this.iub, [B.veg, B.plant]);
  }

  // fire spread then growth; recorded into the scheduler's batch pass (after erosion)
  record(pass) {
    const N = this.world.N;
    pass.setPipeline(this.kf.pipeline); pass.setBindGroup(0, this.bf); dispatchGrid(pass, N);
    pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, N);
  }

  // growth only (used with vegInit = 1 to set the cover to equilibrium after a load)
  recordGrow(pass) {
    pass.setPipeline(this.kg.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, this.world.N);
  }

  // Set fire to the plants inside a circle (cells). Applied at once, also while paused.
  ignite(x, y, r, intensity = 1) {
    const buf = new ArrayBuffer(32), f = new Float32Array(buf), u = new Uint32Array(buf);
    f[0] = x; f[1] = y; f[2] = r; f[3] = intensity; u[4] = this.world.N;
    this.device.queue.writeBuffer(this.iub, 0, buf);
    const enc = this.device.createCommandEncoder({ label: 'ignite' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.ki.pipeline); pass.setBindGroup(0, this.bi); dispatchGrid(pass, this.world.N);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  step(encoder) {
    const pass = encoder.beginComputePass({ label: 'vegetation' });
    this.record(pass);
    pass.end();
  }
}

export const vegetation = new VegetationModule();
export default vegetation;
