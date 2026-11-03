// Bootstrap: WebGPU device, simulation, renderer, UI, frame loop, governor, and the window.sim hook.
import { Simulation } from './sim/scheduler.js';
import { Renderer } from './render/renderer.js';
import { Panel } from './ui/panel.js';
import { PRESETS } from './sim/climate.js';
import { GpuTimer } from './gpuTimer.js';
import { BrushTool } from './ui/brush.js';
import { strataLayer, makeStrata } from './sim/strata.js';
import { volcLayer } from './sim/volcano.js';
import { bedsAt, depositSummary } from './sim/deposits.js';

const $ = (id) => document.getElementById(id);

function fatal(title, html) {
  const f = $('error');
  f.innerHTML = `<h2>${title}</h2>${html}`;
  f.classList.remove('hidden');
  $('loading').classList.add('hidden');
  window.__fatal = title;
}

const NO_WEBGPU = `<p>This simulator runs entirely on your graphics card using <b>WebGPU</b>, and WebGPU is not available here.</p>
<p>What usually fixes it:</p>
<ul><li>Update your graphics driver (NVIDIA: GeForce Experience or nvidia.com/drivers).</li>
<li>Use the desktop app (<code>start.bat</code>) or a current Chrome / Edge (version 113 or newer).</li>
<li>In Chrome, check <code>chrome://gpu</code> and make sure "WebGPU: Hardware accelerated" is listed.</li></ul>`;

async function initGPU() {
  if (!navigator.gpu) { fatal('WebGPU is not available', NO_WEBGPU); return null; }
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { fatal('No compatible graphics adapter', NO_WEBGPU); return null; }
  const want = ['maxStorageBuffersPerShaderStage', 'maxStorageBuffersInVertexStage', 'maxStorageBuffersInFragmentStage',
    'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize'];
  const requiredLimits = {};
  for (const k of want) if (adapter.limits[k] !== undefined) requiredLimits[k] = adapter.limits[k];
  const requiredFeatures = ['timestamp-query'].filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') fatal('The graphics device was lost', `<p>${info.message || ''}</p><p>This can happen after a driver update or if the GPU ran out of memory. <button onclick="location.reload()">Reload</button></p>`);
  });
  device.addEventListener('uncapturederror', (e) => {
    console.error('[WebGPU]', e.error?.message); window.__gpuErrors = (window.__gpuErrors || 0) + 1;
    const m = (window.__gpuErrorMsgs ||= []); if (m.length < 8 && !m.includes(e.error?.message)) m.push(e.error?.message);
  });
  return { adapter, device };
}

