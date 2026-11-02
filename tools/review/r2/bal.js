(async () => {
  const S = window.sim, E = S.engine, out = [];
  S.pause(); await S.load('random', { size: 512, seed: 7, preset: 'Temperate' }); S.pause();
  let prevErr = 0;
  for (let k = 0; k < 10; k++) {
    await S.run(3670);
    const s = await S.stats();
    out.push({ yr: Math.round(s.year), errPct: +s.balanceErrorPct.toExponential(2), stepErr_m3: Math.round(s.balanceError_m3 - prevErr), precip: Math.round(s.cumPrecip_m3), gw: Math.round(s.totalGroundwater_m3), water: Math.round(s.totalWater_m3), snow: Math.round(s.totalSnowSWE_m3), maxDepth: +s.maxWaterDepth.toFixed(1) });
    prevErr = s.balanceError_m3;
  }
  return out;
})()
