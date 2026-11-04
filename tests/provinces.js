// Geologic provinces and their anomalies (sim/strata.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/provinces.js --out=tests/out-provinces.json
// 1. Generator statistics over 200 seeds per province on one real starting terrain: each province
//    makes its own kind of rock, structure and anomalies at the intended rates.
// 2. Erosion runs, one landscape per province (picked so it has the anomaly being tested): each
//    anomaly changes the land the way it should, and the water and solids books stay closed.
const e = sim.engine;
const R = { checks: {}, gen: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const frac = (n, d) => n / Math.max(1, d);

// ---------------- 1. generator ----------------
sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert', province: 'plateau' }); sim.pause();
{
  const N = e.N, dx = e.world.cellSize, h = await layer('initHeight'), SEEDS = 200;
  for (const prov of ['plateau', 'rockies', 'valleyRidge', 'gulf']) {
    const G = { cv: [], dips: [], covered: 0, eol: 0, eolSoft: 0, kinds: {}, basementFrac: [], coverFrac: [], crests: [], exposed: [] };
    const kind = (k) => { G.kinds[k] = (G.kinds[k] || 0) + 1; };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const T = sim.makeStrata(seed, h, N, dx, 1, prov), S = T.struct;
      const th = T.beds.slice(0, -1).map((b) => b.thick).filter((t, k) => T.beds[k].type !== 'coal');
      const m = mean(th);
      G.cv.push(Math.sqrt(mean(th.map((t) => (t - m) ** 2))) / m);
      G.dips.push(S.dipDeg);
      for (let k = 0; k < T.beds.length - 2; k++) if (T.beds[k].type === 'eolian') { G.eol++; if (!T.beds[k + 1].hard) G.eolSoft++; }
      const seen = new Set();
      for (const d of S.domes) seen.add(d.kind);
      for (const f of S.faults) seen.add(f.kind);
      for (const a of T.anoms) seen.add(a.type);
      if (S.joints.length) seen.add('joints');
      seen.forEach(kind);
      let base = 0, n = 0, ok = true; const beds = new Set();
      for (let y = 0; y < N; y += 8) for (let x = 0; x < N; x += 8) {
        const k = sim.strataLayer(h[y * N + x], x, y, T);
        n++; if (k === T.beds.length - 1) { base++; ok = false; }
        beds.add(k);
      }
      if (ok) G.covered++;
      G.basementFrac.push(base / n); G.coverFrac.push(1 - base / n); G.exposed.push(beds.size);
      if (S.foldWave) G.crests.push(N * dx / S.foldWave);
    }
    const r = (k) => frac(G.kinds[k] || 0, SEEDS);
    R.gen[prov] = { medianCV: pct(G.cv, 0.5), dipRange: [pct(G.dips, 0), pct(G.dips, 1)], coveredFrac: G.covered / SEEDS,
      eolianOverSoft: frac(G.eolSoft, G.eol), kinds: Object.fromEntries(Object.keys(G.kinds).map((k) => [k, r(k)])),
      medianBasementFrac: pct(G.basementFrac, 0.5), medianCoverFrac: pct(G.coverFrac, 0.5),
      crests: G.crests.length ? { mean: mean(G.crests), min: pct(G.crests, 0) } : null, medianExposedBeds: pct(G.exposed, 0.5) };
    const g = R.gen[prov];
    const near = (k, want) => Math.abs(r(k) - want) < 0.1;
    if (prov === 'plateau') {
      check('plateauBeds', g.medianCV > 0.5 && g.dipRange[0] >= 0.3 && g.dipRange[1] <= 4 && g.coveredFrac > 0.95 && g.eolianOverSoft > 0.8,
        { medianCV: g.medianCV, dipRange: g.dipRange, coveredFrac: g.coveredFrac, eolianOverSoft: g.eolianOverSoft });
      check('plateauAnomalyRates', near('laccolith', 0.25) && near('saltAnticline', 0.2) && near('pipe', 0.4) && near('joints', 0.6) && near('uplift', 0.2) && near('neck', 0.15),
        { kinds: g.kinds });
    }
    if (prov === 'rockies') check('rockiesCore', g.medianBasementFrac > 0.5 && g.medianCoverFrac > 0.05 && r('dike') === 1 && r('fault') === 1 && r('hotSpring') > 0.4,
      { medianBasementFrac: g.medianBasementFrac, medianCoverFrac: g.medianCoverFrac, kinds: g.kinds });
    if (prov === 'valleyRidge') check('valleyRidgeFolds', g.crests.mean >= 3 && g.crests.min >= 2.4 && g.medianExposedBeds >= 5 && r('thrust') === 1 && r('sinkhole') > 0.8,
      { crests: g.crests, medianExposedBeds: g.medianExposedBeds, kinds: g.kinds });
    if (prov === 'gulf') check('gulfStructure', g.dipRange[1] < 0.5 && r('saltDome') === 1 && r('growth') === 1, { dipRange: g.dipRange, kinds: g.kinds });
  }
}

