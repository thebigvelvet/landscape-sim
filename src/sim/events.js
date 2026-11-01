// Weather events painted onto the map (round 2): Storm, Drought, Flood and Wildfire.
//
// Physical meaning (see README "Weather event brushes"):
//   Storm    a cloudburst over the brushed circle for `days` (default 3): extra precipitation of
//            max(40 mm/day, 15x the place's mean) x intensity, falling as rain or snow by the
//            temperature of each cell. It enters the column kernel's day-by-day integration exactly
//            like ordinary precipitation, so it infiltrates, runs off, builds snow, etc.
//   Drought  MAP-WIDE (a real drought is hundreds of km across, far bigger than the map): for
//            `days` (default 5 years) rain and snow are cut to 30 % and evaporation demand rises
//            25 %. Groundwater falls, the plants' growing-season soil moisture drops, plants brown
//            (drought stress) and die back toward the lower carrying capacity, then recover.
//   Flood    a "100-year flood" surge: 150 m3/s x intensity of water pours into the brushed spot
//            for `days` (default 0.5 = 12 hours; 3.2 million m3), like a big upstream flood wave
//            entering the valley. It is added to the surface exactly like runoff.
//   Wildfire burns the vegetation in the circle immediately (severity follows the fuel) and then
//            spreads into neighbouring cells as site percolation: probability rises with fuel,
//            dryness (low growing-season moisture) and uphill slope, so it races through dry
//            forest and stops at wet valleys, bare rock and sparse desert. Burned ground sheds
//            more water (infiltration down up to 70 %) and erodes up to 5x faster until plants
//            regrow; burn severity fades over ~3 years.
//
// Speed dial: the scheduler SPLITS any batch at the moment an event starts or ends (see
// Simulation._advance), so within every batch an event is either fully on or fully off. A 3-day
// storm brushed at 1000 years/s becomes one 3-day batch at full storm intensity followed by the rest
// of the frame, so it delivers 3 days of storm rain at every speed. Event water is logged as
// precipitation input in the flux log, so the water books stay exact.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const EVENT_TYPES = { storm: 1, drought: 2, flood: 3, wildfire: 4 };
export const EVENT_NAMES = { 1: 'storm', 2: 'drought', 3: 'flood', 4: 'wildfire' };
export const MAX_LOCAL_EVENTS = 8;
export const EVENT_DEFAULTS = {
  storm: { days: 3, intensity: 1, minDays: 0.1, maxDays: 30 },
  drought: { days: 5 * 365, intensity: 1, minDays: 30, maxDays: 30 * 365 },
  flood: { days: 0.5, intensity: 1, minDays: 0.05, maxDays: 10 },
  wildfire: { days: 0, intensity: 1 },
};
export const FLOOD_Q = 150;           // m3/s at intensity 1
export const DROUGHT_PRECIP = 0.3;    // precipitation multiplier at intensity 1
export const DROUGHT_ET = 1.25;       // evaporation demand multiplier at intensity 1

// Soft-edged circle used by every brush (GPU and CPU agree on this formula).
export function maskJS(d, r) { return Math.min(1, Math.max(0, (r - d) / Math.max(0.3 * r, 1))); }

export const EVENTS_WGSL = /* wgsl */`
struct EvU { n : vec4<u32>, e : array<vec4<f32>, 16> };
fn evMask(x : i32, y : i32, c : vec4<f32>) -> f32 {
  let d = length(vec2<f32>(f32(x), f32(y)) - c.xy);
  return clamp((c.z - d) / max(0.3 * c.z, 1.0), 0.0, 1.0);
}
// (extra precipitation m/day, surface inflow m/day) from the storms and floods active this batch
fn eventRates(x : i32, y : i32) -> vec2<f32> {
  var r = vec2<f32>(0.0);
  let n = min(EV.n.x, 8u);
  for (var k = 0u; k < n; k++) {
    let a = EV.e[2u * k];
    let t = EV.e[2u * k + 1u].x;
    let m = evMask(x, y, a);
    if (t == 1.0) { r.x += a.w * m; } else if (t == 3.0) { r.y += a.w * m; }
  }
  return r;
}
`;

