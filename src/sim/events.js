// Weather events painted onto the map (the brush tools).
//
// Every event is defined in SIMULATED time and is averaged over each batch exactly like the
// climate's "big storm" (Climate.stormFactor): a batch of D days that overlaps `c` days of the event
// gets the event's rate times c / D. A 3-day storm therefore drops 3 storm-days of water whether one
// frame spans an hour or 16 years, and all of it is counted as precipitation in the water balance.
//
//   Storm    local cloudburst over the brush circle: extra precipitation with a smooth bell profile,
//            80 mm/day at the centre (x intensity) for 3 days (default). It falls as rain or snow
//            depending on the air temperature, through the normal snow/soil model (column.js).
//   Drought  MAP-WIDE (a real drought covers hundreds of km, far more than this 5 km map). For
//            5 years (default) precipitation is cut to 30%, the air is 1.5 degC warmer and plants
//            and soil lose 30% more water to the air. Groundwater falls, plants brown and die back,
//            and dry vegetation burns more easily. Clicking anywhere starts it.
//   Flood    a "100-year flood" arriving from upstream: a flood wave enters the map at the clicked
//            spot as a triangular hydrograph peaking at 150 m3/s (x intensity) over 12 hours
//            (default), about 3.2 million m3. Think of the 100-year rainstorm falling on the
//            catchment upstream of the click (off the map) and all of it coming down this channel.
//            It is logged as precipitation. Water is added at every hydraulic sub-step so the wave
//            travels down the valley; the share the hydraulic solver cannot carry at high speed
//            (1 - fR, see scheduler.js) is logged as fast outflow like any other runoff.
//   Wildfire sets the plants inside the circle on fire (vegetation.ignite). Dry fuel nearby can
//            catch; the fire runs uphill and downwind for a few seconds, then dies down.
//   Volcano  opens a vent at the click: a year (default) of cinders building a cone and lava pouring
//            out at its foot (volcano.erupt, see sim/volcano.js). Intensity scales both.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const EVENT_DEFAULTS = {
  storm: { radius: 15, intensity: 1, days: 3, rate: 0.08 },          // m/day at the centre
  drought: { radius: 0, intensity: 1, days: 5 * 365, pMul: 0.3, etMul: 1.3, dT: 1.5 },
  flood: { radius: 4, intensity: 1, days: 0.5, peak: 150 },           // m3/s
  wildfire: { radius: 12, intensity: 1, days: 0 },
  volcano: { radius: 3, intensity: 1, days: 365 },
};
export const EVENT_TYPES = ['storm', 'drought', 'flood', 'wildfire', 'volcano'];

