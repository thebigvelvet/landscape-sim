// Run in the page via the Electron harness:
//   node scripts/launch.cjs --eval=tests/timestep-consistency.js --out=tests/out-consistency.json
// The same 300 simulated years on the cone with batch lengths differing 6x (and morphological
// factors differing 6x). If the time scaling is principled, erosion and sediment yield agree closely.
// Then the default sim.run(1000 years) for reference.
const out = {};
const pick = (s) => ({
  sedOut_m3: Math.round(s.cumSedimentOut_m3), maxErosion_m: +s.maxErosion_m.toFixed(2), maxDeposition_m: +s.maxDeposition_m.toFixed(2),
  balanceErrPct: s.balanceErrorPct, solidsErr_m3: +s.solidsError_m3.toFixed(1), nan: s.hasNaN,
  outflowFrac: +(s.cumOutflow_m3 / s.cumPrecip_m3).toFixed(4), evapFrac: +(s.cumEvapLoss_m3 / s.cumPrecip_m3).toFixed(4),
  maxDepth_m: +s.maxWaterDepth.toFixed(2), morph: Math.round(s.morph),
});
for (const bd of [10, 60]) {
  await sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); sim.pause();
  const t0 = performance.now();
  await sim.run(365 * 300, { batchDays: bd, nSub: 32 });
  out['cone300y_batch' + bd + 'd'] = { ...pick(await sim.stats()), sec: +((performance.now() - t0) / 1000).toFixed(1) };
}
await sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); sim.pause();
const t0 = performance.now();
await sim.run(365000);
out.cone1000y_default = { ...pick(await sim.stats()), sec: +((performance.now() - t0) / 1000).toFixed(1) };
return out;
