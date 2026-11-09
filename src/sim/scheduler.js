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
import { World, LOG_SIZE } from '../world.js';
import { ParamBlock } from './params.js';
import { Climate } from './climate.js';
import { generateTerrain } from '../terrain.js';
import water, { WATER_PARAMS } from './water.js';
import erosion, { EROSION_PARAMS } from './erosion.js';
import snow, { SNOW_PARAMS, avalanche } from './snow.js';
import freezethaw, { FREEZETHAW_PARAMS } from './freezethaw.js';
import climateModule from './climate.js';
import { column } from './column.js';
import { groundwater, GROUNDWATER_PARAMS } from './groundwater.js';
import { vegetation } from './vegetation.js';
import { Events } from './events.js';
import { sculptor } from './sculpt.js';
import { gwCapacity } from './common.js';
import { makeStrata, packStrata, STRATA_PARAM_FIELDS, PROVINCES, resolveProvince } from './strata.js';

// rock dissolved by groundwater (m/yr) in plain limestone with a full store; gypsum x5, salt x30,
// sinkhole seeds x20 (sim/strata.js sol). Dissolved rock leaves the map in solution (solids books).
export const KARST_PARAMS = { kDiss: 5e-5 };
import { deposits, DEP_EPOCHS } from './deposits.js';
import { wind, towardVector, WIND_PARAMS } from './wind.js';
import { glacier, GLACIER_PARAMS } from './glacier.js';
import { volcano } from './volcano.js';
import { karst, KARST_PARAMS as KARST_V } from './karst.js';
import { arches } from './arches.js';
import { quakes } from './quake.js';
import { Stats } from './stats.js';

export const A_CAP = 150;              // max routing intensity (x real-time runoff rate)
export const MAX_DAYS_PER_FRAME = 365000 / 60;
const STROBE_DAYS_PER_FRAME = 20;
const RUN_HYDRO_SUBSTEPS = 96000;    // hydraulic sub-steps per sim.run() (spread over the run)      // above this, seasons are shown stroboscopically
const STROBE_PHASE_DAYS = 365 / 240;   // season advance per frame in strobe mode (one cycle / 4 s)

export class Simulation {
  constructor(device) {
    this.device = device;
    this.climate = new Climate();
    this.speed = 1;            // days per real second
    this.paused = false;
    this.erosionStrength = 1;
    this.nSub = 16;            // hydraulic sub-steps per frame (governor adjusts)
    this.maxSub = 64;
    this.world = null;
    this.modules = [climateModule, snow, freezethaw, groundwater, water, erosion, vegetation];
    this.events = new Events();
    this.day = 0;
    this.frame = 0;
    this.carry = 0;
    this.hmax = 0.3;
    this.cum = { precip: 0, outflow: 0, evap: 0, sedOut: 0, erupted: 0 };
    this.consumed = 0;
    this._rb = Promise.resolve();
    this.lastPlan = {};
    this.running = false;
    this.fps = 0;
    // timelapse: when set, tick() lands exactly on this sim day, pauses and calls onStop()
    this.stopAtDay = null;
    this.onStop = null;
  }

  get N() { return this.world?.N ?? 0; }

  // Loads never overlap (a second one waits for the first), and while one is in progress the frame
  // loop neither simulates nor reads stats: batches run on a half-loaded map would put water into
  // the books before the starting store (stored0) is measured.
  load(scenario = 'random', opts = {}) {
    this.loading = (this.loading || 0) + 1;
    const job = (this._loadQ || Promise.resolve()).then(() => this._load(scenario, opts));
    this._loadQ = job.catch(() => {});
    return job.finally(() => { this.loading--; });
  }

