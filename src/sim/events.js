// Weather event brushes: Storm, Drought, Flood and Wildfire, painted onto the map.
//
// Events are written into per-cell GPU state and then play out on simulation time, so they scale
// correctly with the speed dial:
//   Storm    evt.x += rate x days of extra precipitation (m), evt.y = rate (m/day). The column kernel
//            delivers min(remaining, rate x frameDays) each frame, as rain or snow by temperature.
//            A 3-day storm therefore drops 3 days of storm water whether a frame is 1 minute or
//            16 years long. Default 60 mm/day for 3 days (a big multi-day cloudburst; the
//            September 2013 Colorado Front Range storm dropped ~450 mm in 5 days).
//   Drought  REGIONAL: inside the circle (soft edge) precipitation is cut to 40 % and air is 1.5 degC
//            hotter (a "hot drought", Williams et al. 2013) for 5 years by default. Real droughts are
//            larger than the 5 km map; paint the biggest circle to cover all of it. evt.z = days left,
//            evt.w = precipitation factor; the column kernel averages it exactly over each frame.
//   Flood    a "100-year flood" at the clicked spot = a 100-year rainstorm over the WHOLE UPSTREAM
//            CATCHMENT of that spot (100 mm/day for 2 days, about the 100-year 2-day rainfall of the
//            Colorado foothills in NOAA Atlas 14). The click snaps to the largest stream within the
//            brush circle; the catchment is found on the CPU by steepest-descent (D8) routing.
//   Wildfire burns plants inside the circle and spreads into neighbouring cells that carry fuel and
//            are dry (it stops at bare rock, snow, streams and wet riparian ground). Severity grows
//            with woody fuel: crown fire in forest, a lighter burn in grass. Burned ground loses its
//            cover (erosion x30), repels water (infiltration -70 %) and has loose ash (pickup x3),
//            decaying over ~1.5 yr while grasses (2-5 yr) and trees (decades) regrow.
// All event water goes through the column kernel's precipitation, so the water balance stays exact.
import { makeKernel, dispatchGrid } from './common.js';

export const BRUSH_TYPES = { storm: 1, drought: 2, flood: 3, wildfire: 4, fire: 4 };
export const BRUSH_DEFAULTS = {
  storm: { radius: 40, intensity: 1, days: 3 },
  drought: { radius: 120, intensity: 1, days: 5 * 365 },
  flood: { radius: 15, intensity: 1, days: 2 },
  wildfire: { radius: 30, intensity: 1, days: 0 },
};
const STORM_RATE = 0.06;   // m/day at intensity 1
const FLOOD_RATE = 0.10;   // m/day at intensity 1

