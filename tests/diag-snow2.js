// Snow vs elevation for different batch lengths (looking for banding / multi-year scaling errors).
const out = {};
for (const bd of [30, 365, 365 * 16]) {
  await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
  await sim.run(365 * 160, { batchDays: bd, nSub: 4 });
  const e = sim.engine, N = e.N;
  const [sw, b, so] = await Promise.all(['snowSWE', 'bedrock', 'soil'].map((n) => e.readLayer(n)));
  const bins = {};
  for (let i = 0; i < N * N; i++) { const z = Math.round((b[i] + so[i] + e.datum) / 50) * 50; (bins[z] ||= []).push(sw[i]); }
  out['batch' + bd] = Object.keys(bins).map(Number).sort((a, c) => a - c).map((z) => {
    const a = bins[z]; a.sort((x, y) => x - y); return `${z}:${a[a.length >> 1].toFixed(2)}`;
  }).join(' ');
}
return out;
