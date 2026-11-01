const out = {};
await sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); sim.pause();
out.s0 = await sim.stats();
await sim.run(365 * 100);
out.s100 = await sim.stats();
out.errors = window.__errors; out.gpuErrors = window.__gpuErrors || 0;
for (const k of ['s0','s100']) { const s = out[k]; out[k] = { meanVeg: s.meanVeg, cov: s.vegCoveredFrac, burned: s.burnedFrac, bal: s.balanceErrorPct, nan: s.hasNaN, gw: s.totalGroundwater_m3, precip: s.cumPrecip_m3, out: s.cumOutflow_m3, evap: s.cumEvapLoss_m3, maxEro: s.maxErosion_m, sedOut: s.cumSedimentOut_m3 }; }
return out;
