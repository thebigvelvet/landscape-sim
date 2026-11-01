// Bootstrap: WebGPU device, simulation, renderer, UI, frame loop, governor, and the window.sim hook.
import { Simulation } from './sim/scheduler.js';
import { Renderer } from './render/renderer.js';
import { Panel } from './ui/panel.js';
import { PRESETS } from './sim/climate.js';
import { GpuTimer } from './gpuTimer.js';

const $ = (id) => document.getElementById(id);

function fatal(title, html) {
  const f = $('fatal');
  f.innerHTML = `<div class="box"><h2>${title}</h2>${html}</div>`;
  f.hidden = false;
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
  device.addEventListener('uncapturederror', (e) => { console.error('[WebGPU]', e.error?.message); window.__gpuErrors = (window.__gpuErrors || 0) + 1; });
  return { adapter, device };
}

async function main() {
  const gpu = await initGPU();
  if (!gpu) return;
  const { device, adapter } = gpu;
  const canvas = $('gpu');
  const sim = new Simulation(device);
  const renderer = new Renderer(device, canvas, navigator.gpu.getPreferredCanvasFormat());
  sim.onWorldChanged = (w) => renderer.setWorld(w);
  const timer = new GpuTimer(device);
  sim.timer = timer;

  const busy = (msg) => { const b = $('busy'); b.textContent = msg || ''; b.hidden = !msg; };
  let panel = null;
  let stats = null;
  let fpsEMA = 60, gpuMs = 0, gpuPending = false, frames = 0, lastT = performance.now(), statsPending = false;

  const app = {
    sim, renderer, device,
    async load(scenario, opts = {}) {
      busy('Generating terrain...');
      await new Promise((r) => setTimeout(r, 20));
      try {
        const res = await sim.load(scenario, opts);
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

  panel = new Panel($('panel'), app);
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
    bench: (sizes) => app.bench(sizes),
    setPreset: (name) => { sim.climate.setPreset(name); sim.datum = sim.climate.preset.baseElevation; panel.sync(); },
    get engine() { return sim; },
    get renderer() { return renderer; },
    get gpuTimes() { return { timed: timer.ok, simMs: timer.simMs, renderMs: timer.renderMs, nSub: sim.nSub }; },
    adapterInfo: adapter.info,
  };
  window.dispatchEvent(new Event('sim-ready'));
}

main().catch((e) => { console.error(e); fatal('Something went wrong while starting', `<pre>${String(e?.stack || e)}</pre>`); });
