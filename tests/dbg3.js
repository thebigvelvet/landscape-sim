const out = {};
for (const mode of ['all']) {
  await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
  const E = sim.engine, N = E.world.N;
  const er = E.modules.find((m) => m.name === 'erosion');
  er.enabled = true; if (er._rt) er.recordThermal = er._rt;
  await sim.run(365 * 200, { batchDays: 365000 / 60 });
  const a = { v: await E.readLayer('veg'), b: await E.readLayer('bedrock'), so: await E.readLayer('soil') };
  er._rt = er._rt || er.recordThermal;
  if (mode === 'noThermal' || mode === 'noBoth') er.recordThermal = () => {};
  if (mode === 'noFluvial' || mode === 'noBoth') er.enabled = false;
  await sim.run(365 * 3, { batchDays: 5, nSub: 32 });
  const b = { v: await E.readLayer('veg'), b: await E.readLayer('bedrock'), so: await E.readLayer('soil') };
  let dv = 0, low = 0, n = N * N;
  for (let i = 0; i < n; i++) { dv += b.v[i] - a.v[i]; const dz = b.b[i] + b.so[i] - a.b[i] - a.so[i]; if (dz < 0) low -= dz; }
  out[mode] = { dVeg: dv / n, meanLowering: low / n };
  er.recordThermal = er._rt; er.enabled = true;
}
return out;