// ---------------- 2. erosion runs ----------------
const YEARS = 20000;
// load the first seed whose landscape has all the wanted anomaly/structure kinds
async function loadWith(province, preset, want, from = 1) {
  for (let seed = from; seed < from + 60; seed++) {
    sim.pause(); await sim.load('random', { size: 256, seed, preset, province, volcanoes: false }); sim.pause();
    const T = e.strataInfo, have = new Set([...T.anoms.map((a) => a.type), ...T.struct.domes.map((d) => d.kind), ...(T.struct.joints.length ? ['joints'] : [])]);
    if (want.every((w) => have.has(w))) return seed;
  }
  return null;
}
// mean rock lowering inside an anomaly type's footprint vs a ring just outside it
function insideVsRing(T, type, low, N, opt = {}) {
  const inside = [], ring = [];
  const dx = T.cellSize;
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    for (const a of sim.anomalyAt(x, y, T)) {
      if (a.type !== type) continue;
      const hw = T.anoms.find((q) => q.type === type).hw;
      if (a.w > 0.9) inside.push(low[y * N + x]);
    }
    // ring: within a few cells outside any anomaly of this type, and outside all others
    let best = Infinity, other = false;
    for (const a of T.anoms) {
      const [x0, y0, x1, y1] = a.seg, c = (N - 1) * 0.5, px = (x - c) * dx, py = (y - c) * dx;
      const abx = x1 - x0, aby = y1 - y0, t = Math.max(0, Math.min(1, ((px - x0) * abx + (py - y0) * aby) / Math.max(abx * abx + aby * aby, 1e-6)));
      const d = Math.hypot(px - x0 - abx * t, py - y0 - aby * t) - a.hw;
      if (a.type === type) best = Math.min(best, d); else if (d < 2 * dx) other = true;
    }
    const r0 = opt.ring0 ?? 2 * dx, r1 = opt.ring1 ?? 6 * dx;
    if (!other && best > r0 && best < r1) ring.push(low[y * N + x]);
  }
  return { inside: mean(inside), ring: mean(ring), nIn: inside.length, nRing: ring.length };
}
const books = (s) => ({ balPct: s.balanceErrorPct, solids_m3: s.solidsError_m3, bedrock_m3: s.totalBedrock_m3, sedOut_m3: s.cumSedimentOut_m3, nan: s.hasNaN });
const booksOk = (b) => Math.abs(b.balPct) < 0.01 && Math.abs(b.solids_m3) < 3e-7 * b.bedrock_m3 && !b.nan;
async function lowering() {
  const N = e.N, b = await layer('bedrock'), so = await layer('soil'), h0 = await layer('initHeight');
  const rock = new Float32Array(N * N), surf = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) { rock[i] = h0[i] - b[i]; surf[i] = h0[i] - b[i] - so[i]; }
  return { rock, surf, b, so, h0 };
}

