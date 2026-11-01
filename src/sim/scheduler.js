// Multi-rate time stepping. See README "Time scaling" for the full derivation.
//
// Three clocks per frame (or per batch in sim.run):
//   Dcol  climate days integrated by the column kernel (snow, frost, soil water, weathering).
//         Pointwise ODEs are sub-cycled on the GPU at <= 1 day (<= 48 inner steps), and frames longer
//         than a year integrate one representative year scaled mass-consistently. Exact in time.
//   tau   hydraulic seconds simulated = nSub * dtH. dtH is CFL-limited from the observed max depth
//         (dtH <= 0.5 dx / sqrt(g h)); nSub is set by the GPU-time governor.
//   Deros climate days of landscape change. Fluvial erosion uses a morphological factor
//         MORPH = Deros*86400 / (aW * tau), where the hydraulic solver runs at a routing intensity aW
//         (runoff is injected aW times faster than real time, aW <= A_CAP) so channels carry
//         representative flows. Bed change per sub-step is capped (dzMax, morphological CFL).
//         Thermal/creep/rock-fall are integrated with Deros directly (unconditionally stable forms).
//
// Water accounting is exact at every speed: runoff that the routed solver cannot carry within the
// frame (fraction 1 - fR) is logged as fast outflow, everything else lives in surface water,
// snow or groundwater, or leaves through the open boundary / evaporation.
//
// Round 2: plants (vegetation.js) run once per batch after erosion, and weather events (events.js)
// are made speed-independent by splitting batches at event boundaries (_advance).
import { World, LOG_SIZE } from '../world.js';
import { ParamBlock } from './params.js';
import { Climate } from './climate.js';
import { generateTerrain } from '../terrain.js';
import water, { WATER_PARAMS } from './water.js';
import erosion, { EROSION_PARAMS } from './erosion.js';
import snow, { SNOW_PARAMS } from './snow.js';
import freezethaw, { FREEZETHAW_PARAMS } from './freezethaw.js';
import climateModule from './climate.js';
import { column } from './column.js';
import { groundwater, GROUNDWATER_PARAMS } from './groundwater.js';
import { Stats } from './stats.js';
import { vegetation, VEG_PARAMS } from './vegetation.js';
import { Events } from './events.js';
import { gwCapJS } from './common.js';

export const A_CAP = 150;              // max routing intensity (x real-time runoff rate)
export const MAX_DAYS_PER_FRAME = 365000 / 60;
const STROBE_DAYS_PER_FRAME = 20;     // above this, seasons are shown stroboscopically
const RUN_HYDRO_SUBSTEPS = 96000;    // hydraulic sub-steps per sim.run() (spread over the run)
const STROBE_PHASE_DAYS = 365 / 240;   // season advance per frame in strobe mode (one cycle / 4 s)

export class Simulation {
  constructor(device) {
    this.device = device;
    this.climate = new Climate();
    this.events = new Events();
    this.speed = 1;            // days per real second
    this.paused = false;
    this.erosionStrength = 1;
    this.nSub = 16;            // hydraulic sub-steps per frame (governor adjusts)
    this.maxSub = 64;
    this.world = null;
    this.modules = [climateModule, snow, freezethaw, groundwater, water, erosion, vegetation];
    this.day = 0;
    this.frame = 0;
    this.carry = 0;
    this.hmax = 0.3;
    this.cum = { precip: 0, outflow: 0, evap: 0, sedOut: 0 };
    this.consumed = 0;
    this._rb = Promise.resolve();
    this.lastPlan = {};
    this.running = false;
    this.loading = false;
    this.worldGen = 0;         // bumped whenever the terrain is replaced (stale async results check it)
    this.fps = 0;
  }

  get N() { return this.world?.N ?? 0; }

