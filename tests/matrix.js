// Stability matrix: every scenario x preset at the two extremes of the time scale.
//   slow: 3 days in 1-minute-of-climate batches (1 day/s equivalent: real-time hydrology)
//   fast: 5000 years in 6083-day batches (1000 yr/s equivalent: maximum morphological factor)
const out = {};
for (const scen of ['cone', 'valley', 'random']) {
  for (const preset of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
    const row = {};
    for (const [tag, days, bd] of [['slow', 3, 1 / 60], ['fast', 365 * 5000, 365000 / 60]]) {
      await sim.load(scen, { size: 256, seed: 2, preset }); sim.pause();
      await sim.run(days, { batchDays: bd, nSub: 16 });
      const s = await sim.stats();
      row[tag] = `nan=${s.hasNaN} bal=${s.balanceErrorPct.toExponential(1)}% ero=${s.maxErosion_m.toFixed(1)} dep=${s.maxDeposition_m.toFixed(1)} h=${s.maxWaterDepth.toFixed(1)} snow=${(s.totalSnowSWE_m3 / 1e6).toFixed(2)}Mm3 out/P=${(s.cumOutflow_m3 / Math.max(1, s.cumPrecip_m3)).toFixed(2)} z=${Math.round(s.minHeight)}..${Math.round(s.maxHeight)}`;
    }
    out[`${scen} / ${preset}`] = row;
  }
}
return out;
