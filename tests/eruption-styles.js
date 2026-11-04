// Eruption styles (sim/volcano.js ERUPTION_STYLES). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/eruption-styles.js --out=tests/out-eruption-styles.json
// Each style erupts at the same spot on the side of a valley ('valley', 256 x 256, seed 3, relief
// 0.6) and runs until the eruption is over and everything molten has set. Checks:
//   books            water and solids balance (craters take ground away, ash and flows add it)
//   hawaiian         more basalt than the Strombolian eruption, spread over more ground; a small cone
//   strombolian      a cinder cone near its planned height
//   vulcanian        andesite lava, thicker on average than the basalt flows; an ash blanket; an ash cone
//   pelean           an andesite dome standing over the vent; tuff from pyroclastic flows well away from it
//   plinian          a deep crater at the vent, ash over much of the map, tuff in the valleys, plants buried
//   phreatic         a crater dug into the old ground, breccia around it, no lava
//   phreatomagmatic  a maar: crater floor well below the old ground, a tuff ring above it
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3 + (s.cumCrater_m3 || 0)) + 2000;
const VX = 128 + 25, VY = 184;
const N = 256;

async function run(style, { batchDays = 2, maxDays = 6000 } = {}) {
  sim.pause(); await sim.load('valley', { size: N, seed: 3, relief: 0.6, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
  await e.run(30, { batchDays });
  const [b0, s0, v0] = await Promise.all(['bedrock', 'soil', 'veg'].map(layer));
  const g0 = b0.map((b, i) => b + s0[i]);
  const ev = sim.brush('volcano', { x: VX, y: VY, style }); await ev.ready;
  const startDay = e.day; const w0 = performance.now();
  while (e.day - startDay < maxDays) {
    await e.run(10, { batchDays });
    const s = await sim.stats();
    if (!s.erupting && s.hotLavaCells === 0) break;
  }
  const s = await sim.stats();
  const vs = await sim.volcanoStats();
  const [b1, s1, v1] = await Promise.all(['bedrock', 'soil', 'veg'].map(layer));
  const g1 = b1.map((b, i) => b + s1[i]);
  const at = (x, y) => y * N + x;
  // ground change at the vent (min over a 3x3) and the highest rise within 40 cells
  let ventDz = Infinity, maxRise = -Infinity, ringRise = -Infinity;
  const ventFall = [];
  for (let y = VY - 40; y <= VY + 40; y++) for (let x = VX - 40; x <= VX + 40; x++) {
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const d = Math.hypot(x - VX, y - VY), dz = g1[at(x, y)] - g0[at(x, y)];
    if (d <= 1.5) ventDz = Math.min(ventDz, dz);
    if (d <= 40) maxRise = Math.max(maxRise, dz);
    ventFall.push(dz);
  }
  // ring: highest rise just outside the crater radius
  const vent = vs.vents.find((q) => q.id === ev.id) || {};
  const cR = (ev.craterR || 0) / e.world.cellSize;
  if (cR) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = Math.hypot(x - VX, y - VY); if (d > cR * 0.9 && d < cR * 1.4) ringRise = Math.max(ringRise, g1[at(x, y)] - g0[at(x, y)]); }
  // plants: mean veg change within 15 cells of the vent and far away (> 60 cells)
  let vn = 0, vnc = 0, vf = 0, vfc = 0;
  for (let i = 0; i < N * N; i++) { const x = i % N, y = Math.floor(i / N), d = Math.hypot(x - VX, y - VY); if (d < 15) { vn += v1[i] - v0[i]; vnc++; } else if (d > 60) { vf += v1[i] - v0[i]; vfc++; } }
  // tuff far from the vent (pyroclastic flows): cells > 30 cells away whose top unit is tuff
  const vr = await layer('volcRock');
  let tuffFar = 0;
  for (let i = 0; i < N * N; i++) {
    const x = i % N, y = Math.floor(i / N);
    if (Math.hypot(x - VX, y - VY) < 30) continue;
    if (sim.volcLayer(vr, x, y, b1[i] - 0.01) === 6) tuffFar++;
  }
  const out = {
    style, days: Math.round(e.day - startDay), wallSec: +((performance.now() - w0) / 1000).toFixed(1),
    books: { balPct: s.balanceErrorPct, solidsError_m3: s.solidsError_m3, erupted_m3: s.cumErupted_m3, nan: s.hasNaN, ok: booksOk(s) },
    planned: { coneHeight: ev.coneHeight, lava: ev.lava, pyro: ev.pyro, ashT: ev.ashT, craterD: ev.craterD, craterR: ev.craterR, ringH: ev.ringH },
    coneHeight_m: vent.coneHeight_m, ventDz: +ventDz.toFixed(1), maxRise: +maxRise.toFixed(1), ringRise: +ringRise.toFixed(1),
    vol: { basalt: vs.basalt_m3, cinders: vs.cinders_m3, plug: vs.plug_m3, andesite: vs.andesite_m3, ash: vs.ash_m3, tuff: vs.tuff_m3, breccia: vs.breccia_m3 },
    area: { basalt: vs.basaltArea_m2, cinders: vs.cindersArea_m2, andesite: vs.andesiteArea_m2, ash: vs.ashArea_m2, tuff: vs.tuffArea_m2, breccia: vs.brecciaArea_m2 },
    tuffFarCells: tuffFar,
    vegNear: vnc ? +(vn / vnc).toFixed(3) : 0, vegFar: vfc ? +(vf / vfc).toFixed(3) : 0,
  };
  R.runs[style] = out;
  check(`${style}.books`, out.books.ok, out.books);
  return out;
}

const H = await run('hawaiian');
const S = await run('strombolian');
check('hawaiian.moreLava', H.vol.basalt > 1.5 * S.vol.basalt && H.area.basalt > 1.5 * S.area.basalt, { h: H.vol.basalt, s: S.vol.basalt, hA: H.area.basalt, sA: S.area.basalt });
check('hawaiian.smallCone', H.coneHeight_m < 0.7 * S.coneHeight_m, { h: H.coneHeight_m, s: S.coneHeight_m });
check('strombolian.cone', Math.abs(S.coneHeight_m - S.planned.coneHeight) < 2, { h: S.coneHeight_m, planned: S.planned.coneHeight });

const V = await run('vulcanian');
check('vulcanian.andesite', V.vol.andesite > 0.5 * V.planned.lava && V.vol.basalt < 0.05 * V.planned.lava, { andesite: V.vol.andesite, basalt: V.vol.basalt });
check('vulcanian.thickFlow', V.vol.andesite / Math.max(V.area.andesite, 1) > 1.5 * S.vol.basalt / Math.max(S.area.basalt, 1), { andesite_m: V.vol.andesite / V.area.andesite, basalt_m: S.vol.basalt / S.area.basalt });
check('vulcanian.ash', V.vol.ash > 1e6 && V.area.ash > 1e5, { ash: V.vol.ash, area: V.area.ash });

const P = await run('pelean', { maxDays: 9000 });
check('pelean.dome', P.vol.andesite > 0.5 * P.planned.lava && P.ventDz > 40, { andesite: P.vol.andesite, ventDz: P.ventDz });
check('pelean.pyroclasticFlows', P.tuffFarCells > 30, { tuffFarCells: P.tuffFarCells, tuff: P.vol.tuff });

const L = await run('plinian');
check('plinian.crater', L.ventDz < -50, { ventDz: L.ventDz });
check('plinian.ashBlanket', L.area.ash > 0.15 * (N * e.world.cellSize) ** 2, { ashArea: L.area.ash, mapArea: (N * e.world.cellSize) ** 2 });
check('plinian.pyroclasticFlows', L.tuffFarCells > 30, { tuffFarCells: L.tuffFarCells });
check('plinian.plantsBuried', L.vegNear < -0.02 || L.vegNear <= 0, { vegNear: L.vegNear });

const F = await run('phreatic');
check('phreatic.crater', F.ventDz < -10 && F.vol.breccia > 1e5, { ventDz: F.ventDz, breccia: F.vol.breccia });
check('phreatic.noLava', F.vol.basalt + F.vol.andesite < 1, { basalt: F.vol.basalt, andesite: F.vol.andesite });

const M = await run('phreatomagmatic');
check('phreatomagmatic.maar', M.ventDz < -30 && M.ringRise > 5 && M.vol.tuff > 1e6, { ventDz: M.ventDz, ringRise: M.ringRise, tuff: M.vol.tuff });

R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