// --- Southern Rockies: dikes stand up, fault zones wear down and feed springs, the hot spring
//     keeps its ground free of snow and frost
{
  const seed = await loadWith('rockies', 'Colorado alpine', ['dike', 'fault', 'hotSpring']);
  const T = e.strataInfo, N = e.N;
  const relief0 = e.terrainRange.max - e.terrainRange.min;
  await e.run(YEARS * 365);
  const L = await lowering();
  const dike = insideVsRing(T, 'dike', L.rock, N), fault = insideVsRing(T, 'fault', L.rock, N);
  const sp = await layer('spring'), springs = insideVsRing(T, 'fault', sp, N);
  // winter: run on to late January in short steps, then compare the vent with the ground around it
  const doy = ((e.day % 365) + 365) % 365;
  await e.run(((25 - doy) % 365 + 365) % 365 + 1, { batchDays: 1 });
  const swe = await layer('snowSWE'), fr = await layer('frostDepth');
  const hs = T.anoms.find((a) => a.type === 'hotSpring');
  const vent = { swe: [], fr: [] }, around = { swe: [], fr: [] };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = (N - 1) * 0.5, d = Math.hypot((x - c) * T.cellSize - hs.seg[0], (y - c) * T.cellSize - hs.seg[1]);
    const i = y * N + x;
    if (d < hs.hw) { vent.swe.push(swe[i]); vent.fr.push(fr[i]); } else if (d > 4 * hs.hw && d < 7 * hs.hw) { around.swe.push(swe[i]); around.fr.push(fr[i]); }
  }
  const s = await sim.stats();
  R.runs.rockies = { seed, describe: T.describe, relief0, dike, fault, springs, hotSpring: { strength: hs.strength,
    vent: { swe: mean(vent.swe), frost: mean(vent.fr), n: vent.swe.length }, around: { swe: mean(around.swe), frost: mean(around.fr), n: around.swe.length } }, books: books(s) };
  check('dikesStandUp', dike.nIn > 10 && dike.inside < 0.7 * dike.ring, { dike });
  check('faultZonesWearDown', fault.nIn > 10 && fault.inside > 1.3 * fault.ring, { fault });
  check('faultSprings', springs.inside > 1.5 * springs.ring, { springs });
  const H = R.runs.rockies.hotSpring;
  check('hotSpringMelts', H.vent.n > 3 && H.vent.swe < 0.5 * H.around.swe + 1e-4 && H.vent.frost < 0.5 * H.around.frost + 1e-3, { hotSpring: H });
  check('rockiesBooks', booksOk(R.runs.rockies.books), R.runs.rockies.books);
}

