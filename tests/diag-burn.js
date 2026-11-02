const e = sim.engine; const out = {};
const layer = (n) => e.readLayer(n);
for (const mode of ['normal', 'bare', 'burnt']) {
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' }); sim.pause();
  const N = e.N;
  const b0 = await layer('bedrock'), s0 = await layer('soil');
  if (mode !== 'normal') {
    e.device.queue.writeBuffer(e.world.buffers.veg, 0, new Float32Array(N * N));
    if (mode === 'burnt') e.device.queue.writeBuffer(e.world.buffers.burn, 0, new Float32Array(N * N).fill(1));
  }
  e.climate.triggerStorm(3, 12); await e.run(10);
  const b1 = await layer('bedrock'), s1 = await layer('soil'), v = await layer('veg');
  let lower = 0, absd = 0, vs = 0; for (let i = 0; i < N * N; i++) { const d = (b0[i] + s0[i]) - (b1[i] + s1[i]); lower += d; absd += Math.abs(d); vs += v[i]; }
  const s = await sim.stats();
  out[mode] = { meanAbsChange: absd / (N * N), sedOut: s.cumSedimentOut_m3, maxEro: s.maxErosion_m, outflow: s.cumOutflow_m3, meanVeg: vs / (N * N) };
}
return out;
