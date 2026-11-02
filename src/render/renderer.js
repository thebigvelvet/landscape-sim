// Raw WebGPU renderer (from the Artist build): sky, terrain with material shading, soft sun shadows,
// ambient occlusion and haze, block sides, translucent flowing water, and falling rain/snow.
// Round 2 (Showman): plants from the simulated veg layers (grass, shrubs, 3D trees and snags with
// seasonal colour), burn scars, fire glow and smoke, storm clouds with rain curtains and lightning,
// a baked drought look, event markers, the brush cursor and click ripples.
// Reads the simulation storage buffers directly (no copies, no CPU readback). The frame is encoded
// into the caller's command encoder so simulation and rendering share one submission.
import { SKY, TERRAIN, SKIRT, WATER, PRECIP, COMPACT, TREES, SMOKE, STORMFX } from './shaders.js';
import { makeKernels } from './gpu.js';
import { Lighting } from './lighting.js';
import { OrbitCamera } from './camera.js';
import { PRESETS } from '../sim/climate.js';

// Overlay names, in the order of the shader's overlay modes (0 = natural view).
export const OVERLAYS = ['none', 'water', 'sediment', 'snow', 'frost', 'change', 'groundwater', 'plants'];
export const TOOL_IDS = { none: 0, storm: 1, drought: 2, flood: 3, wildfire: 4 };
const UB_FLOATS = 156;

const SAMPLES = 4;
const WEATHER_VISIBLE_SPEED = 36;   // days/s; above this rain particles and clouds are averaged out

const TOOL_RGB = { 1: [0.35, 0.70, 1.0], 2: [1.0, 0.72, 0.25], 3: [0.20, 0.95, 0.95], 4: [1.0, 0.38, 0.12] };

function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/** Rough sun position for the season at mid-morning. World: +x east, +z south, +y up; points TO the sun. */
export function sunDirection(dayOfYear) {
  const s = Math.cos((2 * Math.PI * (dayOfYear - 172)) / 365); // +1 midsummer, -1 midwinter
  const elev = ((36 + 22 * s) * Math.PI) / 180;
  const az = ((-35 - 10 * s) * Math.PI) / 180;
  return [Math.cos(elev) * Math.sin(-az), Math.sin(elev), Math.cos(elev) * Math.cos(az)];
}