// --- Valley and Ridge: sinkhole seeds dissolve into hollows, streams sink into bare limestone.
//     Both as twin runs on the same map, so stream erosion and sediment cannot confuse the answer.
{
  const seed = await loadWith('valleyRidge', 'Temperate', ['sinkhole', 'fault']);
  const N = e.N;
  const runTwin = async (sinkOn) => {
    sim.pause(); await sim.load('random', { size: 256, seed, preset: 'Temperate', province: 'valleyRidge', volcanoes: false }); sim.pause();
    const T = e.strataInfo;
    if (!sinkOn) T.anoms.forEach((a, k) => { if (a.type === 'sinkhole') e.strataPack.table[(75 + 2 * k + 1) * 4 + 2] = 0; });
    await e.run(YEARS * 365);
    const L = await lowering();
    // closed hollows in the bedrock surface (the rock floor, under any sediment fill), in the
    // sinkhole footprints
    let minIn = 0, cellsIn = 0;
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      if (!sim.anomalyAt(x, y, T).some((a) => a.type === 'sinkhole')) continue;
      const i = y * N + x; let isMin = true; cellsIn++;
      for (let oy = -1; oy <= 1 && isMin; oy++) for (let ox = -1; ox <= 1; ox++) if ((ox || oy) && L.b[i + oy * N + ox] <= L.b[i]) { isMin = false; break; }
      if (isMin) minIn++;
    }
    return { T, rock: insideVsRing(T, 'sinkhole', L.rock, N), surf: insideVsRing(T, 'sinkhole', L.surf, N), hollows: minIn, cellsIn, s: await sim.stats() };
  };
  const on = await runTwin(true), off = await runTwin(false);
  // losing streams, twin again: a painted 3-day storm over the barest limestone on the fresh map,
  // once as it is and once with every rock insoluble. With karst, more of the storm water should
  // sink into the ground under the storm and less run on over the surface.
  const twin = {};
  let spot = null;
  for (const karst of [true, false]) {
    sim.pause(); await sim.load('random', { size: 256, seed, preset: 'Temperate', province: 'valleyRidge', volcanoes: false }); sim.pause();
    const T = e.strataInfo;
    const b0 = await layer('bedrock'), so0 = await layer('soil');
    const bareSol = (i, x, y) => so0[i] < 0.3 && T.beds[sim.strataLayer(b0[i], x, y, T)].sol > 0;
    if (!spot) {   // the 15-cell circle with the most bare soluble rock
      let best = -1;
      for (let cy = 20; cy < N - 20; cy += 6) for (let cx = 20; cx < N - 20; cx += 6) {
        let n = 0;
        for (let oy = -15; oy <= 15; oy += 3) for (let ox = -15; ox <= 15; ox += 3) if (ox * ox + oy * oy <= 225 && bareSol((cy + oy) * N + cx + ox, cx + ox, cy + oy)) n++;
        if (n > best) { best = n; spot = [cx, cy]; }
      }
    }
    if (!karst) { const t = e.strataPack.table; for (let k = 0; k < 32; k++) t[(32 + k) * 4] = 0; }
    const sum = async (name) => { const a = await layer(name); let s = 0; for (let oy = -15; oy <= 15; oy++) for (let ox = -15; ox <= 15; ox++) if (ox * ox + oy * oy <= 225) s += a[(spot[1] + oy) * N + spot[0] + ox]; return s; };
    const g0 = await sum('groundwater'), out0 = (await sim.stats()).cumOutflow_m3;
    const ev = sim.brush('storm', { x: spot[0], y: spot[1], radius: 15, intensity: 1, days: 3 }); await ev?.ready;
    await e.run(3, { batchDays: 0.25 });
    twin[karst ? 'karst' : 'insoluble'] = { spot, groundwaterGainUnderStorm_m: (await sum('groundwater')) - g0, surfaceWaterUnderStorm_m: await sum('water'), stormOutflow_m3: (await sim.stats()).cumOutflow_m3 - out0 };
  }
  R.runs.valleyRidge = { seed, describe: on.T.describe, sinkholes: { withSinkholes: on.rock, without: off.rock, surfaceWith: on.surf, surfaceWithout: off.surf },
    hollows: { withSinkholes: on.hollows, without: off.hollows, cells: on.cellsIn }, losingStreams: twin, books: books(on.s) };
  const V = R.runs.valleyRidge;
  check('sinkholesDissolve', on.rock.nIn > 5 && on.rock.inside > off.rock.inside + 2 && on.surf.inside > off.surf.inside + 1, V.sinkholes);
  check('closedHollows', on.hollows > Math.max(2, 2 * off.hollows), V.hollows);
  // (groundwater gain is reported but not checked: insoluble rock also has a smaller store, so its
  // twin starts overfull and drains)
  // (surface water under the storm is mostly standing lake water; reported, not checked)
  check('losingStreams', twin.karst.stormOutflow_m3 < 0.9 * twin.insoluble.stormOutflow_m3, twin);
  check('valleyRidgeBooks', booksOk(V.books), V.books);
}
// --- Gulf Coastal Plain: a low plain; salt domes dissolve and the ground over them sinks
{
  sim.pause(); await sim.load('random', { size: 256, seed: 11, preset: 'Temperate', province: 'plateau', volcanoes: false }); sim.pause();
  const reliefPlateau = e.terrainRange.max - e.terrainRange.min;
  const seed = await loadWith('gulf', 'Temperate', ['salt'], 11);
  const T = e.strataInfo, N = e.N, relief = e.terrainRange.max - e.terrainRange.min;
  await e.run(YEARS * 365);
  const L = await lowering();
  const salt = insideVsRing(T, 'salt', L.surf, N);
  const s = await sim.stats();
  R.runs.gulf = { seed, describe: T.describe, relief, reliefPlateauSameSeed: reliefPlateau, salt, books: books(s) };
  check('gulfLowPlain', seed === 11 ? relief < 0.5 * reliefPlateau : relief < 400, { relief, reliefPlateau });
  check('saltDomesSink', salt.nIn > 5 && salt.inside > salt.ring + 1, { salt });
  check('gulfBooks', booksOk(R.runs.gulf.books), R.runs.gulf.books);
}

