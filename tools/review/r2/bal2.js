(async () => {
  const S = window.sim, out = {};
  S.pause();
  for (const seq of [['Temperate'], ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']]) {
    for (const p of seq) { await S.load('random', { size: 512, seed: 7, preset: p }); S.pause(); await S.run(365 * 100 + 200); }
    const s = await S.stats(); out[seq.join('>')] = { errPct: s.balanceErrorPct, err_m3: s.balanceError_m3, precip: s.cumPrecip_m3, out: s.cumOutflow_m3, evap: s.cumEvapLoss_m3, nan: s.hasNaN };
  }
  return out;
})()
