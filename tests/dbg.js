const pickStats = (s) => ({ bal: s.balanceErrorPct, ero: s.maxErosion_m, dep: s.maxDeposition_m });
await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
const E = sim.engine, N = E.world.N;
const snap = async () => ({ v: await E.readLayer('veg'), b: await E.readLayer('bedrock'), so: await E.readLayer('soil') });
const out = {};
for (const [tag, bd, yrs] of [['fast', 365000 / 60, 20], ['slow', 5, 5], ['slow2', 5, 15]]) {
  E.modules.find((m) => m.name === 'erosion').enabled = true;
  const a = await snap();
  await sim.run(365 * yrs, { batchDays: bd, nSub: 32 });
  const b = await snap();
  let dSoil = 0, dBed = 0, dZpos = 0, dZneg = 0, dv = 0;
  for (let i = 0; i < N * N; i++) { dSoil += b.so[i] - a.so[i]; dBed += b.b[i] - a.b[i]; const dz = (b.so[i] + b.b[i]) - (a.so[i] + a.b[i]); if (dz > 0) dZpos += dz; else dZneg -= dz; dv += b.v[i] - a.v[i]; }
  const n = N * N;
  out[tag] = { meanSoilChange: dSoil / n, meanBedChange: dBed / n, meanDeposit: dZpos / n, meanLower: dZneg / n, meanVegChange: dv / n, s: pickStats(await sim.stats()) };
}
return out;