// ---------------- wildfire kernels ----------------
const FIRE_WGSL = /* wgsl */`
${COMMON_WGSL}
struct FireU { cx : f32, cy : f32, r : f32, intensity : f32, maxR : f32, seed : u32, spread : f32, pad : f32 };
@group(0) @binding(1) var<storage, read_write> fire : array<f32>;     // flags A [0, N*N), B [N*N, 2N*N)
@group(0) @binding(2) var<storage, read_write> veg : array<f32>;
@group(0) @binding(3) var<storage, read_write> burn : array<f32>;
@group(0) @binding(4) var<storage, read> vegAux : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> bedrock : array<f32>;
@group(0) @binding(6) var<storage, read> soil : array<f32>;
@group(0) @binding(7) var<uniform> F : FireU;

fn hashU(i : u32, s : u32) -> f32 {
  var h = i * 747796405u + s * 2891336453u + 12345u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}
fn fuel(v : f32) -> f32 { return smoothstep(0.02, 0.35, v); }
fn dryness(i : u32) -> f32 { return clamp(1.25 - 1.5 * vegAux[i].x, 0.0, 1.0); }
fn burnCell(i : u32, s : f32) {
  burn[i] = max(burn[i], s);
  veg[i] = veg[i] * (1.0 - 0.95 * s);
}

@compute @workgroup_size(16, 16)
fn ignite(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let d = length(vec2<f32>(f32(x), f32(y)) - vec2<f32>(F.cx, F.cy));
  let m = clamp((F.r - d) / max(0.3 * F.r, 1.0), 0.0, 1.0);
  let s = clamp(F.intensity * m * fuel(veg[i]), 0.0, 1.0);
  var flag = 0.0;
  if (s > 0.05) { burnCell(i, s); flag = 1.0; }
  fire[i] = flag;
  fire[i + P.N * P.N] = 0.0;
}

fn spreadStep(x : i32, y : i32, src : u32, dst : u32) {
  let N = i32(P.N);
  let i = idx(x, y);
  let a = fire[src + i];
  if (a >= 1.0) { fire[dst + i] = 2.0; return; }
  var nFront = 0.0;
  var zLow = 1e30;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let nx = x + dx; let ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) { continue; }
      let j = idx(nx, ny);
      if (fire[src + j] == 1.0) { nFront += 1.0; zLow = min(zLow, bedrock[j] + soil[j]); }
    }
  }
  var flag = 0.0;
  let d = length(vec2<f32>(f32(x), f32(y)) - vec2<f32>(F.cx, F.cy));
  let v = veg[i];
  if (nFront > 0.0 && d < F.maxR && v > 0.05 && F.spread > 0.5) {
    let dry = dryness(i);
    // fire runs uphill: preheating of the fuel above the flames
    let up = clamp((bedrock[i] + soil[i] - zLow) / P.cellSize, 0.0, 1.0);
    let p1 = clamp(0.6 * fuel(v) * dry * (1.0 + 1.5 * up), 0.0, 0.95);
    let p = 1.0 - pow(1.0 - p1, nFront);
    if (hashU(i, F.seed) < p) {
      burnCell(i, clamp(F.intensity * fuel(v) * (0.5 + 0.5 * dry), 0.0, 1.0));
      flag = 1.0;
    }
  }
  fire[dst + i] = flag;
}
@compute @workgroup_size(16, 16)
fn spreadAB(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (i32(gid.x) >= i32(P.N) || i32(gid.y) >= i32(P.N)) { return; }
  spreadStep(i32(gid.x), i32(gid.y), 0u, P.N * P.N);
}
@compute @workgroup_size(16, 16)
fn spreadBA(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (i32(gid.x) >= i32(P.N) || i32(gid.y) >= i32(P.N)) { return; }
  spreadStep(i32(gid.x), i32(gid.y), P.N * P.N, 0u);
}
`;

export const FIRE_SPREAD_ITERS = 48;

export class Events {
  constructor() {
    this.list = [];
    this.nextId = 1;
    this.fireSeed = 1;
    this.u32 = new Uint32Array(4 + 16 * 4);
    this.f32 = new Float32Array(this.u32.buffer);
  }