const BRUSH_WGSL = /* wgsl */`
struct U { N : u32, kind : u32, iter : u32, seed : u32,
           cx : f32, cy : f32, r : f32, intensity : f32,
           days : f32, rate : f32, maxIter : f32, pad : f32 };
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read_write> veg : array<f32>;
@group(0) @binding(2) var<storage, read_write> eco : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> evt : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> fire : array<f32>;
@group(0) @binding(5) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(6) var<storage, read> groundwater : array<f32>;
@group(0) @binding(7) var<storage, read> soil : array<f32>;
@group(0) @binding(8) var<storage, read> gwMaxU : array<f32>;

fn idx(x : i32, y : i32) -> u32 { return u32(y) * u.N + u32(x); }
fn dist(x : i32, y : i32) -> f32 { return length(vec2<f32>(f32(x) - u.cx, f32(y) - u.cy)); }
fn weight(d : f32) -> f32 { return 1.0 - smoothstep(0.7 * u.r, u.r + 0.5, d); }
fn hash(a : u32) -> f32 {
  var h = a * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}
fn fuel(i : u32) -> f32 { return smoothstep(0.08, 0.5, veg[i]) * select(1.0, 0.0, snowSWE[i] > 0.01); }
fn dryness(i : u32) -> f32 {
  let cap = gwMaxU[0] * (0.2 + 0.8 * (1.0 - exp(-max(soil[i], 0.0) / 0.5)));
  let f = clamp(groundwater[i] / (0.6 * cap), 0.0, 1.0);
  return 1.0 - 0.85 * smoothstep(0.4, 0.95, f);
}

@compute @workgroup_size(16, 16)
fn paint(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(u.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let w = weight(dist(x, y));
  var ev = evt[i];
  if (u.kind == 1u && w > 0.0) {                       // storm
    ev.x += w * u.rate * u.days;
    ev.y = max(ev.y, w * u.rate);
  } else if (u.kind == 2u && w > 0.0) {                // drought
    let f = 1.0 - (1.0 - clamp(1.0 - 0.6 * u.intensity, 0.05, 1.0)) * w;
    ev.w = select(f, min(ev.w, f), ev.z > 0.0);
    ev.z = max(ev.z, u.days);
  } else if (u.kind == 3u) {                           // flood: catchment mask uploaded into fire[]
    let m = fire[i];
    if (m > 0.0) { ev.x += m * u.rate * u.days; ev.y = max(ev.y, m * u.rate); }
    fire[i] = 0.0;
  } else if (u.kind == 4u) {                           // wildfire ignition
    fire[i] = select(0.0, 1.0, w > 0.35 && fuel(i) > 0.05);
  }
  evt[i] = ev;
}

// one step of fire spread: an unburned cell catches from a neighbour that ignited in an EARLIER
// step (values 1..iter-1), so the result does not depend on thread order
@compute @workgroup_size(16, 16)
fn spread(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(u.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  if (fire[i] > 0.0 || dist(x, y) > 2.5 * u.r + 2.0) { return; }
  let k = f32(u.iter);
  var lit = 0.0;
  if (x > 0)     { let v = fire[i - 1u];  lit += select(0.0, 1.0, v > 0.0 && v < k); }
  if (x < N - 1) { let v = fire[i + 1u];  lit += select(0.0, 1.0, v > 0.0 && v < k); }
  if (y > 0)     { let v = fire[i - u.N]; lit += select(0.0, 1.0, v > 0.0 && v < k); }
  if (y < N - 1) { let v = fire[i + u.N]; lit += select(0.0, 1.0, v > 0.0 && v < k); }
  if (lit <= 0.0) { return; }
  let p = 1.0 - pow(1.0 - clamp(0.55 * u.intensity * fuel(i) * dryness(i), 0.0, 0.95), lit);
  if (hash(i * 9781u + u.iter * 6271u + u.seed) < p) { fire[i] = k; }
}

@compute @workgroup_size(16, 16)
fn burn(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(u.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  if (fire[i] <= 0.0) { return; }
  fire[i] = 0.0;
  var e = eco[i];
  let V = veg[i];
  let T = min(e.x, V);
  let G = V - T;
  // severity: crown fire where woody fuel dominates, lighter surface fire in grass
  let woody = select(0.0, T / V, V > 1e-4);
  let sev = clamp(u.intensity, 0.0, 1.0) * (0.45 + 0.55 * woody) * smoothstep(0.05, 0.35, V);
  let T2 = T * (1.0 - min(1.0, 1.1 * sev));
  let G2 = G * (1.0 - min(0.95, 1.4 * sev));
  veg[i] = T2 + G2;
  e.x = T2;
  e.y = max(e.y, sev);
  e.z = 0.0;
  eco[i] = e;
}
`;