  async load(scenario = 'random', opts = {}) {
    const N = [256, 512, 1024, 2048].includes(+opts.size) ? +opts.size : (this.world?.N || 512);
    const cellSize = +opts.cellSize || this.cellSize || 10;
    const seed = Number.isFinite(+opts.seed) ? +opts.seed : 1;
    // Loading can be requested while a frame, a sim.run() or a stats readback is in flight: block new
    // batches and brushes, wait for any run() to stop, and drain the GPU before touching buffers.
    this.loading = true;
    this.worldGen++;
    try {
      this._abortRun = true;
      while (this.running) await new Promise((r) => setTimeout(r, 5));
      this._abortRun = false;
      if (opts.preset) this.climate.setPreset(opts.preset);
      this.scenario = scenario; this.seed = seed;
      this.ruggedness = opts.ruggedness ?? this.ruggedness ?? 0.5;
      this.relief = opts.relief ?? this.relief ?? 1;
      await this._rb.catch(() => {});
      await this.device.queue.onSubmittedWorkDone();
      if (!this.world || this.world.N !== N || this.cellSize !== cellSize) {
        this.statsK?.destroy();
        this.world?.eventsBuffer?.destroy();
        this.world?.destroy();
        this.world = new World(this.device, { N, cellSize });
        this.world.params = new ParamBlock(this.device);
        this.world.substepHooks = [];
        this.cellSize = cellSize;
        this.events.init(this.device, this.world);       // creates the events uniform used by column
        for (const m of [water, erosion]) m.init(this.device, this.world);
        column.init(this.device, this.world);
        groundwater.init(this.device, this.world);
        vegetation.init(this.device, this.world);
        this.statsK = new Stats(this.device, this.world);
        this.maxSub = N <= 256 ? 256 : N <= 512 ? 128 : 64;
        this.nSub = Math.min(this.nSub, this.maxSub);
        this.onWorldChanged?.(this.world);
      }
      this.events.clear();
      const { height, soil } = generateTerrain(scenario, { N, cellSize, seed, ruggedness: this.ruggedness, relief: this.relief, preErode: opts.preErode !== false });
      const bedrock = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) bedrock[i] = height[i] - soil[i];
      const gwMax = this.climate.preset.gwMax;
      const gw = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) gw[i] = 0.3 * gwCapJS(gwMax, soil[i]);
      this.world.upload({ bedrock, soil, groundwater: gw, initHeight: height });
      this.datum = this.climate.preset.baseElevation;
      let mn = Infinity, mx = -Infinity, sum = 0;
      for (let i = 0; i < N * N; i++) { const h = height[i]; if (h < mn) mn = h; if (h > mx) mx = h; sum += h; }
      this.terrainRange = { min: mn, max: mx, mean: sum / (N * N) };
      this.day = 0; this.frame = 0; this.carry = 0; this.hmax = 0.3; this.consumed = 0;
      this.climate.stormDaysLeft = 0;
      this.world.params.set({ N, cellSize, cellArea: cellSize * cellSize, frame: 0, logSize: LOG_SIZE });
      this.world.params.upload();
      // Plants start in equilibrium with the climate: a 400-year spin-up of the column (snow,
      // groundwater, soil moisture) and the plants only, with weathering, routing and erosion off,
      // so the terrain is unchanged. It ends on 1 January; then the clock and the books are reset.
      if (opts.spinUp !== false) this._spinUp(opts.spinYears ?? 400);
      await this.device.queue.onSubmittedWorkDone();
      await this._readback();
      this.day = 0; this.carry = 0;
      this.cum = { precip: 0, outflow: 0, evap: 0, sedOut: 0 };
      this.climate.resetWeather(seed);
      const s0 = await this._readback();
      this.stored0 = (s0.water + s0.snow + s0.groundwater) * this.world.cellSize ** 2;
    } finally {
      this.loading = false;
    }
    this.onLoaded?.();
    return { N, cellSize, scenario, seed };
  }

  _spinUp(years) {
    const plan = this._plan(1, 0, 2);
    this.world.params.set(plan);
    vegetation.sync(2);                                    // init: veg 0, W 0.5, zPrev = ground
    const D = 36500, n = Math.max(1, Math.round((years * 365) / D));
    for (let k = 0; k < n; k++) this._batch(D, 0, 2, false, true);
  }

  // Frame plan (one uniform block for every kernel) for a batch of Dcol climate days, Deros days of
  // landscape change and nSub hydraulic sub-steps.
  _plan(Dcol, Deros, nSub, spin = false) {
    const w = this.world, dx = w.cellSize;
    const n = Math.max(2, nSub + (nSub & 1));
    // Fixed hydraulic step: 0.2 dx seconds (2 s at 10 m). Velocity is capped at 0.5 dx/dt and the
    // pipe depth at (0.5 dx/dt)^2/g, so both the advective and gravity-wave Courant numbers stay
    // <= 0.5 for any water depth - stability needs no feedback from the (async) stats.
    const dtH = 0.2 * dx;
    const tau = n * dtH;
    const A = (Dcol * 86400) / tau;
    const aW = A > 0 ? Math.min(A, A_CAP) : 0;
    const fR = spin ? 0 : A > 0 ? aW / A : 1;
    const morph = aW > 0 ? Math.max(1, (Deros * 86400) / (aW * tau)) : 1;
    let span, dayStart, yrs;
    const doy = ((this.day % 365) + 365) % 365;
    if (Dcol >= 365) { span = 365; yrs = Dcol / 365; dayStart = (((this.day + Dcol - 365) % 365) + 365) % 365; }
    else { span = Dcol; yrs = 1; dayStart = doy; }
    const nInner = Math.min(48, Math.max(1, Math.ceil(span / 1.0)));
    const zRef = this.datum + (this.terrainRange?.mean ?? 0);
    const yearsE = Deros / 365;
    const cu = this.climate.uniforms(Dcol, zRef);
    const ev = this.events.climateFactors();             // map-wide drought
    cu.pMean *= ev.precip; cu.etMul *= ev.et;
    return {
      N: w.N, frame: this.frame, logSize: LOG_SIZE, nSub: n,
      cellSize: dx, cellArea: dx * dx, dtH, g: WATER_PARAMS.g,
      aW, fR, morph, D: Dcol, dayStart, spanDays: span, yrs, nInner, A, tau,
      ...cu,
      ...SNOW_PARAMS, ...FREEZETHAW_PARAMS,
      kBase: WATER_PARAMS.kBase, eSurf: WATER_PARAMS.eSurf, kTrans: WATER_PARAMS.kTrans, hDry: WATER_PARAMS.hDry,
      manning: WATER_PARAMS.manning, datum: this.datum,
      kGw: GROUNDWATER_PARAMS.kGw, gwPor: GROUNDWATER_PARAMS.gwPor, gwDt: Dcol * 86400,
      kc: EROSION_PARAMS.kc * this.erosionStrength, ks: EROSION_PARAMS.ks, kd: EROSION_PARAMS.kd, kRock: EROSION_PARAMS.kRock,
      minSlope: EROSION_PARAMS.minSlope, dzMax: 0.02 * dx, vMax: 0.5 * dx / dtH,
      talusTan: EROSION_PARAMS.talusTan, rockTan: EROSION_PARAMS.rockTan,
      thermalRate: 0.25 * Math.min(1, Deros / 0.25),
      creepFrac: Math.min(0.1, EROSION_PARAMS.creepK * this.erosionStrength * yearsE / (dx * dx)),
      rockRate: Math.min(0.4, EROSION_PARAMS.rockFallPerYear * yearsE),
      spin: spin ? 1 : 0, vegD: Dcol, vegMode: 0, etBoost: 1, ...VEG_PARAMS,
    };
  }

  // ---- one batch: column -> groundwater -> nSub x (flux, update, erosion) -> thermal -> plants -> accumulate ----
  // ts: timestamp writes for this pass (or undefined). spin: plant spin-up (no routing/erosion).
  _batch(Dcol, Deros, nSub, ts = undefined, spin = false) {
    const p = this.world.params;
    this.climate.advanceWeather(this.day, Dcol);
    const plan = this._plan(Dcol, Deros, nSub, spin);
    const n = plan.nSub;
    p.set(plan);
    p.upload();
    this.events.writeUniform();
    const climateObj = this.climate.produce((this.day + Dcol) % 365, plan.zRef, Dcol);
    const cf = this.events.climateFactors();
    climateObj.precipRate_mm_per_day *= cf.precip;
    climateObj.drought = cf.precip < 1;
    climateObj.plan = plan;
    const enc = this.device.createCommandEncoder({ label: 'sim' });
    const pass = enc.beginComputePass({ label: 'sim', timestampWrites: ts === true ? this.timer?.simPassTimestamps() : ts || undefined });
    column.record(pass);
    groundwater.record(pass);
    if (!spin) {
      water.record(pass, n);
      erosion.recordThermal(pass);
    }
    vegetation.record(pass);
    this.statsK.recordAccumulate(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.climate.consume(Dcol);
    this.events.consume(Dcol);
    this.day += Dcol;
    this.frame++;
    this.lastPlan = { ...plan, Deros, climate: climateObj };
    this.lastClimate = climateObj;
    return n;
  }

  // Advance Dcol climate days (Deros landscape days) with nSub hydraulic sub-steps, SPLITTING the
  // interval wherever a weather event (brush or "big storm") starts or ends, so every batch sees each
  // event either fully on or fully off. This is what makes events speed-independent: a 3-day storm
  // inside a 16-year frame is integrated as its own 3-day batch at full intensity. Sub-steps are
  // shared between the pieces, so the frame's GPU cost is unchanged.
  _advance(Dcol, Deros, nSub, timed = false) {
    const cuts = this.events.boundaries(Dcol);
    const sd = this.climate.stormDaysLeft;
    if (sd > 1e-9 && sd < Dcol - 1e-9) cuts.push(sd);
    const pts = [...new Set(cuts.map((c) => +c.toPrecision(12)))].sort((a, b) => a - b).filter((c) => c > 1e-9 && c < Dcol - 1e-9);
    if (!pts.length) return this._batch(Dcol, Deros, nSub, timed ? true : undefined);
    const segs = [];
    let t = 0;
    for (const c of pts) { segs.push(c - t); t = c; }
    segs.push(Dcol - t);
    const nEach = Math.max(2, Math.round(nSub / segs.length));
    const tsAll = timed ? this.timer?.simPassTimestamps() : undefined;
    let total = 0;
    segs.forEach((D, k) => {
      let ts;
      if (tsAll) {
        ts = { querySet: tsAll.querySet };
        if (k === 0) ts.beginningOfPassWriteIndex = tsAll.beginningOfPassWriteIndex;
        if (k === segs.length - 1) ts.endOfPassWriteIndex = tsAll.endOfPassWriteIndex;
      }
      total += this._batch(D, (Deros * D) / Dcol, nEach, ts);
    });
    return total;
  }

  // Interactive frame. realDt in seconds. Returns sub-steps run (0 if paused).
  tick(realDt) {
    if (!this.world || this.paused || this.running || this.loading) return 0;
    const dt = Math.min(Math.max(realDt, 0), 0.1);
    const target = Math.min(this.speed * dt, MAX_DAYS_PER_FRAME * 2);
    if (target <= 0) return 0;
    let Dcol;
    if (this.speed * dt > STROBE_DAYS_PER_FRAME) {
      // stroboscopic seasons: whole years + a small phase advance, so snow/season visuals cycle
      // smoothly (~4 s per year on screen) while time itself advances at the requested rate.
      this.carry += target;
      const d = Math.min(this.carry, STROBE_PHASE_DAYS);
      Dcol = d + 365 * Math.floor((this.carry - d) / 365);
      this.carry -= Dcol;
      this.strobe = true;
    } else {
      Dcol = target + this.carry; this.carry = 0; this.strobe = false;
    }
    if (Dcol <= 0) return 0;
    const n = this._advance(Dcol, target, this.nSub, true);
    if (this.frame % 30 === 0) this._readback();
    return n;
  }

  // Advance `days` as fast as possible (no wall-clock coupling). Resolves when the GPU is done.
  async run(days, opts = {}) {
    if (!this.world) throw new Error('load() first');
    if (this.loading) throw new Error('a new landscape is loading');
    this.running = true;
    try {
      let remaining = Math.max(0, +days || 0);
      const N = this.world.N;
      const nSub = opts.nSub || (N <= 256 ? 64 : N <= 512 ? 32 : N <= 1024 ? 16 : 8);
      // Batch length: enough batches that the hydraulic solver gets RUN_HYDRO_SUBSTEPS sub-steps in
      // total (flow networks need ~1e5 s of hydraulic time to establish on a 5 km domain), never more
      // than MAX_DAYS_PER_FRAME per batch, never less than ~1 hour of climate per batch.
      const Db = opts.batchDays || Math.min(MAX_DAYS_PER_FRAME, Math.max(days / Math.ceil(RUN_HYDRO_SUBSTEPS / nSub), Math.min(days, 0.05)));
      let k = 0;
      while (remaining > 1e-9 && !this._abortRun) {
        const D = Math.min(Db, remaining);
        this._advance(D, D, nSub);
        remaining -= D;
        k++;
        if (k % 6 === 0) await this.device.queue.onSubmittedWorkDone();
        if (k % 300 === 0) await this._readback();
      }
      await this.device.queue.onSubmittedWorkDone();
      await this._readback();
    } finally {
      this.running = false;
    }
    return this.day;
  }

  /**
   * Apply a weather brush at grid cell (x, y). type: storm | drought | flood | wildfire.
   * opts: { x, y, radius (cells), intensity, days, spread }. Same as clicking with the tool.
   */
  brush(type, opts = {}) {
    if (!this.world || this.loading) return null;
    const res = this.events.add(type, opts, { day: this.day, pMean: this.climate.preset.pMean * this.climate.precipMul });
    if (res?.type === 'wildfire') {
      // the fire wrote veg/burn: refresh the derived fields (infiltration, erodibility, display)
      this.world.params.set({ ...this._plan(1, 1, 2), vegMode: 1, vegD: 0 });
      vegetation.sync(1);
    }
    this.onBrush?.(res);
    return res;
  }

  // Async, serialized readback of state sums + new flux-log entries.
  _readback() {
    const job = this._rb.then(async () => {
      const frameAt = this.frame;
      const world = this.world;
      const { state, log } = await this.statsK.snapshot();
      if (world !== this.world) return this.lastState;
      const A = this.world.cellSize ** 2;
      if (frameAt - this.consumed > LOG_SIZE) console.warn('flux log overrun: balance will be off');
      for (let f = this.consumed; f < frameAt; f++) {
        const o = (f % LOG_SIZE) * 4;
        this.cum.precip += log[o] * A; this.cum.outflow += log[o + 1] * A;
        this.cum.evap += log[o + 2] * A; this.cum.sedOut += log[o + 3] * A;
      }
      this.consumed = frameAt;
      this.hmax = state.maxWater;
      this.lastState = state;
      return state;
    });
    this._rb = job.catch((e) => { console.error(e); });
    return job;
  }

  // Debug/test helper: copy one layer back to the CPU (not used by the frame loop).
  async readLayer(name) {
    const src = this.world.buffers[name];
    const st = this.device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, st, 0, src.size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(st.getMappedRange().slice(0));
    st.unmap(); st.destroy();
    return out;
  }

  async stats() {
    await this.device.queue.onSubmittedWorkDone();
    const s = await this._readback();
    const A = this.world.cellSize ** 2;
    const cells = this.world.N * this.world.N;
    const stored = (s.water + s.snow + s.groundwater) * A;
    const c = this.cum;
    const err = c.precip - (stored - this.stored0) - c.outflow - c.evap;
    const solidsErr = s.solidsChange * A + c.sedOut;   // should be ~0: solids only leave via the boundary
    return {
      day: this.day, year: this.day / 365,
      totalWater_m3: s.water * A, totalSediment_m3: s.sediment * A, totalSoil_m3: s.soil * A,
      totalBedrock_m3: s.bedrock * A, totalSnowSWE_m3: s.snow * A, totalGroundwater_m3: s.groundwater * A,
      cumPrecip_m3: c.precip, cumOutflow_m3: c.outflow, cumEvapLoss_m3: c.evap, cumSedimentOut_m3: c.sedOut,
      balanceError_m3: err, balanceErrorPct: c.precip > 0 ? (100 * err) / c.precip : 0,
      solidsError_m3: solidsErr,
      maxErosion_m: s.maxErosion, maxDeposition_m: s.maxDeposition,
      minHeight: s.minH + this.datum, maxHeight: s.maxH + this.datum, maxWaterDepth: s.maxWater,
      hasNaN: s.nan > 0, nanCells: s.nan, fps: this.fps,
      N: this.world.N, cellSize: this.world.cellSize, substepsPerFrame: this.nSub,
      dtH: this.lastPlan.dtH, morph: this.lastPlan.morph, routingIntensity: this.lastPlan.aW,
      meanVeg: s.vegSum / cells, vegCoveredFrac: s.vegCovered / cells, burnedFrac: s.burned / cells,
      events: this.events.list.map((e) => ({ id: e.id, type: e.name, x: e.x, y: e.y, r: e.r, daysLeft: e.daysLeft })),
    };
  }
}