  init(device, world) {
    this.device = device; this.world = world;
    if (!world.eventsBuffer) world.eventsBuffer = device.createBuffer({ size: this.u32.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'events' });
    this.fireU = this.fireU || device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'fireU' });
    const B = world.buffers, prm = world.params.buffer;
    const bind = ['rw', 'rw', 'rw', 'r', 'r', 'r', 'u'];
    this.kIgnite = makeKernel(device, 'fire.ignite', FIRE_WGSL, bind, 'ignite');
    this.kAB = makeKernel(device, 'fire.spreadAB', FIRE_WGSL, bind, 'spreadAB');
    this.kBA = makeKernel(device, 'fire.spreadBA', FIRE_WGSL, bind, 'spreadBA');
    const bufs = [B.fire, B.veg, B.burn, B.vegAux, B.bedrock, B.soil, this.fireU];
    this.bgIgnite = this.kIgnite.bind(prm, bufs);
    this.bgAB = this.kAB.bind(prm, bufs);
    this.bgBA = this.kBA.bind(prm, bufs);
    this.clear();
  }

  clear() { this.list = []; this.fireSeed = 1; this.writeUniform(); }

  /** Days until the next event starts or ends inside (0, D), sorted; used to split batches. */
  boundaries(D) {
    const out = [];
    for (const e of this.list) if (e.daysLeft > 1e-9 && e.daysLeft < D - 1e-9) out.push(e.daysLeft);
    return out.sort((a, b) => a - b);
  }

  get drought() { return this.list.find((e) => e.type === EVENT_TYPES.drought && e.daysLeft > 1e-9) || null; }

  /** Climate multipliers for the batch (map-wide drought). */
  climateFactors() {
    const d = this.drought;
    if (!d) return { precip: 1, et: 1 };
    const k = Math.min(1, Math.max(0, d.intensity));
    return { precip: 1 - (1 - DROUGHT_PRECIP) * k, et: 1 + (DROUGHT_ET - 1) * k };
  }

  /** Upload the storms and floods that are active (for the whole of) the next batch. */
  writeUniform() {
    const local = this.list.filter((e) => (e.type === EVENT_TYPES.storm || e.type === EVENT_TYPES.flood) && e.daysLeft > 1e-9).slice(-MAX_LOCAL_EVENTS);
    this.u32.fill(0);
    this.u32[0] = local.length;
    local.forEach((e, k) => {
      const o = 4 + k * 8;
      this.f32[o] = e.x; this.f32[o + 1] = e.y; this.f32[o + 2] = e.r; this.f32[o + 3] = e.rate;
      this.f32[o + 4] = e.type;
    });
    if (this.world?.eventsBuffer) this.device.queue.writeBuffer(this.world.eventsBuffer, 0, this.u32);
  }

  consume(D) {
    for (const e of this.list) e.daysLeft = Math.max(0, e.daysLeft - D);
    // remove finished events (tiny f64 residues are treated as finished)
    this.list = this.list.filter((e) => e.daysLeft > 1e-9);
  }

  /** Normalised flood inflow: Q m3/s spread over the brush footprint -> m/day per unit mask. */
  floodRate(x, y, r, Q) {
    const N = this.world.N, A = this.world.cellSize ** 2;
    let w = 0;
    const R = Math.ceil(r) + 1;
    for (let j = Math.max(0, Math.floor(y - R)); j <= Math.min(N - 1, Math.ceil(y + R)); j++) {
      for (let i = Math.max(0, Math.floor(x - R)); i <= Math.min(N - 1, Math.ceil(x + R)); i++) {
        w += maskJS(Math.hypot(i - x, j - y), r);
      }
    }
    return w > 0 ? (Q * 86400) / (w * A) : 0;
  }

  /**
   * Add an event. Coordinates in grid cells. Returns the event record (or null).
   * opts: { x, y, radius (cells), intensity, days, rate (storm m/day), spread (wildfire) }
   */
  add(type, opts, ctx) {
    const t = typeof type === 'number' ? type : EVENT_TYPES[String(type).toLowerCase()];
    if (!t) throw new Error(`unknown brush "${type}" (storm, drought, flood, wildfire)`);
    const name = EVENT_NAMES[t];
    const def = EVENT_DEFAULTS[name];
    const N = this.world.N;
    const num = (v, d) => (Number.isFinite(+v) ? +v : d);
    const x = Math.min(N - 1, Math.max(0, num(opts.x, N / 2)));
    const y = Math.min(N - 1, Math.max(0, num(opts.y, N / 2)));
    const r = Math.min(N, Math.max(1, num(opts.radius, 20)));
    const intensity = Math.min(5, Math.max(0, num(opts.intensity, def.intensity)));
    const id = this.nextId++;
    if (t === EVENT_TYPES.wildfire) {
      this.ignite(x, y, r, Math.min(1, intensity), opts.spread !== false);
      return { id, type: name, x, y, r, intensity, days: 0 };
    }
    const days = Math.min(def.maxDays, Math.max(def.minDays, num(opts.days, def.days)));
    const e = { id, type: t, name, x, y, r, intensity, days, daysLeft: days, startDay: ctx?.day ?? 0 };
    if (t === EVENT_TYPES.storm) {
      e.rate = num(opts.rate, intensity * Math.max(0.040, 15 * (ctx?.pMean ?? 2) * 0.001));   // m/day
    } else if (t === EVENT_TYPES.flood) {
      e.Q = FLOOD_Q * intensity;
      e.rate = this.floodRate(x, y, r, e.Q);
    } else if (t === EVENT_TYPES.drought) {
      // one map-wide drought at a time: a new click restarts it with the new length
      this.list = this.list.filter((o) => o.type !== EVENT_TYPES.drought);
      e.x = N / 2; e.y = N / 2; e.r = N;
    }
    this.list.push(e);
    // keep at most MAX_LOCAL_EVENTS storms/floods: drop the oldest
    const local = this.list.filter((o) => o.type !== EVENT_TYPES.drought);
    if (local.length > MAX_LOCAL_EVENTS) { const drop = local[0]; this.list = this.list.filter((o) => o !== drop); }
    return { id, type: name, x: e.x, y: e.y, r: e.r, intensity, days, rate: e.rate };
  }

  /** Move a running storm/flood (dragging steers it). */
  move(id, x, y) {
    const e = this.list.find((o) => o.id === id);
    if (!e || e.type === EVENT_TYPES.drought) return;
    const N = this.world.N;
    e.x = Math.min(N - 1, Math.max(0, x)); e.y = Math.min(N - 1, Math.max(0, y));
    if (e.type === EVENT_TYPES.flood) e.rate = this.floodRate(e.x, e.y, e.r, e.Q);
  }

  /** Burn the circle now and let the fire spread (instantaneous: the same at every speed). */
  ignite(x, y, r, intensity, spread = true) {
    const dev = this.device, N = this.world.N;
    const u = new ArrayBuffer(32), f = new Float32Array(u), w = new Uint32Array(u);
    f[0] = x; f[1] = y; f[2] = r; f[3] = intensity; f[4] = r + FIRE_SPREAD_ITERS; w[5] = this.fireSeed++ * 7919; f[6] = spread ? 1 : 0;
    dev.queue.writeBuffer(this.fireU, 0, u);
    const enc = dev.createCommandEncoder({ label: 'wildfire' });
    const pass = enc.beginComputePass({ label: 'wildfire' });
    pass.setPipeline(this.kIgnite.pipeline); pass.setBindGroup(0, this.bgIgnite); dispatchGrid(pass, N);
    if (spread) {
      for (let k = 0; k < FIRE_SPREAD_ITERS; k++) {
        const ab = (k & 1) === 0;
        pass.setPipeline(ab ? this.kAB.pipeline : this.kBA.pipeline);
        pass.setBindGroup(0, ab ? this.bgAB : this.bgBA);
        dispatchGrid(pass, N);
      }
    }
    pass.end();
    dev.queue.submit([enc.finish()]);
  }

  /** Plain-language status for the HUD. */
  describe() {
    const fmt = (d) => (d >= 365 * 1.5 ? `${(d / 365).toFixed(1)} years` : d >= 1.5 ? `${d.toFixed(1)} days` : `${Math.max(1, Math.round(d * 24))} hours`);
    return this.list.map((e) => {
      const what = e.type === EVENT_TYPES.storm ? 'Storm' : e.type === EVENT_TYPES.flood ? 'Flood surge' : 'Drought';
      return `${what}: ${fmt(e.daysLeft)} left`;
    });
  }
}
