// Snow vs elevation after a fast interactive run (looking for banding).
await sim.load('random', { size: 512, seed: 4, preset: 'Colorado alpine' });
sim.setSpeed(window.__speed || 365000); sim.play();
await new Promise((r) => setTimeout(r, 8000));
sim.pause();
const e = sim.engine, N = e.N;
const [sw, b, so] = await Promise.all(['snowSWE', 'bedrock', 'soil'].map((n) => e.readLayer(n)));
const bins = {};
for (let i = 0; i < N * N; i++) {
  const z = Math.round((b[i] + so[i] + e.datum) / 20) * 20;
  (bins[z] ||= []).push(sw[i]);
}
const rows = Object.keys(bins).map(Number).sort((a, b) => a - b).map((z) => {
  const a = bins[z]; a.sort((x, y) => x - y);
  return `${z}: n=${a.length} med=${a[a.length >> 1].toFixed(3)} max=${a[a.length - 1].toFixed(2)} frac>0.01=${(a.filter((v) => v > 0.01).length / a.length).toFixed(2)}`;
});
return { day: e.day, doy: e.day % 365, rows };
