// Round 3 test suite (sculpt brushes, undo, snow avalanches). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/round3.js --out=tests/out-round3.json
// Every check records its numbers and a pass flag; `allPass` summarises.
const e = sim.engine;
const R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const layer = (n) => e.readLayer(n);
const ground = async () => { const b = await layer('bedrock'), s = await layer('soil'); for (let i = 0; i < b.length; i++) b[i] += s[i]; return b; };
const disc = (N, cx, cy, r, f) => { for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, cx + r); x++) { const d = Math.hypot(x - cx, y - cy); if (d <= r) f(y * N + x, d, x, y); } };
const discMean = (a, N, cx, cy, r) => { let s = 0, n = 0; disc(N, cx, cy, r, (i) => { s += a[i]; n++; }); return s / n; };
const t0 = performance.now();

// 1-3. Raise and lower, the books, and undo (valley, paused, then a year of weather in between)
{
  sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' });
  sim.pause();
  const N = e.N;
  const g0 = await ground(), h0 = await layer('initHeight');
  await sim.sculptStroke('raise', [{ x: 90, y: 150 }], { radius: 15, dabs: 10 });
  await sim.sculptStroke('lower', [{ x: 170, y: 150 }], { radius: 15, dabs: 5 });
  const g1 = await ground(), h1 = await layer('initHeight');
  let outside = 0, overlay = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (Math.hypot(x - 90, y - 150) > 15.5 && Math.hypot(x - 170, y - 150) > 15.5) outside = Math.max(outside, Math.abs(g1[i] - g0[i]));
    overlay = Math.max(overlay, Math.abs((g1[i] - h1[i]) - (g0[i] - h0[i])));
  }
  const up = g1[150 * N + 90] - g0[150 * N + 90], down = g1[150 * N + 170] - g0[150 * N + 170];
  check('raiseLower', Math.abs(up - 10) < 0.05 && Math.abs(down + 5) < 0.05 && outside < 1e-3, { centreRaise_m: up, centreLower_m: down, maxChangeOutside_m: outside });

  // books: the overlay does not show the sculpting; solids stay balanced through a year of weather
  let vol = 0; for (let i = 0; i < N * N; i++) vol += Math.abs(g1[i] - g0[i]) * e.world.cellSize ** 2;
  await e.run(365);
  const s = await sim.stats();
  check('books', overlay < 1e-3 && Math.abs(s.solidsError_m3) < 1e-3 * vol && !s.hasNaN, { overlayChange_m: overlay, solidsError_m3: s.solidsError_m3, sculptedVolume_m3: vol, balPct: s.balanceErrorPct });

  // undo both strokes: the reference heights come back exactly and the year of erosion is kept
  const g2 = await ground(), h2 = await layer('initHeight');
  const u1 = await sim.undo(), u2 = await sim.undo(), u3 = await sim.undo();
  const g3 = await ground(), h3 = await layer('initHeight');
  let hErr = 0, erosionKept = 0, centreBack = 0;
  for (let i = 0; i < N * N; i++) {
    hErr = Math.max(hErr, Math.abs(h3[i] - h0[i]));
    erosionKept = Math.max(erosionKept, Math.abs((g3[i] - h3[i]) - (g2[i] - h2[i])));
  }
  centreBack = Math.max(Math.abs(g3[150 * N + 90] - g0[150 * N + 90]), Math.abs(g3[150 * N + 170] - g0[150 * N + 170]));
  check('undo', !!u1 && !!u2 && !u3 && hErr < 1e-3 && erosionKept < 1e-3 && centreBack < 1, { initHeightErr_m: hErr, erosionChangeByUndo_m: erosionKept, centreVsOriginal_m: centreBack, canUndoAfter: e.canUndo });
}

// 4. Flatten reaches its target; smooth takes the roughness out
{
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Colorado alpine' });
  sim.pause();
  const N = e.N, cx = 128, cy = 128, r = 20;
  const g0 = await ground();
  const target = discMean(g0, N, cx, cy, r);
  await sim.sculptStroke('flatten', [{ x: cx, y: cy }], { radius: r, dabs: 60, target });
  const g1 = await ground();
  let dev0 = 0, dev1 = 0, n = 0;
  disc(N, cx, cy, r * 0.4, (i) => { dev0 += Math.abs(g0[i] - target); dev1 += Math.abs(g1[i] - target); n++; });
  // roughness: mean |laplacian| in a disc elsewhere, before and after smoothing
  const rough = (g, x0, y0) => { let s = 0, k = 0; disc(N, x0, y0, 10, (i, d, x, y) => { if (x > 0 && y > 0 && x < N - 1 && y < N - 1) { s += Math.abs(g[i - 1] + g[i + 1] + g[i - N] + g[i + N] - 4 * g[i]); k++; } }); return s / k; };
  const r0 = rough(g1, 60, 190);
  await sim.sculptStroke('smooth', [{ x: 60, y: 190 }], { radius: 15, dabs: 20, intensity: 2 });
  const g2 = await ground();
  const r1 = rough(g2, 60, 190);
  check('flattenSmooth', dev1 / n < 0.5 && dev1 < 0.1 * dev0 && r1 < 0.5 * r0, { flattenMeanDev_m: [dev0 / n, dev1 / n], roughness: [r0, r1] });
}