export class Events {
  constructor(device) {
    this.device = device;
    this.world = null;
    this.active = [];   // for the HUD: { type, until (sim day) }
  }

  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }];
    const modes = ['storage', 'storage', 'storage', 'storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage'];
    modes.forEach((t, i) => entries.push({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: t } }));
    const layout = device.createBindGroupLayout({ label: 'brush', entries });
    const module = device.createShaderModule({ label: 'brush', code: BRUSH_WGSL });
    module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) if (m.type === 'error') console.error(`[brush] WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.pipes = {};
    for (const e of ['paint', 'spread', 'burn']) this.pipes[e] = device.createComputePipeline({ label: `brush.${e}`, layout: pl, compute: { module, entryPoint: e } });
    this.ubs = [];
    this.gwMaxBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.layout = layout;
    this.B = B;
    this.k = true;
  }

  _uniform(slot, v) {
    while (this.ubs.length <= slot) this.ubs.push(this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const ab = new ArrayBuffer(48), u = new Uint32Array(ab), f = new Float32Array(ab);
    u[0] = this.world.N; u[1] = v.kind; u[2] = v.iter || 0; u[3] = v.seed || 0;
    f[4] = v.cx; f[5] = v.cy; f[6] = v.r; f[7] = v.intensity;
    f[8] = v.days; f[9] = v.rate || 0; f[10] = v.maxIter || 0;
    this.device.queue.writeBuffer(this.ubs[slot], 0, ab);
    const B = this.B;
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [this.ubs[slot], B.veg, B.eco, B.evt, B.fire, B.snowSWE, B.groundwater, B.soil, this.gwMaxBuf].map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
  }

  /**
   * Apply a brush. type: storm | drought | flood | wildfire. x, y, radius in grid cells.
   * intensity: 1 = default strength. days: event duration (storm/flood days, drought days).
   */
  async brush(sim, type, opts = {}) {
    const name = String(type).toLowerCase();
    const kind = BRUSH_TYPES[name];
    if (!kind) throw new Error(`unknown brush "${type}" (storm, drought, flood, wildfire)`);
    const key = kind === 4 ? 'wildfire' : name;
    const def = BRUSH_DEFAULTS[key];
    const N = this.world.N;
    const cx = Math.max(0, Math.min(N - 1, +(opts.x ?? N / 2)));
    const cy = Math.max(0, Math.min(N - 1, +(opts.y ?? N / 2)));
    const r = Math.max(1, +(opts.radius ?? def.radius));
    const intensity = Math.max(0, +(opts.intensity ?? def.intensity));
    const days = Math.max(0, +(opts.days ?? def.days));
    const dev = this.device;
    dev.queue.writeBuffer(this.gwMaxBuf, 0, new Float32Array([sim.climate.preset.gwMax, 0, 0, 0]));
    const seed = (Math.random() * 1e9) >>> 0;
    const info = { type: key, x: cx, y: cy, radius: r, intensity, days };
    const run = (entry, bg) => {
      const enc = dev.createCommandEncoder({ label: 'brush' });
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipes[entry]); pass.setBindGroup(0, bg); dispatchGrid(pass, N);
      pass.end();
      dev.queue.submit([enc.finish()]);
    };
    if (kind === 1) {
      run('paint', this._uniform(0, { kind, cx, cy, r, intensity, days, rate: STORM_RATE * intensity }));
      info.waterPerCell_m = STORM_RATE * intensity * days;
    } else if (kind === 2) {
      run('paint', this._uniform(0, { kind, cx, cy, r, intensity, days }));
      info.precipFactor = Math.max(0.05, 1 - 0.6 * intensity);
    } else if (kind === 3) {
      const f = await this._catchment(sim, cx, cy, r);
      dev.queue.writeBuffer(this.world.buffers.fire, 0, f.mask);
      run('paint', this._uniform(0, { kind, cx, cy, r, intensity, days, rate: FLOOD_RATE * intensity }));
      Object.assign(info, { outletX: f.x, outletY: f.y, catchmentCells: f.cells, catchmentKm2: f.cells * sim.cellSize ** 2 / 1e6 });
    } else {
      run('paint', this._uniform(0, { kind, cx, cy, r, intensity, days }));
      const iters = Math.round(Math.min(80, Math.max(8, r * 1.2)) * Math.min(1.5, intensity));
      for (let k = 2; k <= iters + 1; k++) run('spread', this._uniform(1 + (k % 2), { kind, cx, cy, r, intensity, days, iter: k, seed }));
      run('burn', this._uniform(0, { kind, cx, cy, r, intensity, days }));
      info.spreadSteps = iters;
    }
    if (days > 0 && kind !== 4) this.active.push({ type: key, until: sim.day + days });
    if (kind === 4) this.active.push({ type: key, until: sim.day + 3 });
    this.active = this.active.filter((e) => e.until > sim.day);
    return info;
  }

  activeAt(day) { this.active = this.active.filter((e) => e.until > day); return this.active; }

  // Upstream catchment of the stream nearest (cx, cy): D8 steepest descent on the current ground.
  async _catchment(sim, cx, cy, r) {
    const N = this.world.N;
    const [br, so] = await Promise.all([sim.readLayer('bedrock'), sim.readLayer('soil')]);
    const z = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) z[i] = br[i] + so[i];
    const rcv = new Int32Array(N * N).fill(-1);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let best = 0, bj = -1;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        const s = (z[i] - z[j]) / (k < 4 ? 1 : Math.SQRT2);
        if (s > best) { best = s; bj = j; }
      }
      rcv[i] = bj;
    }
    // flow accumulation: visit cells from high to low
    const order = new Uint32Array(N * N);
    for (let i = 0; i < N * N; i++) order[i] = i;
    order.sort((a, b) => z[b] - z[a]);
    const accu = new Float32Array(N * N).fill(1);
    for (let k = 0; k < N * N; k++) { const i = order[k]; if (rcv[i] >= 0) accu[rcv[i]] += accu[i]; }
    // snap to the biggest stream within the brush circle
    let o = Math.round(cy) * N + Math.round(cx), bestA = 0;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.round(cx) + dx, y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const i = y * N + x;
      if (accu[i] > bestA) { bestA = accu[i]; o = i; }
    }
    // donors lists -> upstream set by walking up from the outlet
    const head = new Int32Array(N * N).fill(-1), next = new Int32Array(N * N).fill(-1);
    for (let i = 0; i < N * N; i++) { const j = rcv[i]; if (j >= 0) { next[i] = head[j]; head[j] = i; } }
    const mask = new Float32Array(N * N);
    const stack = [o];
    mask[o] = 1;
    let cells = 0;
    while (stack.length) {
      const i = stack.pop();
      cells++;
      for (let d = head[i]; d >= 0; d = next[d]) { if (!mask[d]) { mask[d] = 1; stack.push(d); } }
    }
    return { mask, cells, x: o % N, y: Math.floor(o / N) };
  }
}
