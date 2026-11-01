// Ecology survey: every preset on the same random mountain range, 300 years at 1000 yr/s batches.
const res = {};
const presets = window.__presets || ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate'];
for (const preset of presets) {
  await sim.load(window.__scen || 'random', { size: 256, seed: 5, preset }); sim.pause();
  const s0 = await sim.stats();
  const sv0 = await ecoSurvey(sim);
  await sim.run(365 * (window.__years || 300), { batchDays: 365000 / 60 });
  const s = await sim.stats();
  const sv = await ecoSurvey(sim);
  res[preset] = { start: { ...pickStats(s0), meanWoody: sv0.meanWoody }, end: pickStats(s), survey: sv };
}
res.gpuErrors = window.__gpuErrors || 0;
return res;
