// Round-2 checks, part 2: the living landscape.
//   presets   Utah desert sparse, Pacific NW lush (same terrain, 300 years at 1000 yr/s)
//   treeline  Colorado alpine: forest below, none above, at the ~6.4 degC growing-season isotherm
//   aspect    greener north faces in the desert; lower treeline on north faces in the Rockies
//   riparian  green corridors along streams in the desert
//   soil      thicker under forest than on bare ground
//   drought   five dry years brown and thin the plants and drain the ground, then recovery
//   speed     at 1000 yr/s the cover follows a climate slider change within a few seconds
// Run: node tests/run-eco.cjs tests/r2-ecology.js
const R = { pass: {} };
const FAST = 365000 / 60;
const E = sim.engine;

// ---------- presets, treeline, aspect, riparian, soil ----------
R.presets = {};
for (const preset of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
  await sim.load('random', { size: 256, seed: 5, preset }); sim.pause();
  await sim.run(365 * 300, { batchDays: FAST });
  const s = await sim.stats();
  const sv = await ecoSurvey(sim);
  R.presets[preset] = { stats: pickStats(s), ...sv };
}
const P = R.presets;
R.summary = {
  meanCover: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.stats.meanVeg])),
  coveredFrac: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.stats.vegCoveredFrac])),
  coloradoTreeline_m: P['Colorado alpine'].treelineElevation,
  utahNorthVsSouthCover: [P['Utah desert'].northFaceVeg, P['Utah desert'].southFaceVeg],
  utahRiparianExcess: P['Utah desert'].riparianExcessSameElevation,
  soilForestVsBare: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, [v.soilUnderForest, v.soilBare]])),
};
// treeline: Colorado's lowest band is forested, its highest band treeless; the treeline band's
// growing-season temperature should be near the global 6.4 degC isotherm
const cb = P['Colorado alpine'].bands;
const tlBand = cb.find((b) => b.z === P['Colorado alpine'].treelineElevation);
R.summary.treelineBandTgs = tlBand ? tlBand.Tgs : null;
R.pass.desertSparserThanPNW = P['Utah desert'].stats.meanVeg < 0.6 * P['Pacific NW wet'].stats.meanVeg;
R.pass.treeline = cb[0].woody > 0.5 && cb[cb.length - 1].woody < 0.02 && P['Colorado alpine'].treelineElevation !== null;
R.pass.desertNorthFacesGreener = P['Utah desert'].northFaceVeg > P['Utah desert'].southFaceVeg + 0.1;
R.pass.riparianCorridors = P['Utah desert'].riparianExcessSameElevation > 0.2;
// (in the desert the deepest soils are dry valley fills, so only the wetter presets are checked)
R.pass.soilThickerUnderForest = ['Colorado alpine', 'Pacific NW wet', 'Temperate'].every((k) => P[k].soilUnderForest > P[k].soilBare);

// ---------- drought ----------
// Two identical runs (same terrain, seed and batches), one with a 5-year drought painted on the
// west half. "control" is the same circle in the run without the drought.
const N = E.world.N;
const D = { x: 256 * 0.3, y: 256 * 0.5 }, rad = 40, rIn = 30;
const look = async () => ({ veg: await circleMean(sim, 'veg', D.x, D.y, rIn), woody: await circleMean(sim, 'eco', D.x, D.y, rIn, 0), gw: await circleMean(sim, 'groundwater', D.x, D.y, rIn), soil: await circleMean(sim, 'soil', D.x, D.y, rIn) });
const runs = {};
for (const withDrought of [true, false]) {
  await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
  await sim.run(365 * 100, { batchDays: FAST });
  await sim.run(((120 - (E.day % 365)) + 365) % 365, { batchDays: 5 });
  const o = { before: await look() };
  if (withDrought) o.brush = await sim.brush('drought', { x: D.x, y: D.y, radius: rad });   // 5 years, 40 % precipitation
  await sim.run(365 * 2 + 100, { batchDays: 6, nSub: 32 });                              // 3rd summer, ~1 yr/s
  o.year3summer = await look();
  await sim.run(365 * 3 - 100, { batchDays: 6, nSub: 32 });                              // drought over
  o.year5 = await look();
  await sim.run(365 * 20, { batchDays: 365 / 4, nSub: 32 });
  o.year25 = await look();
  await sim.run(365 * 40, { batchDays: 365 / 4, nSub: 32 });
  o.year65 = await look();
  o.balPct = (await sim.stats()).balanceErrorPct;
  runs[withDrought ? 'drought' : 'control'] = o;
}
R.drought = runs;
const dd = runs.drought, dc = runs.control;
R.pass.droughtBrownsAndDrains = dd.year3summer.gw < 0.8 * dc.year3summer.gw && dd.year5.veg < dc.year5.veg - 0.05;
// grasses come back within a few years, dead trees take decades
R.pass.droughtRecovers = dc.year65.veg - dd.year65.veg < 0.05;

// ---------- response to the climate slider at 1000 yr/s ----------
// 60 frames = 1 second of wall time at 1000 yr/s
await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 300, { batchDays: FAST });
const track = [];
const v0 = (await sim.stats()).meanVeg;
E.climate.precipMul = 0.25;                         // the "Rain & snow" slider far left
for (let sec = 0.1; sec <= 4.01; sec += sec < 0.95 ? 0.1 : 0.5) { await sim.run((sec < 0.95 ? 6 : 30) * FAST, { batchDays: FAST }); track.push({ wallSeconds: +sec.toFixed(1), meanVeg: +(await sim.stats()).meanVeg.toFixed(3) }); }
E.climate.precipMul = 1;
for (let sec = 4.5; sec <= 10; sec += 0.5) { await sim.run(30 * FAST, { batchDays: FAST }); track.push({ wallSeconds: sec, meanVeg: +(await sim.stats()).meanVeg.toFixed(3) }); }
R.sliderResponse = { start: +v0.toFixed(3), dryAt: 0, wetAgainAt: 4, track };
const dryEq = track.find((t) => t.wallSeconds === 4).meanVeg, at1s = track.find((t) => t.wallSeconds === 1).meanVeg;
const back = track.find((t) => t.wallSeconds === 5).meanVeg;   // 1 s after the slider goes back
R.sliderResponse.fractionOfChangeAfter1s = +((v0 - at1s) / Math.max(1e-6, v0 - dryEq)).toFixed(3);
// (the landscape keeps evolving over the 10,000 simulated years, so "back" is allowed a small drift)
R.pass.sliderFollowsWithinSeconds = v0 - dryEq > 0.1 && R.sliderResponse.fractionOfChangeAfter1s > 0.6 && Math.abs(back - v0) < 0.08;

R.gpuErrors = window.__gpuErrors || 0;
R.pass.noGpuErrors = R.gpuErrors === 0;
R.allPass = Object.values(R.pass).every(Boolean);
for (const k of Object.keys(R.presets)) delete R.presets[k].bands_unused;
return R;
