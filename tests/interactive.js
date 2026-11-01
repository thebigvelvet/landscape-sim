// Interactive stress test: random 1024^2 terrain at 1000 years/s for 20 s of wall time, rendering on.
// Reports fps, governor sub-steps, stability. Leaves the view for a screenshot (--shot=...).
const size = window.__size || 1024, speed = window.__speed || 365000, secs = window.__secs || 20;
await sim.load('random', { size, seed: 4, preset: window.__preset || 'Colorado alpine' });
sim.setSpeed(speed); sim.play();
const e = sim.engine;
const t0 = performance.now(), d0 = e.day; let fr = 0, subs = 0, n = 0;
const fps = [], times = [];
const iv = setInterval(() => { subs += e.nSub; n++; fps.push(Math.round(e.fps)); times.push(sim.gpuTimes); }, 500);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(iv);
sim.pause();
const s = await sim.stats();
sim.renderer.overlay = window.__overlay || 'none';
return {
  size, speed, wallSec: (performance.now() - t0) / 1000, simYears: (e.day - d0) / 365,
  fpsSamples: fps, gpuTimesLast: times.slice(-3), avgSubsteps: subs / n, balanceErrPct: s.balanceErrorPct, hasNaN: s.hasNaN,
  maxErosion_m: s.maxErosion_m, maxDeposition_m: s.maxDeposition_m, maxDepth: s.maxWaterDepth, snow_m3: s.totalSnowSWE_m3,
  solidsErr: s.solidsError_m3, sedOut: s.cumSedimentOut_m3,
};
