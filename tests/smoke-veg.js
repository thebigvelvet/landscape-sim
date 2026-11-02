const out = {};
for (const preset of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
  await sim.load('random', { size: 256, seed: 3, preset });
  sim.pause();
  const s0 = await sim.stats();
  await sim.run(365 * 50);
  const s1 = await sim.stats();
  out[preset] = { veg0: s0.meanVeg, cov0: s0.vegCoveredFrac, veg50: s1.meanVeg, cov50: s1.vegCoveredFrac, woody: s1.meanWoodyCover, bal: s1.balanceErrorPct, nan: s1.hasNaN, gw: s1.totalGroundwater_m3 };
}
return { out, gpuErrors: window.__gpuErrors || 0 };