const FLOOD_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> water : array<f32>;
@group(0) @binding(2) var<storage, read_write> acc : array<vec4<f32>>;
fn inDisc(cx : f32, cy : f32, r : f32, p : vec2<f32>) -> bool {
  return r > 0.0 && length(p - vec2<f32>(cx, cy)) <= r;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let p = vec2<f32>(f32(x), f32(y));
  var d = 0.0;
  if (P.f0d > 0.0 && inDisc(P.f0x, P.f0y, P.f0r, p)) { d += P.f0d; }
  if (P.f1d > 0.0 && inDisc(P.f1x, P.f1y, P.f1r, p)) { d += P.f1d; }
  if (d <= 0.0) { return; }
  let i = idx(x, y);
  water[i] = water[i] + d;
  acc[i] = acc[i] + vec4<f32>(d, 0.0, 0.0, 0.0);
}
`;

function discCells(cx, cy, r, N) {
  let n = 0;
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) n++;
    }
  }
  return n;
}

// area under a triangular hydrograph (peak 1 at T/2, 0 at 0 and T) between t0 and t1, in units of T
function triArea(t0, t1, T) {
  const F = (t) => {
    const u = Math.min(Math.max(t / T, 0), 1);
    return u <= 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);   // cumulative fraction of the volume
  };
  return F(t1) - F(t0);
}

export class Events {
  constructor() {
    this.storms = [];      // {x, y, r, rate, days, left, id}
    this.floods = [];      // {x, y, r, volume, days, t, cells, id}
    this.drought = null;   // {days, left, pMul, etMul, dT}
    this.fireWeather = 0;
    this.wind = [1, 0];
    this.prevailing = null;   // the prevailing wind (blowing toward, grid units) when wind is on
    this.seq = 0;
    this.log = [];         // recent events for the renderer / UI: {type, x, y, r, t0 (performance.now()), id, ...}
    this.fastFlood = 0;    // m3 of flood water logged directly as precip + fast outflow (CPU, float64)
  }

  reset() {
    this.storms = []; this.floods = []; this.drought = null; this.fireWeather = 0; this.log = [];
  }

  init(device, world) {
    this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'events.flood', FLOOD_WGSL, ['rw', 'rw']);
    this.bgs = [this.k.bind(world.params.buffer, [B.water, B.acc]), this.k.bind(world.params.buffer, [B.water2, B.acc])];
    if (!world.substepHooks.includes(this.hook)) {
      this.hook = (pass, parity) => {
        if (!this.floodOn) return;
        pass.setPipeline(this.k.pipeline); pass.setBindGroup(0, this.bgs[parity]); dispatchGrid(pass, world.N);
      };
      world.substepHooks.push(this.hook);
    }
  }

  get active() { return this.storms.length > 0 || this.floods.length > 0 || !!this.drought || this.fireWeather > 0.02 || !!this.volcano?.erupting; }
  droughtInfo() { return this.drought ? { yearsLeft: this.drought.left / 365, years: this.drought.days / 365 } : null; }

  // Fraction of the batch [0, D) covered by an event with `left` days remaining.
  static cover(left, D) { return D > 0 ? Math.min(Math.max(left, 0), D) / D : 0; }

  /** Climate multipliers for the batch (drought). */
  climateMods(D) {
    const d = this.drought;
    if (!d) return { pMul: 1, etMul: 1, dT: 0 };
    const c = Events.cover(d.left, D);
    return { pMul: 1 - (1 - d.pMul) * c, etMul: 1 + (d.etMul - 1) * c, dT: d.dT * c };
  }

  /**
   * Uniform fields for one batch. D: climate days of the batch, n: hydraulic sub-steps,
   * fR: routed fraction of runoff (scheduler). Returns { fields, fastFloodM3 }.
   */
  uniforms(D, n, fR, cellArea) {
    if (this.prevailing) this.wind = [...this.prevailing];
    const u = { fireWeather: this.fireWeather, windX: this.wind[0], windY: this.wind[1] };
    for (let k = 0; k < 4; k++) {
      const s = this.storms[k];
      const a = s ? s.rate * Events.cover(s.left, D) : 0;
      Object.assign(u, { [`s${k}x`]: s?.x ?? 0, [`s${k}y`]: s?.y ?? 0, [`s${k}r`]: s?.r ?? 0, [`s${k}a`]: a });
    }
    let fast = 0;
    this.floodOn = false;
    for (let k = 0; k < 2; k++) {
      const f = this.floods[k];
      let d = 0;
      if (f && D > 0) {
        const vol = f.volume * triArea(f.t, f.t + D, f.days);   // m3 entering during this batch
        const routed = vol * fR;
        fast += vol - routed;
        d = routed / (n * f.cells * cellArea);                  // depth per cell per sub-step
        if (d > 0) this.floodOn = true;
      }
      Object.assign(u, { [`f${k}x`]: f?.x ?? 0, [`f${k}y`]: f?.y ?? 0, [`f${k}r`]: f?.r ?? 0, [`f${k}d`]: d });
    }
    return { fields: u, fastFloodM3: fast };
  }

  /** Advance event clocks by one batch of D days. */
  consume(D) {
    for (const s of this.storms) s.left -= D;
    this.storms = this.storms.filter((s) => s.left > 1e-9);
    for (const f of this.floods) f.t += D;
    this.floods = this.floods.filter((f) => f.t < f.days - 1e-9);
    if (this.drought) { this.drought.left -= D; if (this.drought.left <= 1e-9) this.drought = null; }
    this.fireWeather = this.fireWeather > 0.02 ? this.fireWeather * 0.996 : 0;   // fire weather fades over ~10 s
  }

  /**
   * Start an event. type: storm | drought | flood | wildfire (alias fire). x, y in grid cells.
   * Returns a description for the UI ({type, x, y, radius, title, text}).
   */
  add(type, o, ctx) {
    if (type === 'fire') type = 'wildfire';
    const def = EVENT_DEFAULTS[type];
    if (!def) throw new Error(`unknown brush type '${type}' (use ${EVENT_TYPES.join(', ')})`);
    const N = this.world.N;
    const x = Math.min(N - 1, Math.max(0, +o.x || 0)), y = Math.min(N - 1, Math.max(0, +o.y || 0));
    const r = Math.max(1, +(o.radius ?? def.radius) || def.radius);
    const I = Math.max(0.05, +(o.intensity ?? def.intensity) || def.intensity);
    const days = Math.max(0.01, +(o.days ?? def.days) || def.days || 0.01);
    const id = ++this.seq;
    const ev = { type, x, y, r, intensity: I, days, id, t0: performance.now() };
    if (type === 'storm') {
      if (this.storms.length >= 4) this.storms.shift();
      this.storms.push({ x, y, r, rate: def.rate * I, days, left: days, id });
      ev.centreMm = def.rate * I * days * 1000;
    } else if (type === 'drought') {
      this.drought = { days, left: days, pMul: Math.max(0, 1 - (1 - def.pMul) * Math.min(I, 1.4)), etMul: 1 + (def.etMul - 1) * I, dT: def.dT * I };
      this.fireWeather = Math.max(this.fireWeather, 0);   // drought dries the fuel (moisture memory) instead
    } else if (type === 'flood') {
      const rr = Math.max(6, Math.min(r, 14));          // spread the inflow so it does not pile up
      const cells = discCells(x, y, rr, N);
      const volume = 0.5 * def.peak * I * days * 86400;
      if (this.floods.length >= 2) this.floods.shift();
      this.floods.push({ x, y, r: rr, volume, days, t: 0, cells, id });
      ev.r = rr; ev.volume = volume; ev.peak = def.peak * I;
    } else if (type === 'wildfire') {
      ctx.vegetation.ignite(x, y, r, Math.min(1, I));
      this.fireWeather = Math.min(1.5, 0.8 + 0.4 * I);
      const a = Math.random() * Math.PI * 2;
      this.wind = this.prevailing ? [...this.prevailing] : [Math.cos(a), Math.sin(a)];
    } else if (type === 'volcano') {
      this.volcano = ctx.volcano;
      // the brush ring is the cone's footprint; the throat is a small share of it
      const e = ctx.volcano.erupt(x, y, { id, radius: def.radius, intensity: I, days: o.days ?? def.days }, ctx.readLayer);
      ev.r = Math.max(4, (1.25 * e.Hfinal / 0.58) / this.world.cellSize);
      ev.coneHeight = e.Hfinal; ev.cinders = e.cinders; ev.lava = e.lava; ev.days = e.days;
      ev.ready = e.ready;
    }
    this.log.push(ev);
    if (this.log.length > 24) this.log.shift();
    return ev;
  }

  /** Move an active storm (drag the brush). */
  moveStorm(id, x, y) {
    const s = this.storms.find((q) => q.id === id);
    if (s) { s.x = x; s.y = y; }
    const e = this.log.find((q) => q.id === id);
    if (e) { e.x = x; e.y = y; }
  }

  // Remaining simulated days of an event (for visuals); 0 when over.
  remaining(id) {
    const s = this.storms.find((q) => q.id === id); if (s) return s.left;
    const f = this.floods.find((q) => q.id === id); if (f) return f.days - f.t;
    if (this.volcano) return this.volcano.remaining(id);
    return 0;
  }
}
