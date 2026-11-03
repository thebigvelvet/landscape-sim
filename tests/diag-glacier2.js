// Ice on steep beds: thickness, speed and step roughness.
const e = sim.engine;
await sim.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' }); sim.pause();
e.climate.tempOffset = -6;
await sim.run(365 * (window.__years || 1000));
const N = e.N, dx = e.cellSize;
const [g, b, so, sw] = await Promise.all(['glacier', 'bedrock', 'soil', 'snowSWE'].map((n) => e.readLayer(n)));
const bins = {};
let samples = [];
for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
  const i = y * N + x, H = g[4 * i];
  if (H < 1) continue;
  const z = (j) => b[j] + so[j];
  const s = Math.hypot(z(i + 1) - z(i - 1), z(i + N) - z(i - N)) / (2 * dx);
  const S = (j) => z(j) + sw[j] / 0.33 + g[4 * j];
  const ss = Math.hypot(S(i + 1) - S(i - 1), S(i + N) - S(i - N)) / (2 * dx);
  // second difference of the ice surface: steps / checkerboard
  const lap = Math.abs(S(i + 1) + S(i - 1) + S(i + N) + S(i - N) - 4 * S(i)) / (dx * dx);
  const k = s < 0.2 ? '<0.2' : s < 0.45 ? '0.2-0.45' : s < 0.8 ? '0.45-0.8' : '>0.8';
  const B = (bins[k] ||= { n: 0, H: 0, u: 0, surfTan: 0, lap: 0, deb: 0, maxH: 0 });
  B.n++; B.H += H; B.u += g[4 * i + 2]; B.surfTan += ss; B.lap += lap; B.deb += g[4 * i + 1]; B.maxH = Math.max(B.maxH, H);
  if (s > 0.8 && samples.length < 6 && H > 20) samples.push({ x, y, H, u: g[4 * i + 2], bedTan: s, surfTan: ss, row: [-2, -1, 0, 1, 2].map((d) => +g[4 * (i + d * N)].toFixed(1)) });
}
for (const k in bins) { const B = bins[k]; for (const f of ['H', 'u', 'surfTan', 'lap', 'deb']) B[f] = +(B[f] / B.n).toFixed(3); }
return { bins, samples, K: e.lastPlan.glacK, D: e.lastPlan.D };
