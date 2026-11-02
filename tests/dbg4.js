await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
const E = sim.engine, N = E.world.N;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const P = { x: 212, y: 152 };
const diag = async () => {
  const [c, so, w, v, e, rip, sn, bed] = await Promise.all(['clim', 'soil', 'water', 'veg', 'eco', 'rip', 'snowSWE', 'bedrock'].map((n) => E.readLayer(n)));
  const acc = { V: 0, T: 0, Wi: 0, Lgs: 0, Tgs: 0, tT: 0, wT: 0, sT: 0, fl: 0, KT: 0, h: 0, rip: 0, dzRef: 0, n: 0 };
  for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
    if (dx * dx + dy * dy > 100) continue;
    const i = (P.y + dy) * N + P.x + dx, o = 12 * i + 4;
    const Wi0 = c[o + 1] > 1e-9 ? c[o] / c[o + 1] : 0, Wi = Math.max(Wi0, 0.8 * rip[i]);
    const Lgs = c[o + 2] * 365, Tgs = c[o + 2] > 1e-4 ? c[o + 3] / c[o + 2] : -20;
    const tT = ss(4.8, 7.6, Tgs) * ss(60, 100, Lgs), wT = ss(0.18, 0.6, Wi), sT = 0.35 + 0.65 * ss(0.05, 0.6, so[i]), fl = 1 - ss(0.08, 0.5, w[i]);
    const r = { V: v[i], T: e[4 * i], Wi, Lgs, Tgs, tT, wT, sT, fl, KT: 0.92 * tT * wT * sT * fl, h: w[i], rip: rip[i], dzRef: bed[i] + so[i] - e[4 * i + 3] };
    for (const k in r) acc[k] += r[k]; acc.n++;
  }
  for (const k in acc) if (k !== 'n') acc[k] = +(acc[k] / acc.n).toFixed(4);
  acc.day = E.day % 365;
  return acc;
};
const out = { fast: await diag() };
await sim.run(365 * 10, { batchDays: 5, nSub: 32 });
out.slow10 = await diag();
await sim.run(365 * 10, { batchDays: 365000 / 60 });
out.fastAgain = await diag();
return out;
