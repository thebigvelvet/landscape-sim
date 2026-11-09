// Earthquakes (sim/quake.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/quakes.js --out=tests/out-quakes.json
// Checks:
//   rockiesActive   a Southern Rockies map has >= 3 quakes in 5,000 years
//   scarp           its faults keep a step: ground across the trace differs from a no-quake twin by
//                   at least half the slip (and >= 1 m)
//   ranking         quake counts: Rockies > Plateau and Valley & Ridge > Gulf Coast
//   gulfCreep       Gulf Coast growth faults creep (slip builds up) with few or no quakes
//   faultless       a map with no faults gets only background quakes and no ground offset
//   rockMatch       after a slip the rock under the dropped ground is the rock that was there (the
//                   fault throw moved with it); the up side is untouched
//   scarpVisible    and at least 10 m of it is left on some fault (visible against the relief)
//   patchySlides    an M7.2 on a 512 map: under 5 % of cells away from the fault lose > 1 m, but
//                   some do (scattered scars, not a stripped band)
//   plantsRideDown  plants on the dropped side of the fault survive the offset itself (the M7.2 run)
//   landslides      a strong quake moves far more soil and rock on slopes in one day than a quiet day,
//                   but under 2 million m3 of rock (no map-wide collapse)
//   avalanches      the same for snow on a snowy map
//   springs         groundwater near the fault moves faster for a while after a quake, then the
//                   boost fades
//   volcanicBases   volcanic unit bases on the down side drop with the ground
//   strokeSafe      no ground moves while a sculpt stroke is open (it waits); undo still works
//   freshScarp      the broken face is marked as fresh rock (strength > 0.5, this year) along the whole
//                   trace, and nowhere well away from it
//   freshFades      the fresh colour shows on screen right after the quake and is gone 2,100 years later
//   books           water and solids balance in every run
const e = sim.engine;
const Q = e.quakes;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const t0 = performance.now();
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3) + 2000;
const books = [];
const N = 256, cs = 10, c = 0.5 * (N - 1);
const load = async (prov, seed, opts = {}) => {
  sim.pause(); await sim.load('random', { size: N, seed, province: prov, volcanoes: false, ...opts }); sim.pause();
  Q.enabled = true;
};
const book = async (run) => { const s = await sim.stats(); books.push({ run, ok: booksOk(s), bal: s.balanceErrorPct, solids: s.solidsError_m3 }); return s; };
// signed distance (m) of cell (x, y) from fault f (positive = down side)
const sAt = (f, x, y) => f.nx * (x - c) * cs + f.ny * (y - c) * cs - f.c;
const ground = async () => { const b = await e.readLayer('bedrock'), so = await e.readLayer('soil'); return b.map((v, i) => v + so[i]); };
// mean ground in bands either side of the fault: (up side mean) - (down side mean)
const stepAcross = (G, f, lo = 40, hi = 150) => {
  let u = 0, nu = 0, d = 0, nd = 0;
  for (let y = 4; y < N - 4; y++) for (let x = 4; x < N - 4; x++) {
    const s = sAt(f, x, y);
    if (s < -lo && s > -hi) { u += G[y * N + x]; nu++; } else if (s > lo && s < hi) { d += G[y * N + x]; nd++; }
  }
  return nu && nd ? u / nu - d / nd : NaN;
};
const YEARS = 5000;