export class Renderer {
  constructor(device, canvas, format) {
    this.device = device;
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = format;
    this.ctx.configure({ device, format, alphaMode: 'opaque' });
    this.camera = new OrbitCamera(canvas);
    this.ub = device.createBuffer({ size: UB_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.u = new Float32Array(UB_FLOATS);
    this.compUB = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compRaw = new ArrayBuffer(96);
    this.cursor = { on: false, x: 0, y: 0, r: 10, tool: 0 };       // grid cells
    this.ripple = null;                                           // {x, y, r, t0, tool}
    this.flash = 0;
    this.droughtVis = 0;
    this.stormSnow = 0;
    this.showTrees = true;
    this.treeScale = 1;
    this.visuals = new Map();                                     // event id -> {endWall}
    this.mode = 0;
    this.vex = 1.25;
    this.haze = 0.12;
    this.contours = false;
    this.showWater = true;
    this.time = 0;
    this.cloud = 0;
    this.precipVis = 0;
    this.snowVis = 0;
    this.frameCount = 0;
    this.lastT = performance.now();
    this.makePipelines();
  }

  // String overlay name (engine/test API) <-> numeric shader mode.
  get overlay() { return OVERLAYS[this.mode]; }
  set overlay(v) { const i = typeof v === 'number' ? v : OVERLAYS.indexOf(v); this.mode = i >= 0 ? i : 0; }
  get exaggeration() { return this.vex; }
  set exaggeration(v) { this.vex = v; this.lightDirty = true; }

  makePipelines() {
    const d = this.device;
    const mk = (code, label, { blend = false, depthWrite = true, depth = true } = {}) => {
      const module = d.createShaderModule({ label, code });
      module.getCompilationInfo?.().then((info) => {
        for (const m of info.messages) if (m.type === 'error') console.error(`[${label}] WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
      });
      return d.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module, entryPoint: 'fs',
          targets: [{
            format: this.format,
            blend: blend ? {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            } : undefined,
          }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth ? { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare: 'less-equal' } : { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
        multisample: { count: SAMPLES },
      });
    };
    this.pSky = mk(SKY, 'sky', { depth: false });
    this.pTerrain = mk(TERRAIN, 'terrain');
    this.pSkirt = mk(SKIRT, 'skirt');
    this.pWater = mk(WATER, 'water', { blend: true, depthWrite: false });
    this.pPrecip = mk(PRECIP, 'precip', { blend: true, depth: false });
    this.pTrees = mk(TREES, 'trees');
    this.pSmoke = mk(SMOKE, 'smoke', { blend: true, depthWrite: false });
    this.pStorm = mk(STORMFX, 'stormfx', { blend: true, depthWrite: false });
    this.kCompact = makeKernels(d, 'compact', COMPACT, ['uniform', 'read', 'read', 'read', 'storage', 'storage', 'storage'], ['main', 'clampArgs']);
  }

  /** (Re)bind to a world; called by the engine whenever it creates a new World. */
  setWorld(world) {
    const d = this.device;
    this.world = world;
    const N = world.N;
    if (this.indexN !== N) {
      this.index?.destroy();
      const idx = new Uint32Array((N - 1) * (N - 1) * 6);
      let k = 0;
      for (let y = 0; y < N - 1; y++) {
        for (let x = 0; x < N - 1; x++) {
          const a = y * N + x, b = a + 1, c = a + N, e = c + 1;
          // Alternate the diagonal for less directional bias.
          if ((x + y) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = e; }
          else { idx[k++] = a; idx[k++] = c; idx[k++] = e; idx[k++] = a; idx[k++] = e; idx[k++] = b; }
        }
      }
      this.index = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.index, 0, idx);
      this.indexCount = idx.length;
      this.indexN = N;
    }
    const bg = (pipe, bufs) => d.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
    const w = world;
    this.bgSky = bg(this.pSky, [this.ub]);
    this.bgPrecip = bg(this.pPrecip, [this.ub]);
    this.bgTerrain = bg(this.pTerrain, [this.ub, w.bedrock, w.soil, w.snowSWE, w.water, w.sediment, w.frostDepth, w.light, w.height0]);
    this.bgSkirt = bg(this.pSkirt, [this.ub, w.bedrock, w.soil]);
    this.bgWater = bg(this.pWater, [this.ub, w.bedrock, w.soil, w.water, w.velX, w.velY, w.sediment, w.light, w.snowSWE]);
    this.lighting = new Lighting(d, world);
    this.lightDirty = true;
    // instance lists for trees/snags and burning cells, with drawIndirect argument blocks
    for (const b of [this.treeList, this.fireList, this.drawArgs]) b?.destroy();
    this.treeCap = Math.min(N * N, 600000);
    this.fireCap = 65536;
    this.treeList = d.createBuffer({ size: this.treeCap * 4, usage: GPUBufferUsage.STORAGE, label: 'trees' });
    this.fireList = d.createBuffer({ size: this.fireCap * 4, usage: GPUBufferUsage.STORAGE, label: 'fires' });
    this.drawArgs = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, label: 'drawArgs' });
    d.queue.writeBuffer(this.drawArgs, 0, new Uint32Array([36, 0, 0, 0, 18, 0, 0, 0]));
    this.bgCompact = this.kCompact.bind([this.compUB, w.bedrock, w.soil, w.light, this.treeList, this.fireList, this.drawArgs]);
    this.bgTrees = bg(this.pTrees, [this.ub, w.bedrock, w.soil, w.light, this.treeList, w.snowSWE]);
    this.bgSmoke = bg(this.pSmoke, [this.ub, w.bedrock, w.soil, w.light, this.fireList]);
    this.bgStorm = bg(this.pStorm, [this.ub]);
  }

  // ---- brush cursor / feedback (grid cell coordinates) ----
  setCursor(on, x = 0, y = 0, r = 10, tool = 0) { Object.assign(this.cursor, { on, x, y, r, tool }); }
  clickRipple(x, y, r, tool) { this.ripple = { x, y, r, tool, t0: performance.now() }; }

  // grid cell -> world xz
  gridToWorld(x, y) {
    const c = (this.world.N - 1) * 0.5, dx = this.world.cellSize;
    return [(x - c) * dx, (y - c) * dx];
  }

  // Visual state of painted events: storms (clouds), markers. Visuals last at least a few seconds
  // of wall time even when the simulated event is over in a blink at high speed.
  eventVisuals(sim, now) {
    const ev = sim.events;
    const storms = [], markers = [];
    const minWall = { storm: 4000, drought: 3000, flood: 6000, wildfire: 3500 };
    for (let k = ev.log.length - 1; k >= 0; k--) {
      const e = ev.log[k];
      let v = this.visuals.get(e.id);
      if (!v) { v = { endWall: null }; this.visuals.set(e.id, v); }
      const live = e.type === 'drought' ? !!ev.drought : ev.remaining(e.id) > 0;
      if (live) v.endWall = null;
      else if (v.endWall === null) v.endWall = Math.max(now, e.t0 + (minWall[e.type] || 3000));
      const fadeIn = Math.min(1, (now - e.t0) / 500);
      const fadeOut = v.endWall === null ? 1 : 1 - Math.min(1, Math.max(0, (now - v.endWall) / 1500));
      const a = fadeIn * fadeOut;
      if (a <= 0) continue;
      const [wx, wz] = this.gridToWorld(e.x, e.y);
      const r = e.r * this.world.cellSize;
      if (e.type === 'storm' && storms.length < 4) storms.push([wx, wz, r, a, e]);
      if (markers.length < 4 && e.type !== 'drought') markers.push([wx, wz, r, e.type === 'storm' ? 1 : e.type === 'flood' ? 3 : 4, a * (e.type === 'storm' ? 0.5 : 1)]);
    }
    return { storms, markers };
  }

  /** Called after new terrain is uploaded: frame the camera on it. */
  frameTerrain(range) {
    const extent = this.world.N * this.world.cellSize;
    this.camera.frame(extent, ((range.min + range.max) * 0.5) * this.vex * 0.8);
    this.lightDirty = true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h || !this.msaa) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.msaa?.destroy();
      this.depth?.destroy();
      this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
  }

  /** Season- and weather-dependent sky and sun. */
  atmosphere(sim) {
    const c = sim.climate;
    const lc = sim.lastClimate;
    const doy = lc?.dayOfYear ?? 172;
    const fast = !sim.paused && sim.speed > WEATHER_VISIBLE_SPEED;
    const summer = 0.5 + 0.5 * Math.cos((2 * Math.PI * (doy - 196)) / 365); // 1 in July, 0 in January
    const autumn = Math.max(0, Math.cos((2 * Math.PI * (doy - 290)) / 365)) ** 4;
    const name = c.presetName;
    const desert = name === 'Utah desert' ? 1 : 0;
    const wet = name === 'Pacific NW wet' ? 1 : 0;
    let zenith = lerp3([0.30, 0.47, 0.78], [0.13, 0.36, 0.82], summer);
    let horizon = lerp3([0.80, 0.86, 0.93], [0.70, 0.82, 0.94], summer);
    horizon = lerp3(horizon, [0.88, 0.80, 0.68], autumn * 0.45);
    horizon = lerp3(horizon, [0.93, 0.80, 0.66], desert * 0.45);
    horizon = lerp3(horizon, [0.74, 0.79, 0.82], wet * 0.35);
    // Clouds follow the weather (smoothed so time-lapse flicker stays gentle).
    const rate = lc?.precipRate_mm_per_day ?? 0;
    const mean = Math.max(0.2, c.precipAt(doy));
    let target = lc ? Math.min(1, (rate / mean) * 0.35) : 0;
    target = Math.max(target, (this.stormStrength || 0) * 0.55);
    this.cloud += (target - this.cloud) * (fast ? 0.02 : 0.08);
    const cl = this.cloud;
    zenith = lerp3(zenith, [0.50, 0.53, 0.58], cl * 0.8);
    horizon = lerp3(horizon, [0.70, 0.72, 0.75], cl * 0.8);
    // drought: dusty, hazy, harsh light
    const dv = this.droughtVis;
    zenith = lerp3(zenith, [0.52, 0.60, 0.72], dv * 0.6);
    horizon = lerp3(horizon, [0.93, 0.80, 0.60], dv * 0.6);
    let sunColor = lerp3([1.0, 0.86, 0.70], [1.0, 0.96, 0.90], summer);
    sunColor = lerp3(sunColor, [1.0, 0.84, 0.62], dv * 0.5);
    const sun = sunDirection(doy);
    // Rain/snow particles only when the weather is visible in real time.
    const precipTarget = !fast && !sim.paused && rate > 0.3 ? Math.min(1, rate / 15 + 0.25) : 0;
    this.precipVis += (precipTarget - this.precipVis) * 0.1;
    const midZ = sim.datum + (sim.terrainRange ? (sim.terrainRange.min + sim.terrainRange.max) * 0.5 : 0);
    const snowTarget = lc && c.airTempAt(doy, midZ) < 0.5 ? 1 : 0;
    this.snowVis += (snowTarget - this.snowVis) * 0.1;
    return { zenith, horizon, sunColor, sun, preset: PRESETS[name] || PRESETS['Colorado alpine'] };
  }

  /** Encodes a frame into `encoder` (the caller submits). */
  encode(encoder, sim, timestampWrites) {
    if (!this.world) return;
    const now = performance.now();
    const dtWall = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.time += dtWall;
    this.frameCount++;
    this.resize();
    this.camera.update(dtWall);
    const world = this.world;
    const aspect = this.canvas.width / this.canvas.height;
    // Shift the image right when the floating side panel covers the left of the canvas.
    const panel = document.getElementById('panel');
    const pw = panel && !panel.classList.contains('hidden') ? panel.getBoundingClientRect().right : 0;
    const { eye, viewProj, invViewProj } = this.camera.matrices(aspect, pw / Math.max(1, this.canvas.clientWidth));
    this.lastViewProj = viewProj; this.lastInvViewProj = invViewProj; this.lastEye = eye;
    // event visuals (computed before atmosphere so clouds darken the sky)
    const vis = this.eventVisuals(sim, now);
    this.stormStrength = vis.storms.reduce((m, q) => Math.max(m, q[3]), 0);
    const dTarget = sim.events.drought || sim.events.log.some((e) => e.type === 'drought' && now - e.t0 < 3000) ? 1 : 0;
    this.droughtVis += (dTarget - this.droughtVis) * 0.04;
    const atm = this.atmosphere(sim);
    const u = this.u;
    const pal = atm.preset.palette;
    const extent = world.N * world.cellSize;
    const tr = sim.terrainRange || { min: 0, max: 1 };
    u.set(viewProj, 0);
    u.set(invViewProj, 16);
    u.set([eye[0], eye[1], eye[2], this.time], 32);
    // Colours are authored in sRGB; lighting happens in linear space.
    const lin = (c) => c.map((v) => Math.pow(v, 2.2));
    u.set([atm.sun[0], atm.sun[1], atm.sun[2], 1.0], 36);
    u.set([...lin(atm.sunColor), this.vex], 40);
    u.set([...lin(atm.zenith), this.mode], 44);
    u.set([...lin(atm.horizon), this.haze * (1 + 0.8 * this.droughtVis) / extent], 48);
    const c = sim.climate;
    const tSeaMean = atm.preset.tSea + c.tempOffset;   // annual mean air temperature at sea level
    u.set([world.N, world.cellSize, sim.datum, tSeaMean], 52);
    u.set([...lin(pal.rock), pal.banding], 56);
    u.set([...lin(pal.rock2), pal.vegAmount], 60);
    u.set([...lin(pal.soil), atm.preset.lapse], 64);
    u.set([...lin(pal.talus), (sim.lastClimate?.dayOfYear ?? 0) / 365], 68);
    u.set([...lin(pal.veg), this.cloud], 72);
    u.set([...lin(pal.sand), this.precipVis], 76);
    u.set([this.snowVis, extent, tr.min, this.contours ? 1 : 0], 80);
    // ---- round 2 fields (see struct R in shaders.js) ----
    const dx = world.cellSize;
    const cur = this.cursor;
    if (cur.on) { const [cx, cz] = this.gridToWorld(cur.x, cur.y); u.set([cx, cz, cur.r * dx, cur.tool], 84); } else u.set([0, 0, 0, 0], 84);
    const rp = this.ripple;
    const rAge = rp ? (now - rp.t0) / 800 : 2;
    if (rp && rAge < 1) {
      const [rx, rz] = this.gridToWorld(rp.x, rp.y);
      u.set([rx, rz, rp.r * dx, rAge], 88);
      u.set([...(TOOL_RGB[rp.tool] || [1, 1, 1]), rp.tool], 92);
    } else u.set([0, 0, 0, 2], 88);
    const pre = atm.preset;
    u.set([this.droughtVis, pre.tAmp * c.seasonality, this.flash, this.treeScale], 96);
    const fo = pre.palette.forest || pre.forest || { conifer: 0.5, autumn: 0, shrub: 0 };
    u.set([fo.conifer, fo.autumn, fo.shrub, 1], 100);
    const fwd = [this.camera.target[0] - eye[0], this.camera.target[1] - eye[1], this.camera.target[2] - eye[2]];
    const fl = Math.hypot(...fwd) || 1;
    const f3 = fwd.map((v) => v / fl);
    let right = [-f3[2], 0, f3[0]];                                 // forward x world-up
    const rl = Math.hypot(...right) || 1; right = right.map((v) => v / rl);
    const up = [right[1] * f3[2] - right[2] * f3[1], right[2] * f3[0] - right[0] * f3[2], right[0] * f3[1] - right[1] * f3[0]];
    u.set([...right, sim.events.wind[0]], 104);
    u.set([...up, sim.events.wind[1]], 108);
    for (let k = 0; k < 4; k++) {
      const m = vis.markers[k];
      u.set(m ? [m[0], m[1], m[2], m[3]] : [0, 0, 0, 0], 112 + 4 * k);
      u[128 + k] = m ? m[4] : 0;
    }
    for (let k = 0; k < 4; k++) {
      const q = vis.storms[k];
      u.set(q ? [q[0], q[1], q[2], q[3]] : [0, 0, 0, 0], 132 + 4 * k);
    }
    // cloud deck above the peaks; snow if the storm's air is below freezing
    const cloudBase = (tr.max + 260) * this.vex;
    let snowT = 0;
    if (vis.storms.length) {
      const doy = sim.lastClimate?.dayOfYear ?? 172;
      snowT = c.airTempAt(doy, sim.datum + tr.mean) + (sim.events.climateMods(1).dT || 0) < 0.5 ? 1 : 0;
      // lightning in rain storms
      if (!sim.paused && snowT < 0.5 && Math.random() < 0.012 * this.stormStrength) this.flash = 1;
    }
    this.stormSnow += (snowT - this.stormSnow) * 0.1;
    this.flash *= this.flash > 0.3 && Math.random() < 0.3 ? 1.0 : 0.8;
    if (this.flash < 0.01) this.flash = 0;
    u.set([cloudBase, this.stormSnow, this.flash, cloudBase + 420 * this.vex], 148);
    const P11 = 1 / Math.tan(this.camera.fov / 2);
    const dens = world.N <= 512 ? 1 : world.N <= 1024 ? 0.5 : 0.25;
    u.set([this.canvas.width, this.canvas.height, P11, dens], 152);
    this.device.queue.writeBuffer(this.ub, 0, u);
    this.nStorms = vis.storms.length;

    if (this.frameCount % 2 === 0 || this.lightDirty) {
      this.lighting.update(encoder, atm.sun, this.vex, atm.preset.gwMax);
      this.lightDirty = false;
      if (this.showTrees) {
        // rebuild the tree / fire instance lists for this view
        const cf = new Float32Array(this.compRaw), cu = new Uint32Array(this.compRaw);
        cf.set(viewProj, 0);
        cu[16] = world.N; cu[17] = this.treeCap; cu[18] = this.fireCap; cu[19] = 0;
        cf[20] = world.cellSize; cf[21] = this.vex; cf[22] = 0.5 * this.canvas.height * P11; cf[23] = dens;
        this.device.queue.writeBuffer(this.compUB, 0, this.compRaw);
        this.device.queue.writeBuffer(this.drawArgs, 0, new Uint32Array([36, 0, 0, 0, 18, 0, 0, 0]));
        const cp = encoder.beginComputePass({ label: 'compact' });
        cp.setBindGroup(0, this.bgCompact);
        cp.setPipeline(this.kCompact.pipes.main);
        cp.dispatchWorkgroups(Math.ceil(world.N / 16), Math.ceil(world.N / 16));
        cp.setPipeline(this.kCompact.pipes.clampArgs);
        cp.dispatchWorkgroups(1);
        cp.end();
      }
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0.6, g: 0.7, b: 0.8, a: 1 } }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
      timestampWrites,
    });
    pass.setPipeline(this.pSky);
    pass.setBindGroup(0, this.bgSky);
    pass.draw(3);
    pass.setIndexBuffer(this.index, 'uint32');
    pass.setPipeline(this.pTerrain);
    pass.setBindGroup(0, this.bgTerrain);
    pass.drawIndexed(this.indexCount);
    pass.setPipeline(this.pSkirt);
    pass.setBindGroup(0, this.bgSkirt);
    pass.draw(4 * (world.N - 1) * 6);
    if (this.showTrees) {
      pass.setPipeline(this.pTrees);
      pass.setBindGroup(0, this.bgTrees);
      pass.drawIndirect(this.drawArgs, 0);
    }
    // The natural-looking water is hidden under the water/sediment overlays so their colours read cleanly.
    if (this.showWater && this.mode !== 1 && this.mode !== 2) {
      pass.setPipeline(this.pWater);
      pass.setBindGroup(0, this.bgWater);
      pass.drawIndexed(this.indexCount);
    }
    if (this.showTrees) {
      pass.setPipeline(this.pSmoke);
      pass.setBindGroup(0, this.bgSmoke);
      pass.drawIndirect(this.drawArgs, 16);
    }
    if (this.nStorms > 0) {
      pass.setPipeline(this.pStorm);
      pass.setBindGroup(0, this.bgStorm);
      pass.draw(480, this.nStorms);
    }
    if (this.precipVis > 0.01) {
      pass.setPipeline(this.pPrecip);
      pass.setBindGroup(0, this.bgPrecip);
      pass.draw(3);
    }
    pass.end();
  }
}