async function main() {
  const gpu = await initGPU();
  if (!gpu) return;
  const { device, adapter } = gpu;
  const canvas = $('view');
  const sim = new Simulation(device);
  const renderer = new Renderer(device, canvas, navigator.gpu.getPreferredCanvasFormat());
  sim.onWorldChanged = (w) => renderer.setWorld(w);
  const timer = new GpuTimer(device);
  sim.timer = timer;

  const busy = (msg) => {
    const b = $('loading');
    if (msg) { $('loading-text').textContent = msg; b.classList.remove('hidden', 'fade'); }
    else b.classList.add('fade');
  };
  let panel = null;
  let brushTool = null;
  let stats = null;
  let fpsEMA = 60, gpuMs = 0, gpuPending = false, frames = 0, lastT = performance.now(), statsPending = false;

  const app = {
    sim, renderer, device,
    async load(scenario, opts = {}) {
      busy(scenario === 'random' ? 'Raising mountains...' : 'Shaping the land...');
      await new Promise((r) => setTimeout(r, 30));   // let the overlay paint
      try {
        const res = await sim.load(scenario, opts);
        renderer.frameTerrain(sim.terrainRange);
        renderer.visuals.clear();
        brushTool?.refreshHeights(true);
        brushTool?.updateUndo();
        panel?.syncTerrain(res);
        panel?.sync();
        stats = await sim.stats();
        return res;
      } finally { busy(''); }
    },
    setSpeed(v) { sim.speed = Math.min(365000, Math.max(0.01, +v)); panel?.sync(); },
    pause() { sim.paused = true; panel?.sync(); },
    play() { sim.paused = false; panel?.sync(); },
    async bench(sizes = [256, 512, 1024]) {
      const prev = { scenario: sim.scenario, size: sim.N, seed: sim.seed, cellSize: sim.cellSize };
      const prevSpeed = sim.speed, prevPaused = sim.paused, prevSub = sim.nSub;
      const out = {};
      for (const N of sizes) {
        busy(`Benchmark ${N}×${N}...`);
        await sim.load('random', { size: N, seed: 7 });
        sim.paused = true;
        // 1) raw throughput: hydraulic sub-steps/s (flux + update + erosion per sub-step, plus the
        //    per-batch column, thermal and accounting kernels), no rendering
        const nb = 16;
        for (let k = 0; k < 6; k++) sim._batch(1, 1, nb);
        await device.queue.onSubmittedWorkDone();
        const K = N >= 1024 ? 30 : 60;
        const t0 = performance.now();
        for (let k = 0; k < K; k++) sim._batch(1, 1, nb);
        await device.queue.onSubmittedWorkDone();
        const dt = (performance.now() - t0) / 1000;
        const steps = K * nb;
        // 2) interactive: 1 yr/s with rendering and the governor for 3 s
        busy('');
        sim.speed = 365; sim.paused = false; sim.nSub = 16;
        await new Promise((r) => setTimeout(r, 1000));          // let the governor settle
        const f0 = frames, tt0 = performance.now(); let subSum = 0, subN = 0;
        const iv = setInterval(() => { subSum += sim.nSub; subN++; }, 100);
        await new Promise((r) => setTimeout(r, 3000));
        clearInterval(iv);
        const fps = (frames - f0) / ((performance.now() - tt0) / 1000);
        out[N] = {
          stepsPerSec: steps / dt, msPerSubstep: (1000 * dt) / steps, mcellUpdatesPerSec: (steps * N * N) / dt / 1e6,
          fps, substepsPerFrame: Math.round(subSum / Math.max(1, subN)), simDaysPerSecAt1yrPerSec: 365,
        };
        sim.paused = true;
      }
      busy('');
      await app.load(prev.scenario || 'random', { size: prev.size, seed: prev.seed, cellSize: prev.cellSize });
      sim.speed = prevSpeed; sim.paused = prevPaused; sim.nSub = prevSub;
      panel?.sync();
      console.table(out);
      return out;
    },
  };

  // URL params
  const q = new URLSearchParams(location.search);
  const scenario = q.get('scenario') || 'random';
  const preset = q.get('preset') && PRESETS[q.get('preset')] ? q.get('preset') : 'Colorado alpine';
  const size = +q.get('size') || 512;
  const seed = q.has('seed') ? +q.get('seed') : 1;
  if (q.has('speed')) sim.speed = +q.get('speed');
  if (q.has('paused')) sim.paused = q.get('paused') !== '0';

  panel = new Panel(app);
  brushTool = new BrushTool(app);
  await app.load(scenario, { size, seed, preset });

  // ------------- sub-step governor -------------
  // Keeps GPU work per frame near BUDGET_MS so the UI stays at display rate while the hydraulic
  // solver gets every spare cycle. Uses timestamp queries (exact GPU pass times); falls back to
  // queue-completion latency where timestamps are unavailable.
  const BUDGET_MS = 11;
  function governor() {
    if (sim.paused || sim.running) return;
    if (timer.ok) {
      if (timer.samples < 4 || frames % 6) return;
      gpuMs = timer.simMs + timer.renderMs;
      const per = timer.simMs / Math.max(2, sim.nSub);
      if (per <= 0) return;
      const target = Math.max(2, Math.min(sim.maxSub, (BUDGET_MS - timer.renderMs) / per));
      let n = sim.nSub + Math.max(-Math.ceil(sim.nSub * 0.25), Math.min(Math.ceil(sim.nSub * 0.25) + 1, target - sim.nSub));
      n = Math.max(2, Math.min(sim.maxSub, Math.round(n / 2) * 2));
      sim.nSub = n;
      return;
    }
    if (!gpuPending) {
      gpuPending = true;
      const t0 = performance.now();
      device.queue.onSubmittedWorkDone().then(() => {
        const ms = performance.now() - t0;
        gpuMs = gpuMs ? gpuMs * 0.8 + ms * 0.2 : ms;
        gpuPending = false;
        if (gpuMs > 13 && sim.nSub > 2) sim.nSub -= 2;
        else if (gpuMs < 8 && sim.nSub < sim.maxSub) sim.nSub += 2;
      });
    }
  }

  // ------------- frame loop -------------
  function frame(now) {
    const dt = (now - lastT) / 1000; lastT = now;
    if (dt > 0) fpsEMA = fpsEMA * 0.95 + (1 / dt) * 0.05;
    sim.fps = fpsEMA;
    frames++;
    try {
      sim.tick(dt);
      const enc = device.createCommandEncoder({ label: 'render' });
      renderer.encode(enc, sim, timer.renderPassTimestamps());
      timer.resolveInto(enc);
      device.queue.submit([enc.finish()]);
      timer.collect();
    } catch (e) { console.error(e); }
    governor();
    if (frames % 15 === 0 && !statsPending && sim.world && !sim.running) {
      statsPending = true;
      sim.stats().then((s) => { stats = s; }).catch(() => {}).finally(() => { statsPending = false; });
    }
    panel.updateHud();
    if (frames % 15 === 0) panel.update({ fps: fpsEMA, gpuMs, stats, timed: timer.ok, simMs: timer.simMs, renderMs: timer.renderMs, adapter: `${adapter.info?.vendor || ''} ${adapter.info?.architecture || ''}`.trim() });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------- test hook -------------
  window.sim = {
    load: (name, opts = {}) => app.load(name, opts),
    run: async (days, opts) => { const d = await sim.run(days, opts); stats = await sim.stats(); return d; },
    setSpeed: (v) => app.setSpeed(v),
    pause: () => app.pause(),
    play: () => app.play(),
    stats: () => sim.stats(),
    setOverlay: (o) => panel.setOverlay(o),
    bench: (sizes) => app.bench(sizes),
    // Weather brushes: same as clicking with that tool at grid cell (x, y). type: storm | drought |
    // flood | wildfire. Returns the event (type, x, y, r, ...).
    brush: (type, opts = {}) => {
      const N = sim.N;
      return brushTool.apply(type, opts.x ?? N / 2, opts.y ?? N / 2, opts);
    },
    // Sculpting: one undoable stroke of `dabs` dabs along `points` ([{x, y}], grid cells). op: raise |
    // lower | smooth | flatten | channel. opts: radius, intensity, target (flatten, default = ground
    // at the first point). Heights for flatten/channel come from a fresh read of the ground.
    sculptStroke: async (op, points, opts = {}) => {
      const H = await sim.readLayer('bedrock'), S = await sim.readLayer('soil');
      for (let i = 0; i < H.length; i++) H[i] += S[i];
      const N = sim.N, at = (x, y) => H[Math.min(N - 1, Math.max(0, Math.round(y))) * N + Math.min(N - 1, Math.max(0, Math.round(x)))];
      const dabs = opts.dabs ?? 1, target = opts.target ?? at(points[0].x, points[0].y);
      sim.beginStroke();
      let last = points[0];
      for (const p of points) {
        for (let k = 0; k < dabs; k++) {
          const o = { x: p.x, y: p.y, radius: opts.radius ?? 15, intensity: opts.intensity ?? 1, ground: at(p.x, p.y), target };
          if (op === 'channel') Object.assign(o, { ax: last.x, ay: last.y, za: at(last.x, last.y), zb: at(p.x, p.y) });
          sim.sculpt(op, o);
        }
        last = p;
      }
      await sim.endStroke();
      brushTool.updateUndo(); await brushTool.refreshHeights(true);
    },
    undo: () => brushTool.undo(),
    setTool: (t) => brushTool.setTool(t),
    pick: (clientX, clientY) => brushTool.pick(clientX, clientY),
    screenOf: (x, y) => brushTool.screenOf(x, y),
    refreshHeights: () => brushTool.refreshHeights(true),
    get brushTool() { return brushTool; },
    setPreset: (name) => { sim.climate.setPreset(name); sim.datum = sim.climate.preset.baseElevation; panel.sync(); },
    // rock layers (sim/strata.js): bed index at bedrock height z in cell (x, y), this landscape's
    // bed table and structure, and the generator itself (for statistics over many seeds)
    strataLayer: (z, x, y, T = sim.strataInfo) => strataLayer(z, x, y, T),
    get strataBeds() { return sim.strataInfo?.beds; },
    get strataStructure() { return sim.strataInfo?.struct; },
    makeStrata,
    // sediment beds (sim/deposits.js): one cell's stack (top bed first) and a whole-map summary
    bedsAt: async (x, y) => bedsAt(await sim.readLayer('deposit'), y * sim.N + x),
    depositStats: async () => depositSummary(await sim.readLayer('deposit'), sim.world.cells, sim.world.cellSize ** 2),
    // wind (sim/wind.js): settings (from = compass bearing it blows from, speed, steady 0..1, on) and
    // a whole-map summary of the wind field and the wind-blown sand
    get wind() { return { ...sim.climate.windSettings(), on: sim.windOn }; },
    setWind: (o = {}) => {
      if (o.from !== undefined) sim.climate.windFrom = +o.from;
      if (o.speed !== undefined) sim.climate.windSpeed = +o.speed;
      if (o.steady !== undefined) sim.climate.windSteady = +o.steady;
      if (o.on !== undefined) sim.windOn = !!o.on;
      panel.syncWind();
      return window.sim.wind;
    },
    windStats: async () => {
      const w = await sim.readLayer('wind'), dep = await sim.readLayer('deposit'), cells = sim.world.cells;
      let u = 0, lee = 0, sandCells = 0, sandVol = 0;
      for (let i = 0; i < cells; i++) {
        u += w[4 * i + 2]; if (w[4 * i + 3] < 0.5) lee++;
        const th = dep[16 * i], g = (dep[16 * i + 8] % 1) / 0.99;
        if (th > 0.05 && g >= 0.45 && g <= 0.85) { sandCells++; sandVol += th; }
      }
      return { meanWind: u / cells, shelteredFrac: lee / cells, sandCoverFrac: sandCells / cells, topSandVolume_m3: sandVol * sim.world.cellSize ** 2, lastBatch: sim.windPlan };
    },
    // glaciers (sim/glacier.js): on/off and a whole-map summary
    get glaciers() { return sim.glaciers; },
    set glaciers(v) { sim.glaciers = !!v; const el = document.getElementById('glaciers'); if (el) el.checked = sim.glaciers; },
    glacierStats: async () => {
      const g = await sim.readLayer('glacier'), b = await sim.readLayer('bedrock'), so = await sim.readLayer('soil'), cells = sim.world.cells;
      let ice = 0, n = 0, maxH = 0, maxU = 0, deb = 0, zLow = Infinity, zHigh = -Infinity;
      for (let i = 0; i < cells; i++) {
        const H = g[4 * i];
        ice += H; deb += g[4 * i + 1] + g[4 * i + 3];
        if (H > 1) { n++; const z = b[i] + so[i] + sim.datum; zLow = Math.min(zLow, z); zHigh = Math.max(zHigh, z); }
        maxH = Math.max(maxH, H); maxU = Math.max(maxU, g[4 * i + 2]);
      }
      const A = sim.world.cellSize ** 2;
      return { iceVolume_m3: ice * A, iceCoverFrac: n / cells, maxThickness_m: maxH, maxSpeed_m_per_yr: maxU, debris_m3: deb * A, lowestIce_m: n ? zLow : null, highestIce_m: n ? zHigh : null };
    },
    // volcanoes (sim/volcano.js): old volcanoes in new maps on/off, the rock type at bedrock height z
    // in cell (x, y) from a volcRock readback (0 plateau rock, 1 basalt, 2 cinders, 3 plug), and a
    // whole-map summary
    get oldVolcanoes() { return sim.oldVolcanoes; },
    set oldVolcanoes(v) { sim.oldVolcanoes = !!v; const el = document.getElementById('old-volcanoes'); if (el) el.checked = sim.oldVolcanoes; },
    get volcanoInfo() { return sim.volcanoInfo; },
    volcLayer: (vr, x, y, z) => volcLayer(vr, y * sim.N + x, z),
    volcanoStats: async () => {
      const [vr, lv, b] = await Promise.all(['volcRock', 'lava', 'bedrock'].map((n) => sim.readLayer(n)));
      const cells = sim.world.cells, A = sim.world.cellSize ** 2;
      const vol = [0, 0, 0, 0], area = [0, 0, 0, 0];
      let molten = 0, hot = 0;
      for (let i = 0; i < cells; i++) {
        molten += lv[4 * i]; if (lv[4 * i] > 0.01 && lv[4 * i + 1] >= 0.15) hot++;
        if (vr[8 * i + 4] < 0.5) continue;
        // thickness of each unit still standing in this cell
        for (let k = 0; k < 4; k++) {
          const t = vr[8 * i + 4 + k];
          if (t < 0.5) break;
          const lo = vr[8 * i + k], hi = k < 3 && vr[8 * i + 5 + k] > 0.5 ? vr[8 * i + 1 + k] : Infinity;
          const th = Math.min(hi, b[i]) - lo;
          if (th > 0) { vol[t] += th * A; if (b[i] <= hi) area[t] += A; }
        }
      }
      const vents = sim.volcanoes.vents.map((e) => ({ id: e.id, x: e.x, y: e.y, coneHeight_m: e.H || 0, left_days: Math.max(e.left, 0), source: e.src }));
      return { basalt_m3: vol[1], cinders_m3: vol[2], plug_m3: vol[3], basaltArea_m2: area[1], cindersArea_m2: area[2], plugArea_m2: area[3], moltenLava_m3: molten * A, hotLavaCells: hot, erupting: sim.volcanoes.erupting, erupted_m3: sim.cum.erupted, vents };
    },
    get engine() { return sim; },
    get renderer() { return renderer; },
    get gpuTimes() { return { timed: timer.ok, simMs: timer.simMs, renderMs: timer.renderMs, nSub: sim.nSub }; },
    adapterInfo: adapter.info,
  };
  window.dispatchEvent(new Event('sim-ready'));
}

main().catch((e) => { console.error(e); fatal('Something went wrong while starting', `<pre>${String(e?.stack || e)}</pre>`); });
