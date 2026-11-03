// Quick glacier probe: grow ice at a few temperatures and report extent, speed and the books.
const e = sim.engine, out = {};
const temps = window.__temps || [-8, -6, -4, 0];
const years = window.__years || 1000;
for (const T of temps) {
  sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
  e.climate.tempOffset = T;
  e.glaciers = !window.__off;
  const t0 = performance.now();
  await e.run(years * 365, window.__batch ? { batchDays: window.__batch } : {});
  const s = await sim.stats();
  out['T' + T] = { ...(await sim.glacierStats()), glacierFrac: s.glacierFrac, balPct: s.balanceErrorPct, solidsErr: s.solidsError_m3, sedOut: s.cumSedimentOut_m3,
    snow_m3: s.totalSnowSWE_m3, nan: s.hasNaN, maxErosion: s.maxErosion_m, maxDep: s.maxDeposition_m, sec: (performance.now() - t0) / 1000 };
}
out.gpuErrors = window.__gpuErrors || 0; out.msgs = window.__gpuErrorMsgs;
return out;
