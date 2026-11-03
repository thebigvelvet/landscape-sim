// Lava spreading under different yield depths / viscosities (seed 4, vent in the middle).
//   node scripts/launch.cjs --eval=tests/diag-volcano2.js --out=tests/out-diag-volcano2.json
const e = sim.engine, V = e.volcanoes;
const out = [];
for (const [y, visc] of (window.__cases || [[0.12, 1e6], [0.06, 1e6], [0.12, 1e7]])) {
  sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
  V.params.lavaYield = y; V.params.lavaVisc = visc;
  const h0 = await e.readLayer('initHeight');
  const ev = sim.brush('volcano', { x: 128, y: 128 }); await ev.ready;
  const res = { yield: y, visc };
  for (const d of [120, 365, 1500]) {
    await e.run(d - e.day, { batchDays: 2 });
    const [lv, b, so] = await Promise.all(['lava', 'bedrock', 'soil'].map((n) => e.readLayer(n)));
    const vr = await e.readLayer('volcRock');
    const N = e.N; let cells = 0, maxH = 0, far = 0, basaltCells = 0, thick = 0, zSrc = null, zLow = Infinity;
    const src = V.vents[0].src;
    for (let i = 0; i < N * N; i++) {
      const x = i % N, yy = (i / N) | 0;
      const h = lv[4 * i];
      const isB = vr[8 * i + 4] === 1 || vr[8 * i + 5] === 1 || vr[8 * i + 6] === 1;
      if (h > 0.05 || isB) {
        const dist = Math.hypot(x - src.x, yy - src.y);
        far = Math.max(far, dist); zLow = Math.min(zLow, h0[i]);
      }
      if (h > 0.05) { cells++; maxH = Math.max(maxH, h); }
      if (isB && h < 0.05) { basaltCells++; thick += b[i] + so[i] - h0[i]; }
    }
    zSrc = h0[Math.round(src.y) * N + Math.round(src.x)];
    res['d' + d] = { moltenCells: cells, maxDepth: +maxH.toFixed(1), reach_m: far * 10, drop_m: +(zSrc - zLow).toFixed(0), basaltCells, meanBasaltThick: +(thick / Math.max(1, basaltCells)).toFixed(1) };
  }
  out.push(res);
}
return out;
