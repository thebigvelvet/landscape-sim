(async () => {
  const S = window.sim, E = S.engine; S.pause();
  await S.load('cone', { size: 512, seed: 1, preset: 'Temperate' }); S.pause(); await S.run(365 * 30 + 150);
  const N = E.world.N, A = [370, 256], B = [142, 256], r = 70;
  const H = async () => { const b = await E.readLayer('bedrock'), s = await E.readLayer('soil'); return b.map((v, i) => v + s[i]); };
  const stat = (d, c) => { let s = 0, n = 0, mx = 0; for (let y = c[1] - r; y <= c[1] + r; y++) for (let x = c[0] - r; x <= c[0] + r; x++) if ((x - c[0]) ** 2 + (y - c[1]) ** 2 <= r * r) { const v = d[y * N + x]; s += v; n++; mx = Math.max(mx, v); } return { meanLowering_mm: +(1000 * s / n).toFixed(2), maxCut_cm: +(100 * mx).toFixed(1) }; };
  const h0 = await H();
  S.brush('wildfire', { x: A[0], y: A[1], radius: r, intensity: 1, days: 3 }); await S.run(5);
  const veg = await E.readLayer('veg'); let vb = 0, n = 0; for (let y = A[1] - 20; y <= A[1] + 20; y++) for (let x = A[0] - 20; x <= A[0] + 20; x++) { vb += veg[y * N + x]; n++; }
  for (const c of [A, B]) S.brush('storm', { x: c[0], y: c[1], radius: r + 20, intensity: 1, days: 3 });
  await S.run(30);
  for (const c of [A, B]) S.brush('storm', { x: c[0], y: c[1], radius: r + 20, intensity: 1, days: 3 });
  await S.run(365 * 2);
  const h1 = await H(); const d = h0.map((v, i) => v - h1[i]);
  return { coverInBurnCenter: +(vb / n).toFixed(2), burned: stat(d, A), unburnedTwin: stat(d, B), bal: (await S.stats()).balanceErrorPct };
})()