// ---- activity by province (and the Rockies scarp vs a no-quake twin) ----
const plateauSeeds = { faulted: null, faultless: null };
for (let seed = 1; seed <= 24 && !(plateauSeeds.faulted && plateauSeeds.faultless); seed++) {
  await load('plateau', seed);
  const n = e.strataInfo.struct.faults.length;
  if (n && !plateauSeeds.faulted) plateauSeeds.faulted = seed;
  if (!n && !plateauSeeds.faultless) plateauSeeds.faultless = seed;
}
const runs = [['rockies', 1], ['plateau', plateauSeeds.faulted], ['valleyRidge', 1], ['gulf', 1]];
for (const [prov, seed] of runs) {
  await load(prov, seed);
  const F = e.strataInfo.struct.faults;
  const ih0 = await e.readLayer('initHeight');
  await e.run(YEARS * 365);
  const G = await ground(), ih = await e.readLayer('initHeight');
  const r = { seed, faults: F.length, kinds: F.map((f) => f.kind), count: Q.count, biggest: +Q.biggest.toFixed(2),
    slip: Q.slipTotal.slice(0, F.length).map((v) => +v.toFixed(2)),
    offsetAcross: F.map((f) => +(stepAcross(ih, f) - stepAcross(ih0, f)).toFixed(2)),
    log: Q.log.slice(0, 12).map((q) => `${Math.round(q.day / 365)}y M${q.M.toFixed(1)} ${q.kind}`) };
  await book(`${prov} ${seed}`);
  if (prov === 'rockies') {
    r.stepQuake = F.map((f) => stepAcross(G, f));
    await load(prov, seed); Q.enabled = false;
    await e.run(YEARS * 365);
    const G2 = await ground();
    r.stepTwin = F.map((f) => stepAcross(G2, f));
    r.scarp = F.map((f, k) => +(r.stepQuake[k] - r.stepTwin[k]).toFixed(2));
    await book('rockies twin');
    Q.enabled = true;
  }
  R.runs[prov] = r;
}
const rk = R.runs.rockies, pl = R.runs.plateau, vr = R.runs.valleyRidge, gu = R.runs.gulf;
check('rockiesActive', rk.count >= 3, { count: rk.count, biggest: rk.biggest });
check('scarp', rk.scarp.some((v, k) => v >= Math.max(1, 0.5 * rk.slip[k])), { scarp: rk.scarp, slip: rk.slip });
// big enough to see against the Rockies' ~1 km of relief (Rockies slip is tripled for this)
check('scarpVisible', Math.max(...rk.scarp) >= 10, { scarp: rk.scarp });
check('ranking', rk.count > pl.count && rk.count > vr.count && Math.min(pl.count, vr.count) > gu.count,
  { rockies: rk.count, plateau: pl.count, valleyRidge: vr.count, gulf: gu.count });
// 0.5 mm/yr: a couple of metres in 5,000 years, a faint step and never a cliff
check('gulfCreep', gu.slip.some((v) => v > 1.5) && Math.max(...gu.slip) < 4 && gu.count <= 2, { slip: gu.slip, count: gu.count });

// ---- a map with no faults: background quakes only ----
{
  await load('plateau', plateauSeeds.faultless);
  const ih0 = await e.readLayer('initHeight');
  await e.run(2 * YEARS * 365);
  const ih = await e.readLayer('initHeight');
  let moved = 0; for (let i = 0; i < ih.length; i++) moved = Math.max(moved, Math.abs(ih[i] - ih0[i]));
  const kinds = [...new Set(Q.log.map((q) => q.kind))];
  R.runs.faultless = { seed: plateauSeeds.faultless, count: Q.count, kinds, groundMoved: moved };
  await book('faultless');
  check('faultless', Q.count >= 1 && kinds.every((k) => k === 'background') && moved === 0, R.runs.faultless);
}