// 5. A channel carved down a valley wall carries the next storm's water
{
  sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' });
  sim.pause();
  const N = e.N, X = 175;
  const g0 = await ground();
  const pts = []; for (let y = 230; y >= 30; y -= 4) pts.push({ x: X, y });
  await sim.sculptStroke('channel', pts, { radius: 12 });
  const g1 = await ground();
  let cut = 0; for (let y = 60; y <= 200; y += 10) cut += (g0[y * N + X] - g1[y * N + X]) / 15;
  sim.brush('storm', { x: X, y: 200, radius: 40, days: 2, intensity: 2 });
  await e.run(1.5, { batchDays: 1 / 48 });
  const w = await layer('water');
  let inCh = 0, beside = 0, k = 0;
  for (let y = 60; y <= 180; y++) { inCh += w[y * N + X]; beside += 0.5 * (w[y * N + X - 9] + w[y * N + X + 9]); k++; }
  const s = await sim.stats();
  check('channel', cut > 3 && inCh > 3 * beside && inCh / k > 0.001 && !s.hasNaN, { meanCut_m: cut, waterInChannel_m: inCh / k, waterBeside_m: beside / k, balPct: s.balanceErrorPct });
}

// 6. Avalanches: snow leaves cliffs (ground steeper than 45 deg) and piles up on the gentler ground
//    right below them (within 4 cells); the water books still balance. Same map and weather, with
//    and without avalanches.
{
  const res = {};
  for (const on of [false, true]) {
    e.avalanches = on;
    sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Colorado alpine' });
    sim.pause();
    await e.run(365 * 5 + 60);   // end in early March: deep winter pack
    const N = e.N, g = await ground(), sn = await layer('snowSWE'), pl = await layer('plant');
    const dx = e.world.cellSize;
    const sl = new Float32Array(N * N);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; sl[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + N] - g[i - N]) / (2 * dx); }
    let steep = 0, ns = 0, foot = 0, nf = 0;
    for (let y = 5; y < N - 5; y++) for (let x = 5; x < N - 5; x++) {
      const i = y * N + x;
      if (sl[i] > 1) { steep += sn[i]; ns++; continue; }
      if (sl[i] > 0.5) continue;
      let below = false;
      for (let dy = -4; dy <= 4 && !below; dy++) for (let dx2 = -4; dx2 <= 4; dx2++) { const j = i + dy * N + dx2; if (sl[j] > 1 && g[j] > g[i]) { below = true; break; } }
      if (below) { foot += sn[i]; nf++; }
    }
    let woody = 0; for (let i = 0; i < N * N; i++) woody += pl[i * 4];
    const s = await sim.stats();
    res[on ? 'on' : 'off'] = { cliffSWE_m: steep / Math.max(ns, 1), cliffCells: ns, footSWE_m: foot / Math.max(nf, 1), footCells: nf, totalSnow_m3: s.totalSnowSWE_m3, meanWoody: woody / (N * N), balPct: s.balanceErrorPct, nan: s.hasNaN };
  }
  e.avalanches = true;
  check('avalanches', res.on.cliffSWE_m < 0.5 * res.off.cliffSWE_m && res.on.footSWE_m > 1.1 * res.off.footSWE_m && Math.abs(res.on.balPct) < 0.01 && !res.on.nan, res);
}

// 7. Sculpting while the sim runs fast and renders: no NaN, no GPU errors
{
  sim.pause(); await sim.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' });
  const N = e.N;
  sim.setSpeed(365000); sim.play();
  const ops = ['raise', 'lower', 'smooth', 'flatten', 'channel'];
  e.beginStroke();
  for (let k = 0; k < 150; k++) {
    const op = ops[k % 5], x = N * (0.3 + 0.4 * Math.random()), y = N * (0.3 + 0.4 * Math.random());
    e.sculpt(op, { x, y, radius: 20, intensity: 2, target: 3000 - e.datum, ax: x - 10, ay: y, za: 600, zb: 590 });
    await sleep(30);
  }
  await e.endStroke();
  await sleep(2000);
  const s = await sim.stats();
  sim.pause();
  const undone = await sim.undo();
  const s2 = await sim.stats();
  check('liveNoNaN', !s.hasNaN && !s2.hasNaN && !!undone && (window.__gpuErrors || 0) === 0, { nan: s.hasNaN, years: s.year, bal: s.balanceErrorPct, fps: e.fps, gpuErrors: window.__gpuErrors || 0 });
}

R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
R.allPass = Object.values(R.checks).every((c) => c.pass);
R.failed = Object.entries(R.checks).filter(([, c]) => !c.pass).map(([k]) => k);
R.wallSeconds = (performance.now() - t0) / 1000;
return R;
