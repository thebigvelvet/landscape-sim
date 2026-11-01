// Diagnostics: where are the deep water cells and the biggest elevation changes after a run?
await sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 300);
const e = sim.engine, N = e.N;
const [w, b, so, init, sed] = await Promise.all(['water', 'bedrock', 'soil', 'initHeight', 'sediment'].map((n) => e.readLayer(n)));
const deep = [], big = [];
let wet = 0;
for (let i = 0; i < N * N; i++) {
  if (w[i] > 0.01) wet++;
  if (w[i] > 3) deep.push([i % N, (i / N) | 0, +w[i].toFixed(1)]);
  const dz = b[i] + so[i] - init[i];
  if (Math.abs(dz) > 3) big.push([i % N, (i / N) | 0, +dz.toFixed(1)]);
}
// neighbourhood of the deepest cell
let im = 0; for (let i = 0; i < N * N; i++) if (w[i] > w[im]) im = i;
const x0 = im % N, y0 = (im / N) | 0, nb = [];
for (let dy = -2; dy <= 2; dy++) { const row = []; for (let dx = -2; dx <= 2; dx++) { const j = (y0 + dy) * N + x0 + dx; row.push(`${(b[j] + so[j]).toFixed(1)}/${w[j].toFixed(2)}`); } nb.push(row.join('  ')); }
return { wetCells: wet, deepCount: deep.length, deep: deep.slice(0, 15), bigCount: big.length, big: big.slice(0, 25), deepest: [x0, y0], nb };