// ---- rock layers stay matched across a fresh slip ----
// The ground offset is read from initHeight (moved only by sculpting and quakes), so rockfall from the
// shaking does not blur it: a rock top at b0 + offset under the new throw must lie at the same depth in
// the stack as b0 did under the old throw.
{
  await load('rockies', 1);
  Q.enabled = false;
  const f = e.strataInfo.struct.faults[0], T = e.strataInfo;
  const b0 = await e.readLayer('bedrock'), ih0 = await e.readLayer('initHeight');
  Q.force({ fault: 0, M: 7.0 });
  await e.run(1);
  const ih1 = await e.readLayer('initHeight');
  const slip = Q.slipTotal[0];
  const sag0 = Math.max(3 * f.w, 1.5 * cs), sagW = Math.max(f.w, cs);
  let worstUp = 0, n = 0, drop = 0, mis = 0, cnt = 0;
  const thr = f.throw, before = new Map();
  f.throw = thr - slip;
  for (let y = 8; y < N - 8; y += 3) for (let x = 8; x < N - 8; x += 3) before.set(y * N + x, sim.strataDepth(b0[y * N + x], x, y, T));
  f.throw = thr;
  for (let y = 8; y < N - 8; y += 3) for (let x = 8; x < N - 8; x += 3) {
    const s = sAt(f, x, y), i = y * N + x, off = ih1[i] - ih0[i];
    if (s > sag0 + 4 * sagW + 20) { drop -= off; n++; }
    else if (s < -60) worstUp = Math.max(worstUp, Math.abs(off));
    if (Math.abs(s - sag0) > 4 * sagW) { mis = Math.max(mis, Math.abs(sim.strataDepth(b0[i] + off, x, y, T) - before.get(i))); cnt++; }
  }
  R.runs.rockMatch = { slip, meanDrop: n ? drop / n : 0, worstUpMove: worstUp, worstDepthMismatch: mis, cells: cnt };
  await book('rockMatch');
  check('rockMatch', slip > 1 && Math.abs(drop / n - slip) < 0.01 * slip && worstUp < 0.01 && mis < 0.05, R.runs.rockMatch);
  // fresh rock on the broken face (karst.z = year it broke, karst.w = strength)
  const k = await e.readLayer('karst'), yr = (e.day - 1) / 365;
  let onTrace = 0, freshOn = 0, freshFar = 0, yearOk = true;
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const s = sAt(f, x, y), i = y * N + x;
    // the marked band is centred a little onto the down side (0.3 of the way to the sag, sim/sculpt.js)
    if (Math.abs(s - 0.3 * sag0) < 0.4 * cs) { onTrace++; if (k[4 * i + 3] > 0.5) freshOn++; if (Math.abs(k[4 * i + 2] - yr) > 0.01) yearOk = false; }
    else if (Math.abs(s) > 12 * Math.max(f.w, cs) && k[4 * i + 3] > 0) freshFar++;
  }
  R.runs.freshScarp = { onTrace, freshOn, freshFar, yearOk, year: yr };
  check('freshScarp', onTrace > 20 && freshOn > 0.95 * onTrace && freshFar === 0 && yearOk, R.runs.freshScarp);
  // and it weathers back: the share of the default view the fresh colour changes, now and 2,100 years on
  const shown = async () => {
    const px = async () => { await new Promise((r) => setTimeout(r, 1200)); const img = new Image(); img.src = sim.renderer.canvas.toDataURL('image/png'); await img.decode(); const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const g = cv.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    Q.glow = null; sim.renderer.camera.shakeAmp = 0;   // the quake's camera shake would swamp the comparison
    const share = (A, B) => { let big = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) big++; return +(100 * big / (A.length / 4)).toFixed(2); };
    const keep = await e.readLayer('karst'), A = await px(), A2 = await px();   // A vs A2: frame-to-frame flicker (water, trees)
    const kk = keep.slice(); for (let i = 3; i < kk.length; i += 4) kk[i] = 0; e.device.queue.writeBuffer(e.world.buffers.karst, 0, kk);
    const B = await px();
    e.device.queue.writeBuffer(e.world.buffers.karst, 0, keep);
    return { pct: share(A2, B), flicker: share(A, A2) };
  };
  const pct0 = await shown();
  await e.run(2100 * 365);
  const pct2100 = await shown();
  R.runs.freshFades = { now: pct0, after2100yr: pct2100 };
  check('freshFades', pct0.pct > pct0.flicker + 0.1 && pct2100.pct <= pct2100.flicker + 0.05, R.runs.freshFades);
}

// ---- landslides and rockfalls: strong background quake vs a quiet day ----
const moved1Day = async (seed, quake) => {
  await load('rockies', seed);
  await e.run(30);
  const b0 = await e.readLayer('bedrock'), s0 = await e.readLayer('soil');
  if (quake) Q.force({ fault: -1, M: 6.8, x: c, y: c });
  else Q.enabled = false;
  await e.run(1);
  const b1 = await e.readLayer('bedrock'), s1 = await e.readLayer('soil');
  let soilMoved = 0, rockFell = 0;
  for (let i = 0; i < b0.length; i++) { soilMoved += Math.abs(s1[i] - s0[i]); rockFell += Math.max(0, b0[i] - b1[i]); }
  await book(`slides ${quake ? 'quake' : 'quiet'}`);
  return { soilMoved_m3: Math.round(soilMoved * cs * cs), rockFell_m3: Math.round(rockFell * cs * cs) };
};
{
  const q = await moved1Day(3, true), z = await moved1Day(3, false);
  R.runs.landslides = { quake: q, quiet: z };
  // and not absurd: an M6.8 under a 2.5 km map is a big event, but not metres off every slope
  check('landslides', q.soilMoved_m3 > 3 * z.soilMoved_m3 + 100 && q.rockFell_m3 > 2 * z.rockFell_m3 + 10 && q.rockFell_m3 < 2e6, R.runs.landslides);
}