  async _load(scenario = 'random', opts = {}) {
    const N = [256, 512, 1024, 2048].includes(+opts.size) ? +opts.size : (this.world?.N || 512);
    const cellSize = +opts.cellSize || this.cellSize || 10;
    const seed = Number.isFinite(+opts.seed) ? +opts.seed : 1;
    if (opts.preset) this.climate.setPreset(opts.preset);
    this.scenario = scenario; this.seed = seed;
    this.ruggedness = opts.ruggedness ?? this.ruggedness ?? 0.5;
    this.relief = opts.relief ?? this.relief ?? 1;
    // geologic province (sim/strata.js): 'plateau', 'rockies', 'valleyRidge', 'gulf' or 'random' (from the seed)
    this.province = opts.province ?? this.province ?? 'plateau';
    this.provinceUsed = resolveProvince(this.province, seed);
    const reliefUsed = this.relief * PROVINCES[this.provinceUsed].relief;
    await this._rb.catch(() => {});
    await this.device.queue.onSubmittedWorkDone();
    if (!this.world || this.world.N !== N || this.cellSize !== cellSize) {
      this.statsK?.destroy();
      this.world?.params?.buffer.destroy();
      this.world?.destroy();
      this.world = new World(this.device, { N, cellSize });
      this.world.params = new ParamBlock(this.device);
      this.world.substepHooks = [];
      this.cellSize = cellSize;
      for (const m of [water, erosion]) m.init(this.device, this.world);
      column.init(this.device, this.world);
      groundwater.init(this.device, this.world);
      vegetation.init(this.device, this.world);
      avalanche.init(this.device, this.world);
      deposits.init(this.device, this.world);
      wind.init(this.device, this.world);
      glacier.init(this.device, this.world);
      volcano.init(this.device, this.world);
      karst.init(this.device, this.world);
      arches.init(this.device, this.world);
      this.events.init(this.device, this.world);
      sculptor.init(this.device, this.world);
      this.statsK = new Stats(this.device, this.world);
      this.maxSub = N <= 256 ? 256 : N <= 512 ? 128 : 64;
      this.nSub = Math.min(this.nSub, this.maxSub);
      this.onWorldChanged?.(this.world);
    }
    const volcanoes = opts.volcanoes ?? this.oldVolcanoes;
    const { height, soil, volcRock, volcanoInfo } = generateTerrain(scenario, { N, cellSize, seed, ruggedness: this.ruggedness, relief: reliefUsed, preErode: opts.preErode !== false, volcanoes });
    const bedrock = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) bedrock[i] = height[i] - soil[i];
    const gw = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) gw[i] = 0.3 * gwCapacity(soil[i], this.climate.preset.gwMax);
    this.world.upload({ bedrock, soil, groundwater: gw, initHeight: height, volcRock });
    this.datum = this.climate.preset.baseElevation;
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (let i = 0; i < N * N; i++) { const h = height[i]; if (h < mn) mn = h; if (h > mx) mx = h; sum += h; }
    this.terrainRange = { min: mn, max: mx, mean: sum / (N * N) };
    // a fresh rock stack for this landscape (same seed, same rocks); beds thicken with the relief slider
    this.strataInfo = makeStrata(seed, height, N, cellSize, Math.max(0.5, reliefUsed), this.provinceUsed);
    this.strataPack = packStrata(this.strataInfo, true);
    this.volcanoInfo = volcanoInfo;
    // earthquakes on this map's faults (sim/quake.js); own random stream from the seed
    quakes.reset(seed, this.strataInfo, this.provinceUsed, cellSize, N);
    if (volcanoInfo?.length) {
      const flows = volcanoInfo.reduce((s, v) => s + v.flows, 0);
      this.strataInfo.describe = this.strataInfo.describe.replace(/\.$/, '') +
        `; ${volcanoInfo.length === 1 ? 'an old volcano' : `${volcanoInfo.length} old volcanoes`} with ${flows} basalt flow${flows === 1 ? '' : 's'}.`;
    }
    // a readback started before this load (the frame loop asks for stats every few frames) must not
    // fold the old map's flux log into the new books: each load starts a new generation
    this.gen = (this.gen || 0) + 1;
    this.day = 0; this.frame = 0; this.carry = 0; this.hmax = 0.3; this.consumed = 0; this.lastN = 0;
    this.stopAtDay = null;
    this.depEpoch = 0; this.depEpochStart = 0;
    this.cum = { precip: 0, outflow: 0, evap: 0, sedOut: 0, erupted: 0 };
    this.climate.stormDaysLeft = 0;
    this.climate.resetWeather(seed);
    wind.reset(seed);
    glacier.hasIce = true;
    volcano.reset();
    arches.reset(seed);
    this.events.reset();
    sculptor.reset();
    this.world.params.set({ N, cellSize, cellArea: cellSize * cellSize, frame: 0, logSize: LOG_SIZE });
    this.world.params.upload();
    // the date card and sky start from the new map's first day, not the old map's last
    this.lastPlan = {};
    this.lastClimate = this.climate.produce(0, this.datum + this.terrainRange.mean, 1);
    this.lastState = null;
    if (opts.spinUp !== false) await this._spinUp();
    const s0 = await this._readback();
    this.stored0 = (s0.water + s0.snow + s0.groundwater + 0.9 * s0.ice) * this.world.cellSize ** 2;
    this.onLoaded?.();
    return { N, cellSize, scenario, seed };
  }

  // Uniform plan for one batch of Dcol climate days / Deros landscape days / nSub sub-steps.
  _plan(Dcol, Deros, nSub) {
    const w = this.world, dx = w.cellSize;
    const n = Math.max(2, nSub + (nSub & 1));
    // Fixed hydraulic step: 0.2 dx seconds (2 s at 10 m). Velocity is capped at 0.5 dx/dt and the
    // pipe depth at (0.5 dx/dt)^2/g, so both the advective and gravity-wave Courant numbers stay
    // <= 0.5 for any water depth - stability needs no feedback from the (async) stats.
    const dtH = 0.2 * dx;
    const tau = n * dtH;
    const A = (Dcol * 86400) / tau;
    const aW = A > 0 ? Math.min(A, A_CAP) : 0;
    const fR = A > 0 ? aW / A : 1;
    const morph = aW > 0 ? Math.max(1, (Deros * 86400) / (aW * tau)) : 1;
    let span, dayStart, yrs;
    const doy = ((this.day % 365) + 365) % 365;
    if (Dcol >= 365) { span = 365; yrs = Dcol / 365; dayStart = (((this.day + Dcol - 365) % 365) + 365) % 365; }
    else { span = Dcol; yrs = 1; dayStart = doy; }
    const nInner = Math.min(48, Math.max(1, Math.ceil(span / 1.0)));
    const zRef = this.datum + (this.terrainRange?.mean ?? 0);
    const yearsE = Deros / 365;
    const cu = this.climate.uniforms(Dcol, zRef);
    // painted drought: map-wide climate change for the part of the batch it covers (sim/events.js)
    const dm = this.events.climateMods(Dcol);
    cu.tSea += dm.dT; cu.pMean *= dm.pMul; cu.etMul *= dm.etMul;
    const ev = this.events.uniforms(Dcol, n, fR, dx * dx);
    // volcanoes: this batch's cone growth and lava (advances the eruptions on the lava clock)
    const vp = volcano.plan(Dcol);
    // rock layers: structure scalars into the plan, bed table straight into the param block
    const st = this.strataPack, stFields = {};
    STRATA_PARAM_FIELDS.forEach((name, i) => { stFields[name] = st.head[i]; });
    stFields.strataOn = this.strata ? 1 : 0;
    w.params.setArray('stBeds', st.table);
    const plan = {
      N: w.N, frame: this.frame, logSize: LOG_SIZE, nSub: n,
      cellSize: dx, cellArea: dx * dx, dtH, g: WATER_PARAMS.g,
      aW, fR, morph, D: Dcol, dayStart, spanDays: span, yrs, nInner,
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
      vegInit: 0,
      depEpoch: this.depEpoch % DEP_EPOCHS, depOn: this.sedimentBeds ? 1 : 0,
      windOn: wind.enabled ? 1 : 0, windSandy: this.climate.windSettings().sandy,
      sandTan: wind.enabled ? WIND_PARAMS.sandTan : EROSION_PARAMS.talusTan,
      ...GLACIER_PARAMS, glacOn: glacier.enabled ? 1 : 0, glacK: glacier.iterations(Dcol),
      ...stFields,
      kDiss: KARST_PARAMS.kDiss, yrsE: yearsE, kRech: this.karstValleys ? KARST_V.kRech : 0, kFoot: this.karstValleys ? KARST_V.kFoot : 0,
      ...ev.fields,
      ...vp.fields,
      ...quakes.plan(this.day).fields,
    };
    return { plan, n, A, tau, dm, fastFloodM3: ev.fastFloodM3, eruptedM3: vp.eruptedM3 };
  }

  // Bring groundwater, snow, moisture memory and the plant cover close to equilibrium with the
  // climate after a load, so a new landscape starts green where it should be. Runs the column and
  // lateral groundwater over a few representative years with fR = 0 (nothing is routed), then sets
  // the cover to its equilibrium. The water accounting starts afterwards (stored0 is read after).
  async _spinUp() {
    const p = this.world.params, dev = this.device;
    const round = (vegInit) => {
      const { plan } = this._plan(3 * 365, 0, 2);
      Object.assign(plan, { fR: 0, aW: 0, morph: 1, vegInit, fireWeather: 0, frame: 0 });
      p.set(plan); p.upload();
      const enc = dev.createCommandEncoder({ label: 'spinup' });
      const pass = enc.beginComputePass();
      if (vegInit) vegetation.recordGrow(pass);
      else { column.record(pass); groundwater.record(pass); column.record(pass); groundwater.record(pass); }
      pass.end();
      dev.queue.submit([enc.finish()]);
    };
    round(0); round(1); round(0); round(1);
    // discard the spin-up fluxes; the water layer is untouched (fR = 0)
    dev.queue.writeBuffer(this.world.buffers.acc, 0, new Float32Array(this.world.cells * 4));
    await dev.queue.onSubmittedWorkDone();
  }

  // ---- one batch: column -> nSub x (flux, update, erosion) -> thermal -> plants -> accumulate ----
  _batch(Dcol, Deros, nSub, timed = false) {
    const p = this.world.params;
    const zRef = this.datum + (this.terrainRange?.mean ?? 0);
    this.climate.advanceWeather(this.day, Dcol);
    // sediment beds: a new bed can start once per bedDays of sim time (about 2 s of watching)
    if (this.day - this.depEpochStart >= this.bedDays) { this.depEpoch++; this.depEpochStart = this.day; }
    // earthquakes in this batch: the ground offset is queued now (before the plan, so the faults'
    // new throws reach this batch's rock table); the shaking runs after the batch
    const shake = quakes.step(this, Dcol, this.day);
    const { plan, n, A, tau, dm, fastFloodM3, eruptedM3 } = this._plan(Dcol, Deros, nSub);
    // what the vents add to the map (cinders, lava), logged in float64 for the solids books
    this.cum.erupted += eruptedM3;
    p.set(plan);
    p.upload();
    // wind: this batch's iterations (directions, gusts) go into their own small uniforms; fire and
    // smoke follow the prevailing wind
    const ws = this.climate.windSettings();
    wind.plan(Deros, Dcol, this.day, ws);
    this.events.prevailing = wind.enabled && ws.speed > 0.01 ? towardVector(ws.from) : null;
    // flood water the routed solver cannot carry this batch: logged as precipitation and as fast
    // outflow in float64 on the CPU (the two cancel exactly in the balance)
    if (fastFloodM3 > 0) { this.cum.precip += fastFloodM3; this.cum.outflow += fastFloodM3; }
    const climateObj = this.climate.produce((this.day + Dcol) % 365, zRef, Dcol);
    climateObj.precipRate_mm_per_day *= dm.pMul;
    climateObj.airTempSeaLevel += dm.dT; climateObj.airTempAtRef += dm.dT;
    climateObj.drought = !!this.events.drought;
    climateObj.plan = plan;
    const enc = this.device.createCommandEncoder({ label: 'sim' });
    const pass = enc.beginComputePass({ label: 'sim', timestampWrites: timed ? this.timer?.simPassTimestamps() : undefined });
    column.record(pass);
    groundwater.record(pass);
    karst.record(pass);
    deposits.snapshot(pass);
    water.record(pass, n);
    deposits.record(pass);
    erosion.recordThermal(pass);
    wind.record(pass);
    avalanche.record(pass);
    vegetation.record(pass);
    glacier.record(pass);          // after the plants, so nothing stays growing on the ice
    volcano.record(pass);          // last: lava kills what grew under it and melts the ice
    this.statsK.recordAccumulate(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    if (shake) this._shake(shake, plan);
    this.climate.consume(Dcol);
    this.events.consume(Dcol);
    this.day += Dcol;
    this.frame++;
    this.lastPlan = { ...plan, A, tau, Deros, climate: climateObj };
    this.lastClimate = climateObj;
    return n;
  }

  // Earthquake shaking: a few extra slump / rockfall / avalanche passes with slopes near the rupture
  // standing at lower angles (sim/quake.js). Creep is off in these passes (it already ran this batch).
  _shake(q, plan) {
    const p = this.world.params;
    p.set({ ...quakes.shakeFields(q), thermalRate: 0.5, creepFrac: 0, rockRate: 0.25 });
    p.upload();
    const enc = this.device.createCommandEncoder({ label: 'quake' });
    const pass = enc.beginComputePass({ label: 'quake' });
    for (let k = 0; k < q.passes; k++) erosion.recordThermal(pass);
    avalanche.record(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    p.set(plan); p.upload();
  }

  // Paint a weather event (brush). type: storm | drought | flood | wildfire; x, y in grid cells.
  brush(type, opts = {}) {
    if (!this.world) throw new Error('load() first');
    const ev = this.events.add(type, opts, { vegetation, volcano, readLayer: (n) => this.readLayer(n) });
    if (ev.type === 'volcano' && this.terrainRange) {
      const tr = this.terrainRange, g = Number.isFinite(+opts.ground) ? +opts.ground : null;
      tr.max = Math.max(tr.max, (g ?? tr.max) + (ev.coneHeight || 0));
      // explosion craters dig below the old ground: keep the picking box under them
      if (ev.craterD > 0) tr.min = Math.min(tr.min, (g ?? tr.min) - ev.craterD);
    }
    return ev;
  }

  // Shape the ground with a brush (one dab; see sim/sculpt.js). op: raise | lower | smooth | flatten |
  // channel; x, y, radius in grid cells. `ground` (optional) is the current ground height at the
  // centre, used to keep terrainRange (picking box, framing) around the land.
  sculpt(op, opts = {}) {
    if (!this.world) throw new Error('load() first');
    const box = sculptor.dab(op, opts);
    const tr = this.terrainRange;
    if (tr) {
      const I = Math.max(0.05, +opts.intensity || 1), g = Number.isFinite(+opts.ground) ? +opts.ground : null;
      if (op === 'raise') tr.max = Math.max(tr.max, (g ?? tr.max) + I * 1.0);
      if (op === 'lower') tr.min = Math.min(tr.min, (g ?? tr.min) - I * 1.0);
      if (op === 'channel') tr.min = Math.min(tr.min, Math.min(+opts.za, +opts.zb) - 6 * I);
      if (op === 'flatten' && Number.isFinite(+opts.target)) { tr.min = Math.min(tr.min, +opts.target); tr.max = Math.max(tr.max, +opts.target); }
    }
    return { op, x: +opts.x, y: +opts.y, r: +opts.radius || 10, box };
  }
  beginStroke() { sculptor.beginStroke(); }
  endStroke() { return sculptor.endStroke(); }
  undoSculpt() { return sculptor.undo(); }
  get canUndo() { return sculptor.canUndo; }
  get sculptBusy() { return sculptor.busy; }
  // rock layers on/off (sim/strata.js); on by default, takes effect at the next batch
  strata = true;
  // karst valleys (sim/karst.js: sinking water dissolving its way down, walls retreating) on/off; the
  // plain dissolution in column.js stays either way. For tests.
  karstValleys = true;
  // sediment beds on/off (sim/deposits.js), and the sim time between new beds (set from the speed)
  sedimentBeds = true;
  bedDays = 7;

  // wind on/off (sim/wind.js): dunes, dust, sandblasting, drifting snow; on by default
  get windOn() { return wind.enabled; }
  set windOn(v) { wind.enabled = !!v; }
  get windPlan() { return wind.last; }

  // glaciers on/off (sim/glacier.js): snow turning to ice, ice flow and carving; on by default
  get glaciers() { return glacier.enabled; }
  set glaciers(v) { glacier.enabled = !!v; }

  // old volcanoes in newly generated random maps (terrain.js); on by default, takes effect at the
  // next load. The Volcano brush works either way.
  oldVolcanoes = true;
  get volcanoes() { return volcano; }
  get arches() { return arches; }
  get quakes() { return quakes; }

  // snow avalanches on/off (sim/snow.js); on by default
  get avalanches() { return avalanche.enabled; }
  set avalanches(v) { avalanche.enabled = !!v; }

  // Interactive frame. realDt in seconds. Returns sub-steps run (0 if paused).
  tick(realDt) {
    this.lastN = 0;
    if (!this.world || this.paused || this.running || this.loading) return 0;
    const dt = Math.min(Math.max(realDt, 0), 0.1);
    const stop = this.stopAtDay !== null;
    const rem = stop ? this.stopAtDay - this.day : Infinity;
    if (stop && rem <= 1e-9) { this._finishTimelapse(); return 0; }
    const target = Math.min(this.speed * dt, MAX_DAYS_PER_FRAME * 2, rem);
    this.bedDays = Math.min(Math.max(2 * this.speed, 7), 500 * 365);
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
      // leaving the time-lapse: the days it still owes are paid off a few per frame (at most 4x the
      // requested rate) rather than as up to a year of snow and growth in one jump
      const pay = Math.min(this.carry, 3 * target);
      Dcol = target + pay; this.carry -= pay; this.strobe = false;
    }
    // timelapse end: the strobe holds days back in `carry` (whole years at a time); once what is
    // owed reaches the end of the span, pay exactly up to the end and drop the rest
    if (stop && (Dcol + this.carry >= rem - 1e-9 || Dcol > rem)) { Dcol = rem; this.carry = 0; }
    if (Dcol <= 0) return 0;
    // Slow motion (below ~1 day/s): never simulate more hydraulic seconds than clock seconds, so
    // water moves at its real speed and a flood wave can be watched travelling down the valley.
    const nClock = Math.max(2, 2 * Math.floor((Dcol * 86400) / (0.2 * this.world.cellSize) / 2));
    const n = this._batch(Dcol, target, Math.min(this.nSub, nClock), true);
    this.lastN = n;               // sub-steps actually run (the governor divides the GPU time by it)
    this.lastBatchDays = Dcol;
    if (this.frame % 30 === 0) this._readback().catch(() => {});
    if (arches.due(this)) arches.update(this).catch((e) => console.error(e));
    if (stop && this.stopAtDay - this.day <= 1e-9) this._finishTimelapse();
    return n;
  }

  // The timelapse reached its end: snap the clock onto the end day, freeze and tell the app.
  _finishTimelapse() {
    const end = this.stopAtDay;
    if (end === null) return;
    if (Math.abs(this.day - end) < 1e-6) this.day = end;
    this.stopAtDay = null;
    this.carry = 0;
    this.paused = true;
    this._readback().catch(() => {});
    try { this.onStop?.(end); } catch (e) { console.error(e); }
  }

  // Advance `days` as fast as possible (no wall-clock coupling). Resolves when the GPU is done.
  async run(days, opts = {}) {
    if (!this.world) throw new Error('load() first');
    this.running = true;
    try {
      let remaining = Math.max(0, +days || 0);
      const N = this.world.N;
      const nSub = opts.nSub || (N <= 256 ? 64 : N <= 512 ? 32 : N <= 1024 ? 16 : 8);
      // Batch length: enough batches that the hydraulic solver gets RUN_HYDRO_SUBSTEPS sub-steps in
      // total (flow networks need ~1e5 s of hydraulic time to establish on a 5 km domain), never more
      // than MAX_DAYS_PER_FRAME per batch, never less than ~1 hour of climate per batch.
      this.bedDays = opts.bedDays || Math.min(Math.max(days / 40, 7), 500 * 365);
      const Db = opts.batchDays || Math.min(MAX_DAYS_PER_FRAME, Math.max(days / Math.ceil(RUN_HYDRO_SUBSTEPS / nSub), Math.min(days, 0.05)));
      let k = 0;
      while (remaining > 1e-9) {
        const D = Math.min(Db, remaining);
        this._batch(D, D, nSub);
        remaining -= D;
        k++;
        if (k % 6 === 0) await this.device.queue.onSubmittedWorkDone();
        if (arches.due(this)) await arches.update(this);
        if (k % 300 === 0) await this._readback();
      }
      await this.device.queue.onSubmittedWorkDone();
      await this._readback();
    } finally {
      this.running = false;
    }
    return this.day;
  }

  // Async, serialized readback of state sums + new flux-log entries.
  _readback() {
    const job = this._rb.then(async () => {
      const gen = this.gen, frameAt = this.frame;
      const { state, log } = await this.statsK.snapshot();
      if (gen !== this.gen) return this.lastState ?? state;   // a new map was loaded meanwhile
      const A = this.world.cellSize ** 2;
      if (frameAt - this.consumed > LOG_SIZE) console.warn('flux log overrun: balance will be off');
      for (let f = this.consumed; f < frameAt; f++) {
        const o = (f % LOG_SIZE) * 4;
        this.cum.precip += log[o] * A; this.cum.outflow += log[o + 1] * A;
        this.cum.evap += log[o + 2] * A; this.cum.sedOut += log[o + 3] * A;
      }
      this.consumed = frameAt;
      this.hmax = state.maxWater;
      // keep the picking/framing box around the land as it erodes, caves in or builds up
      const tr = this.terrainRange;
      if (tr && Number.isFinite(state.minH) && Number.isFinite(state.maxH)) {
        tr.min = Math.min(tr.min, state.minH); tr.max = Math.max(tr.max, state.maxH);
      }
      glacier.hasIce = state.ice > 0;
      volcano.hasLava = state.hotLava > 0 || volcano.erupting;
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
    try {
      await st.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(st.getMappedRange().slice(0));
      st.unmap();
      return out;
    } finally { st.destroy(); }
  }

  // Every k-th cell in x and y of a layer with `per` floats per cell (cheap look at a huge layer).
  // Returns { data, n, per } with n x n cells of `per` floats.
  async sampleLayer(name, per = 1, k = 1) {
    const src = this.world.buffers[name], N = this.world.N;
    if (k <= 1) return { data: await this.readLayer(name), n: N, per };
    const n = Math.ceil(N / k), rowBytes = N * per * 4;
    const st = this.device.createBuffer({ size: n * rowBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    for (let j = 0; j < n; j++) enc.copyBufferToBuffer(src, j * k * rowBytes, st, j * rowBytes, rowBytes);
    this.device.queue.submit([enc.finish()]);
    try {
      await st.mapAsync(GPUMapMode.READ);
      const rows = new Float32Array(st.getMappedRange());
      const data = new Float32Array(n * n * per);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        for (let c = 0; c < per; c++) data[(j * n + i) * per + c] = rows[j * N * per + i * k * per + c];
      }
      st.unmap();
      return { data, n, per };
    } finally { st.destroy(); }
  }

  async stats() {
    await this.device.queue.onSubmittedWorkDone();
    const s = await this._readback();
    const A = this.world.cellSize ** 2;
    const stored = (s.water + s.snow + s.groundwater + 0.9 * s.ice) * A;
    const c = this.cum;
    const err = c.precip - (stored - this.stored0) - c.outflow - c.evap;
    // should be ~0: solids only leave via the boundary and only arrive from volcanic vents
    // (rock held up in arch lintels is out of the height field: sim/arches.js)
    const solidsErr = s.solidsChange * A + c.sedOut - c.erupted + arches.store;
    const cells = this.world.cells;
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
      meanWoodyCover: s.woodySum / cells,
      totalIce_m3: s.ice * A, iceWater_m3: 0.9 * s.ice * A, glacierFrac: s.iceCells / cells,
      cumErupted_m3: c.erupted, hotLavaCells: s.hotLava, erupting: volcano.erupting,
      archesStanding: arches.standing, archesFallen: arches.fallen, bridgesStanding: arches.bridges, archRock_m3: arches.store,
    };
  }
}
