const out = {};
const e = sim.engine;
for (const bd of (window.__bds || [10, 365, 6083])) {
  await sim.load('random', { size: 256, seed: 8, preset: 'Temperate' }); sim.pause();
  const L0 = { aux: await e.readLayer('vegAux'), veg: await e.readLayer('veg'), soil: await e.readLayer('soil') };
  e.climate.tempOffset = window.__dT ?? -3;
  await sim.run((window.__yrs || 150) * 365, { batchDays: bd, nSub: 8 });
  e.climate.tempOffset = 0;
  const aux = await e.readLayer('vegAux'), veg = await e.readLayer('veg'), soil = await e.readLayer('soil'), gw = await e.readLayer('groundwater');
  const N = 256 * 256; let W = 0, V = 0, S = 0, G = 0, W0 = 0, V0 = 0, S0 = 0, inf = 0;
  for (let i = 0; i < N; i++) { W += aux[4 * i]; inf += aux[4*i+1]; V += veg[i]; S += soil[i]; G += gw[i]; W0 += L0.aux[4 * i]; V0 += L0.veg[i]; S0 += L0.soil[i]; }
  const s = await sim.stats();
  out[bd] = { W0: W0 / N, W: W / N, V0: V0 / N, V: V / N, soil0: S0 / N, soil: S / N, gw: G / N, inf: inf/N, et: s.cumEvapLoss_m3 / s.cumPrecip_m3, outf: s.cumOutflow_m3 / s.cumPrecip_m3 };
}
return out;
