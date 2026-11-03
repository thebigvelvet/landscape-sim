// Baseline before glaciers: adapter limits and where perennial snow piles up.
const e = sim.engine, out = { limits: { sb: e.device.limits.maxStorageBuffersPerShaderStage } };
for (const T of [0, -4, -8]) {
  sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
  e.climate.tempOffset = T;
  await e.run(300 * 365);
  const [sw, b, so] = await Promise.all(['snowSWE', 'bedrock', 'soil'].map((n) => e.readLayer(n)));
  let n = 0, mx = 0, zmin = 1e9; const N = e.N;
  for (let i = 0; i < N * N; i++) if (sw[i] > 2) { n++; mx = Math.max(mx, sw[i]); zmin = Math.min(zmin, b[i] + so[i] + e.datum); }
  out['T' + T] = { frac: n / (N * N), maxSWE: mx, lowestPerennial: zmin, range: e.terrainRange, datum: e.datum };
}
return out;
