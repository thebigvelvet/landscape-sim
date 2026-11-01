(async () => {
  const S = window.sim, E = S.engine; const out = {};
  await S.load('random', { size: 512, seed: 7, preset: 'Temperate' });
  await S.run(73000 + 200);   // late July
  const N = E.world.N, gm = E.climate.preset.gwMax;
  const gw = await E.readLayer('groundwater'), br = await E.readLayer('bedrock'), so = await E.readLayer('soil'), fr = await E.readLayer('frostDepth');
  const h = (x, y) => { const i = y * N + x; return br[i] + so[i]; };
  const R = 6; const bins = { hollow: [0, 0], mid: [0, 0], ridge: [0, 0] }; let frozen = 0;
  for (let y = R; y < N - R; y += 2) for (let x = R; x < N - R; x += 2) {
    let s = 0, c = 0; for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { s += h(x + dx, y + dy); c++; }
    const rel = h(x, y) - s / c; const i = y * N + x; if (fr[i] > 0.03) frozen++;
    const b = rel < -3 ? 'hollow' : rel > 3 ? 'ridge' : 'mid';
    bins[b][0] += gw[i] / gm; bins[b][1]++;
  }
  for (const k in bins) out[k] = { meanFill: bins[k][0] / bins[k][1], n: bins[k][1] };
  out.frozenCells = frozen;
  // elevation dependence
  return out;
})()
