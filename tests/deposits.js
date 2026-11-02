// Sediment beds (sim/deposits.js). Run on the real GPU with the tools/review harness (--eval).
// A temperate valley runs 400 years (then 100 more for the scour check). Then:
//   books      the stack is only a label on the soil: no NaN or negative beds, never more beds than
//              soil, and the water and solids books balance as before
//   placement  sediment ends up in valley floors, channels and fans, not on ridge tops
//   bedding    thick fills are layered (several beds) and the grain is sorted into more than one
//              class (gravel and sand in the channels; the pond check below covers the clay)
//   youngest   where later floods and slumps cut back into the fill they remove the youngest beds first and
//              leave the older beds below untouched
//   pond       a lake dammed across the valley fills with fine sediment (clay and silt)
const e = sim.engine;
const R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const stackOf = (dep, i) => {
  const out = [];
  for (let k = 0; k < 8; k++) { const th = dep[16 * i + k], tg = dep[16 * i + 8 + k]; if (th > 1e-6) out.push({ th, tg, ep: Math.floor(tg), gr: (tg - Math.floor(tg)) / 0.99 }); }
  return out;
};
const total = (st) => st.reduce((s, b) => s + b.th, 0);

const BED_DAYS = 500 * 365 / 40;
sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' }); sim.pause();
await e.run(400 * 365, { bedDays: BED_DAYS });
const s = await sim.stats();
const N = e.N, dx = e.world.cellSize, A = dx * dx;
const dep = await layer('deposit'), so = await layer('soil'), br = await layer('bedrock'), sl = await layer('slope');
const g = new Float32Array(N * N); for (let i = 0; i < N * N; i++) g[i] = br[i] + so[i];

// ---- books ----
{
  let neg = 0, bad = 0, over = 0, worst = 0;
  for (let i = 0; i < N * N; i++) {
    let t = 0;
    for (let k = 0; k < 16; k++) { const v = dep[16 * i + k]; if (!Number.isFinite(v)) bad++; else if (v < 0) neg++; if (k < 8) t += v; }
    if (t > so[i] + 1e-4) { over++; worst = Math.max(worst, t - so[i]); }
  }
  R.summary = await sim.depositStats();
  check('books', !bad && !neg && !over && !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1000,
    { badValues: bad, negative: neg, cellsWithMoreBedsThanSoil: over, worst_m: worst, balPct: s.balanceErrorPct, solidsError_m3: s.solidsError_m3 });
}

// ---- placement: where in the local relief does the sediment sit? ----
{
  // position of each cell in its 21 x 21 neighbourhood: below the local mean = hollow / valley floor
  const r = 10, inHollow = [], onRidge = [];
  let vol = 0, volHollow = 0, volRidge = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, t = total(stackOf(dep, i));
    let sum = 0, n = 0, mx = -Infinity;
    for (let yy = Math.max(0, y - r); yy <= Math.min(N - 1, y + r); yy += 2) for (let xx = Math.max(0, x - r); xx <= Math.min(N - 1, x + r); xx += 2) { const v = g[yy * N + xx]; sum += v; n++; if (v > mx) mx = v; }
    const m = sum / n;
    vol += t;
    if (g[i] <= m) volHollow += t;
    if (g[i] >= m + 0.5 * (mx - m)) volRidge += t;
  }
  check('placement', vol > 0 && volHollow / vol > 0.8 && volRidge / vol < 0.02,
    { volume_m3: vol * A, inHollowsFrac: volHollow / vol, onRidgesFrac: volRidge / vol });
}

// ---- bedding: thick fills are layered; steeper flow leaves coarser beds ----
const before = [];   // stacks kept for the flood check
{
  const bedsThick = [];
  for (let i = 0; i < N * N; i++) {
    const st = stackOf(dep, i), t = total(st);
    before.push(st);
    if (t > 1) bedsThick.push(st.length);
  }
  const byG = R.summary.volumeByGrain_m3, vAll = Object.values(byG).reduce((a, b) => a + b, 0);
  const classes = Object.values(byG).filter((v) => v > 0.05 * vAll).length;
  check('bedding', bedsThick.length > 20 && pct(bedsThick, 0.5) >= 3 && classes >= 2,
    { cellsOver1m: bedsThick.length, medianBedsOver1m: pct(bedsThick, 0.5), grainClassesOver5pct: classes, byGrain_m3: byG });
}

// ---- youngest first: natural scour over the next 100 years cuts back into the fill ----
{
  const ep0 = e.depEpoch % 8192;
  await e.run(100 * 365, { bedDays: BED_DAYS });
  const dep2 = await layer('deposit');
  let incised = 0, ok = 0, cut = 0;
  const bad = [];
  for (let i = 0; i < N * N; i++) {
    // only the beds older than the scour window: new beds (creep wash, later floods) may sit on top
    const O = before[i], Nn = stackOf(dep2, i).filter((b) => b.ep < ep0);
    if (O.length < 2 || O.length >= 8) continue;     // full stacks may merge beds
    const t0c = total(O), t1 = total(Nn);
    if (t1 > t0c - 0.03 || !Nn.length) continue;    // old fill not cut down (or cut away entirely)
    incised++; cut += t0c - t1;
    const m = Nn.length, off = O.length - m;
    let good = off >= 0 && Math.abs(Nn[0].tg - O[off].tg) < 1e-3 && Nn[0].th <= O[off].th + 1e-4;
    for (let k = 1; k < m && good; k++) if (Math.abs(Nn[k].th - O[off + k].th) > 1e-4 || Math.abs(Nn[k].tg - O[off + k].tg) > 1e-3) good = false;
    if (good) ok++; else if (bad.length < 3) bad.push({ i, before: O, after: Nn });
  }
  check('youngestFirst', incised >= 10 && ok / incised > 0.97, { incisedCells: incised, meanCut_m: cut / Math.max(1, incised), olderBedsIntactFrac: ok / Math.max(1, incised), examples: bad });
}

// ---- pond: dam the valley and let the lake behind it catch sediment ----
{
  sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' }); sim.pause();
  const pts = [];
  for (let x = N * 0.22; x <= N * 0.78; x += 4) pts.push({ x, y: N * 0.4 });
  await sim.sculptStroke('raise', pts, { radius: 10, intensity: 2.8, dabs: 14 });
  await e.run(100 * 365);
  const w = await layer('water'), d3 = await layer('deposit'), sl3 = await layer('slope');
  const vx = await layer('velX'), vy = await layer('velY'), lakeSp = [];
  const lake = [], river = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, st = stackOf(d3, i);
    if (!st.length || total(st) < 0.02) continue;
    const meanGr = st.reduce((a, b) => a + b.gr * b.th, 0) / total(st);
    if (w[i] > 0.3 && y > N * 0.4) { lake.push(meanGr); lakeSp.push(Math.hypot(vx[i], vy[i])); }
    else if (sl3[i] > 0.03) river.push(meanGr);
  }
  check('pondFines', lake.length >= 10 && mean(lake) < 0.33 && mean(lake) < mean(river) - 0.2,
    { lakeCells: lake.length, lakeMeanGrain: mean(lake), lakeSpeedMedian: pct(lakeSp, 0.5), steepCells: river.length, steepMeanGrain: mean(river) });
}

R.allPass = Object.values(R.checks).every((c) => c.pass);
R.failed = Object.entries(R.checks).filter(([, c]) => !c.pass).map(([k]) => k);
R.wallSeconds = (performance.now() - t0) / 1000;
return R;