// ---- a big fault quake on a full-size map leaves scattered scars, not a stripped band ----
{
  const N2 = 512, c2 = 0.5 * (N2 - 1);
  sim.pause(); await sim.load('random', { size: N2, seed: 1, province: 'rockies', volcanoes: false }); sim.pause();
  Q.enabled = false;
  await e.run(200);
  const f = e.strataInfo.struct.faults[0];
  const rd = async () => { const b = await e.readLayer('bedrock'), so = await e.readLayer('soil'), ih = await e.readLayer('initHeight'); return b.map((v, i) => v + so[i] - ih[i]); };
  const before = await rd(), veg0 = await e.readLayer('veg');
  Q.force({ fault: 0, M: 7.2 });
  await e.run(1);
  const after = await rd(), veg1 = await e.readLayer('veg');
  // plants on the dropped block ride down with it (they are not 'stripped' by the offset)
  const vs = { up0: 0, up1: 0, dn0: 0, dn1: 0 };
  for (let y = 0; y < N2; y++) for (let x = 0; x < N2; x++) {
    const s = f.nx * (x - c2) * cs + f.ny * (y - c2) * cs - f.c, i = y * N2 + x;
    if (s < -100) { vs.up0 += veg0[i]; vs.up1 += veg1[i]; } else if (s > 100) { vs.dn0 += veg0[i]; vs.dn1 += veg1[i]; }
  }
  R.runs.plants = { upKept: +(vs.up1 / vs.up0).toFixed(3), downKept: +(vs.dn1 / vs.dn0).toFixed(3) };
  check('plantsRideDown', R.runs.plants.downKept > 0.85 * R.runs.plants.upKept, R.runs.plants);
  let n = 0, big = 0, moved = 0;
  for (let y = 0; y < N2; y++) for (let x = 0; x < N2; x++) {
    const s = f.nx * (x - c2) * cs + f.ny * (y - c2) * cs - f.c;
    if (Math.abs(s) < 80) continue;   // the scarp itself
    const i = y * N2 + x, d = before[i] - after[i];
    n++; if (d > 1) big++; moved += Math.abs(d);
  }
  R.runs.patchy = { cells: n, droppedOver1m: big, share: big / n, moved_m3: Math.round(moved * cs * cs) };
  await book('patchy M7.2');
  check('patchySlides', big / n < 0.05 && big > 20, R.runs.patchy);
}

// ---- avalanches: a quake in deep winter on a snowy map ----
{
  const snowMoved = async (quake) => {
    await load('rockies', 2, { preset: 'Colorado alpine' });
    await e.run(75);   // into March: deep snowpack
    const w0 = await e.readLayer('snowSWE');
    if (quake) Q.force({ fault: -1, M: 6.8, x: c, y: c }); else Q.enabled = false;
    await e.run(0.5);
    const w1 = await e.readLayer('snowSWE');
    let m = 0, tot = 0; for (let i = 0; i < w0.length; i++) { m += Math.abs(w1[i] - w0[i]); tot += w0[i]; }
    await book(`snow ${quake ? 'quake' : 'quiet'}`);
    return { sweMoved_m3: Math.round(m * cs * cs), snowSWE_m3: Math.round(tot * cs * cs) };
  };
  const q = await snowMoved(true), z = await snowMoved(false);
  R.runs.avalanches = { quake: q, quiet: z };
  check('avalanches', q.snowSWE_m3 > 1000 && q.sweMoved_m3 > 1.5 * z.sweMoved_m3 + 50, R.runs.avalanches);
}

// ---- springs: groundwater near the fault moves faster for a while ----
{
  const gwNear = async (quake) => {
    await load('rockies', 1);
    const f = e.strataInfo.struct.faults[0];
    Q.enabled = false;   // only the forced quake (a natural one could reset the boost)
    await e.run(365 + 150);   // into early summer: thawed ground, a full store
    if (quake) Q.force({ fault: 0, M: 6.8 });
    await e.run(30);
    const gq = Q.plan(e.day).fields.gqA;
    const fl = await e.readLayer('gwFlux');
    let near = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.abs(sAt(f, x, y)) < 200) { const i = 4 * (y * N + x); near += fl[i] + fl[i + 1] + fl[i + 2] + fl[i + 3]; }
    await e.run(20 * 365);
    const gqLater = Q.plan(e.day).fields.gqA;
    await book(`springs ${quake ? 'quake' : 'quiet'}`);
    return { gwFluxNear: near, boostAfter1mo: +gq.toFixed(3), boostAfter21yr: +gqLater.toFixed(3) };
  };
  const q = await gwNear(true), z = await gwNear(false);
  R.runs.springs = { quake: q, quiet: z };
  check('springs', q.gwFluxNear > 1.3 * z.gwFluxNear && q.boostAfter1mo > 1 && q.boostAfter21yr < 0.2 * q.boostAfter1mo, R.runs.springs);
}