// --- Colorado Plateau: the salt anticline's crest collapses, joints cut into the sandstone, the
//     laccolith's core stands up once it is reached
{
  const seed = await loadWith('plateau', 'Utah desert', ['saltAnticline']);
  const T = e.strataInfo, N = e.N;
  await e.run(YEARS * 365);
  const L = await lowering();
  const salt = insideVsRing(T, 'salt', L.rock, N, { ring1: 12 * T.cellSize }), saltSurf = insideVsRing(T, 'salt', L.surf, N, { ring1: 12 * T.cellSize });
  const s = await sim.stats();
  R.runs.plateauSalt = { seed, describe: T.describe, notes: T.notes, salt, saltSurface: saltSurf, books: books(s) };
  check('saltAnticlineCollapses', salt.nIn > 10 && salt.inside > salt.ring + 1, { salt, surface: saltSurf });
  check('plateauBooks', booksOk(R.runs.plateauSalt.books), R.runs.plateauSalt.books);
}
{
  const seed = await loadWith('plateau', 'Utah desert', ['joints']);
  const T = e.strataInfo, N = e.N;
  await e.run(YEARS * 365);
  const L = await lowering();
  const jt = [], plain = [];
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const i = y * N + x, bed = T.beds[sim.strataLayer(L.h0[i] - 1, x, y, T)];
    if (!bed.hard || bed.cliffTan < 2.5 || sim.anomalyAt(x, y, T).length) continue;
    const j = sim.jointAt(x, y, T);
    if (j > 0.5) jt.push(L.rock[i]); else if (j < 0.05) plain.push(L.rock[i]);
  }
  R.runs.plateauJoints = { seed, joints: { onJoints: mean(jt), between: mean(plain), n: [jt.length, plain.length] } };
  check('jointsCutDeeper', jt.length > 50 && mean(jt) > 1.2 * mean(plain), R.runs.plateauJoints.joints);
}
{
  const seed = await loadWith('plateau', 'Utah desert', ['laccolith']);
  const T = e.strataInfo, N = e.N, a = T.anoms.find((q) => q.type === 'laccolith');
  e.erosionStrength = 3;   // speed the unroofing so the core is reached within the run
  await e.run(2 * YEARS * 365);
  e.erosionStrength = 1;
  const L = await lowering();
  // core cells the erosion has reached vs cells of the dome around them
  const core = [], flank = [];
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const i = y * N + x, an = sim.anomalyAt(x, y, T).find((q) => q.type === 'laccolith');
    if (an && an.w > 0.9 && sim.strataDepth(L.b[i], x, y, T) >= a.dTop) core.push(L.h0[i] - L.b[i] - L.so[i]);
    else if (!an) {
      const c = (N - 1) * 0.5, d = Math.hypot((x - c) * T.cellSize - a.seg[0], (y - c) * T.cellSize - a.seg[1]);
      if (d > 1.3 * a.hw && d < 2 * a.hw) flank.push(L.h0[i] - L.b[i] - L.so[i]);
    }
  }
  const z = (arr) => arr.length;
  R.runs.plateauLaccolith = { seed, describe: T.describe, coreBelow_m: a.below, exposedCoreCells: z(core),
    loweringExposedCore: mean(core), loweringFlank: mean(flank) };
  // honest: if the core was never reached, say so instead of passing or failing on nothing
  check('laccolithCoreStandsUp', core.length >= 10 ? mean(core) < mean(flank) : null, R.runs.plateauLaccolith);
}

R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { gpuErrors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
R.minutes = (performance.now() - t0) / 60000;
return R;
