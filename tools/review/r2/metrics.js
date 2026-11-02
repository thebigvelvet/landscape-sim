(async () => {
  const S = window.sim, E = S.engine, out = {};
  const err0 = window.__gpuErrors || 0;
  const mean = (a, cx, cy, r, N) => { let s = 0, c = 0; for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { s += a[y * N + x]; c++; } return s / c; };
  S.pause();
  for (const p of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
    await S.load('random', { size: 512, seed: 7, preset: p }); S.pause();
    const t = performance.now(); await S.run(365 * 100 + 200);
    const s = await S.stats();
    out[p] = { meanVeg: +s.meanVeg.toFixed(3), covered: +s.vegCoveredFrac.toFixed(3), balPct: s.balanceErrorPct, nan: s.hasNaN, run100yr_s: +((performance.now() - t) / 1000).toFixed(1) };
  }
  // wildfire: cover drop, post-fire erosion vs a same-size unburned circle, recovery
  await S.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' }); S.pause(); await S.run(365 * 20 + 150);
  const N = E.world.N; const A = [256, 300], B = [256, 180], r = 40;
  const vA0 = mean(await E.readLayer('veg'), ...A, r, N), vB0 = mean(await E.readLayer('veg'), ...B, r, N);
  const g0 = (await E.readLayer('bedrock')).map((v, i) => v), s0 = await E.readLayer('soil');
  S.brush('wildfire', { x: A[0], y: A[1], radius: r, intensity: 1, days: 3 });
  await S.run(20);
  const vA1 = mean(await E.readLayer('veg'), ...A, r, N);
  await S.run(365 * 3);
  const g1 = await E.readLayer('bedrock'), s1 = await E.readLayer('soil');
  const low = new Float32Array(N * N); for (let i = 0; i < N * N; i++) low[i] = (g0[i] + s0[i]) - (g1[i] + s1[i]);
  const vA3 = mean(await E.readLayer('veg'), ...A, r, N);
  await S.run(365 * 40);
  const vA40 = mean(await E.readLayer('veg'), ...A, r, N), vB40 = mean(await E.readLayer('veg'), ...B, r, N);
  out.fire = { coverBefore: +vA0.toFixed(3), afterFire: +vA1.toFixed(3), after3yr: +vA3.toFixed(3), after40yr: +vA40.toFixed(3), unburnedRef40yr: +vB40.toFixed(3),
    lowering3yr_mm_burned: +(1000 * mean(low, ...A, r, N)).toFixed(2), lowering3yr_mm_unburned: +(1000 * mean(low, ...B, r, N)).toFixed(2) };
  // storm: water delivered roughly matches (balance stays exact)
  S.brush('storm', { x: 256, y: 256, radius: 40, intensity: 1, days: 3 }); await S.run(10);
  S.brush('flood', { x: 256, y: 256, radius: 20, intensity: 1, days: 2 }); await S.run(10);
  S.brush('drought', { x: 256, y: 256, radius: 200, intensity: 1, days: 365 * 5 }); await S.run(365 * 6);
  const se = await S.stats(); out.afterAllBrushes = { balPct: se.balanceErrorPct, nan: se.hasNaN };
  // cone timing
  await S.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); S.pause();
  const t0 = performance.now(); await S.run(365000); const sc = await S.stats();
  out.cone1000 = { seconds: +((performance.now() - t0) / 1000).toFixed(1), balPct: sc.balanceErrorPct, nan: sc.hasNaN };
  // fps 1024 at 1000 yr/s
  await S.load('random', { size: 1024, seed: 7, preset: 'Colorado alpine' }); S.setSpeed(365000); S.play();
  await new Promise(r => setTimeout(r, 3000));
  out.fps1024 = await new Promise(res => { let n = 0; const t = performance.now(); (function f() { n++; if (performance.now() - t < 4000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t) / 1000)).toFixed(1)); })(); });
  S.pause();
  out.gpuErrors = (window.__gpuErrors || 0) - err0;
  return out;
})()