// ---- volcanic unit bases ride down with the ground ----
{
  let out = { found: false };
  for (const [prov, seed] of [['plateau', 2], ['plateau', 5], ['plateau', 6], ['plateau', 9], ['rockies', 2], ['rockies', 5], ['rockies', 6], ['rockies', 9]]) {
    sim.pause(); await sim.load('random', { size: N, seed, province: prov, volcanoes: true }); sim.pause();
    const F = e.strataInfo.struct.faults;
    if (!F.length || !e.volcanoInfo?.length) continue;
    const v0 = await e.readLayer('volcRock'), b0 = await e.readLayer('bedrock');
    for (let k = 0; k < F.length && !out.found; k++) {
      const f = F[k];
      const cells = [];
      for (let i = 0; i < N * N; i++) { const x = i % N, y = (i / N) | 0; if (v0[8 * i + 4] > 0.5 && sAt(f, x, y) > 200) cells.push(i); }
      if (cells.length < 5) continue;
      Q.force({ fault: k, M: 6.8 });
      await e.run(1);
      const v1 = await e.readLayer('volcRock'), b1 = await e.readLayer('bedrock');
      // erosion in one day is mm at most: base change must equal the slip (to within erosion)
      let meanBase = 0; for (const i of cells) meanBase += v0[8 * i] - v1[8 * i];
      out = { found: true, prov, seed, fault: k, cells: cells.length, slip: Q.slipTotal[k], meanBaseDrop: meanBase / cells.length };
      await book('volcanic');
    }
    if (out.found) break;
  }
  R.runs.volcanicBases = out;
  check('volcanicBases', out.found && Math.abs(out.meanBaseDrop - out.slip) < 0.02 * out.slip + 0.01, out);
}

// ---- a quake while a sculpt stroke is open waits for the stroke; undo still works ----
{
  await load('rockies', 1);
  const f = e.strataInfo.struct.faults[0];
  // a cell on the down side
  let cell = -1; for (let i = 0; i < N * N && cell < 0; i++) { const x = i % N, y = (i / N) | 0; if (x > 20 && y > 20 && x < N - 20 && y < N - 20 && sAt(f, x, y) > 300) cell = i; }
  const cx = cell % N, cy = (cell / N) | 0;
  const ih0 = await e.readLayer('initHeight');
  e.beginStroke();
  e.sculpt('raise', { x: cx, y: cy, radius: 6, intensity: 3 });
  Q.force({ fault: 0, M: 6.8 });
  await e.run(1);
  const ihMid = await e.readLayer('initHeight');
  let far = -1; for (let i = 0; i < N * N && far < 0; i++) { const x = i % N, y = (i / N) | 0; if (x > 8 && y > 8 && x < N - 8 && y < N - 8 && sAt(f, x, y) > 300 && Math.hypot(x - cx, y - cy) > 30) far = i; }
  const heldBack = Math.abs(ihMid[far] - ih0[far]) < 1e-4;
  await e.endStroke();
  await e.run(1);
  const ihAfter = await e.readLayer('initHeight');
  const applied = ih0[far] - ihAfter[far];
  const undone = await e.undoSculpt();
  await e.run(1);
  const ihUndo = await e.readLayer('initHeight');
  const centreBack = Math.abs((ihUndo[cell] - ih0[cell]) - (ihAfter[far] - ih0[far]));   // centre = only the slip left
  R.runs.strokeSafe = { heldBack, applied, slip: Q.slipTotal[0], undone: !!undone, centreAfterUndo: centreBack };
  await book('strokeSafe');
  check('strokeSafe', heldBack && Math.abs(applied - Q.slipTotal[0]) < 0.01 && !!undone && centreBack < 0.05, R.runs.strokeSafe);
}

check('books', books.every((q) => q.ok), { books });
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
