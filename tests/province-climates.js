// Province home climates (src/ui/panel.js pickHomeClimate) and the Gulf Coast humid preset.
//   node scripts/launch.cjs --eval=tests/province-climates.js --out=tests/out-province-climates.json
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e = sim.engine, R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const $ = (id) => document.getElementById(id);
const preset = () => e.climate.presetName;
// a load shows the #loading overlay and fades it (class 'fade') when done
const waitLoad = async () => { await sleep(200); for (let k = 0; k < 300; k++) { if ($('loading').classList.contains('fade')) break; await sleep(100); } await sleep(500); };
const choose = async (prov) => { $('province').value = prov; $('province').dispatchEvent(new Event('change')); await waitLoad(); };
$('size').value = '256';
// 1. picking a province brings its home climate
await choose('gulf');
R.afterGulf = { preset: preset(), province: e.provinceUsed, toast: $('toast')?.textContent?.slice(0, 80) };
check('gulfBringsItsClimate', preset() === 'Gulf Coast humid' && e.provinceUsed === 'gulf', R.afterGulf);
// 2. your own climate stands when you remake the same province
document.querySelector('.preset[data-preset="Temperate"]').click();
$('generate').click(); await waitLoad();
check('ownClimateStands', preset() === 'Temperate' && e.provinceUsed === 'gulf', { preset: preset() });
// 3. a new province brings its climate again
await choose('rockies');
check('rockiesBringsAlpine', preset() === 'Colorado alpine', { preset: preset() });
await choose('plateau');
check('plateauBringsDesert', preset() === 'Utah desert', { preset: preset() });
// 4. Random: the climate follows the province the seed picks
$('seed').value = '12'; await choose('random');
const p12 = e.provinceUsed;
check('randomFollowsSeed', preset() === sim.provinces[p12].climate, { province: p12, preset: preset() });
// 5. the Gulf climate itself: 30 years on the Gulf plain, with Temperate as a comparison
const run = async (pr) => {
  sim.pause(); await sim.load('random', { size: 256, seed: 11, preset: pr, province: 'gulf', volcanoes: false }); sim.pause();
  await e.run(30 * 365, { batchDays: 5 });
  // late January and late July snapshots of snow and frost
  const at = async (doy) => { const d = ((e.day % 365) + 365) % 365; await e.run(((doy - d) % 365 + 365) % 365 || 365, { batchDays: 1 });
    const sw = await e.readLayer('snowSWE'), fr = await e.readLayer('frostDepth'); let s = 0, f = 0; for (let i = 0; i < sw.length; i++) { s += sw[i]; f += fr[i]; } return { snow_mm: 1000 * s / sw.length, frost_m: f / fr.length }; };
  const jan = await at(25);
  const st = await sim.stats();
  return { jan, meanVeg: st.meanVeg, groundwater_m3: st.totalGroundwater_m3, precip_m3: st.cumPrecip_m3, evap_m3: st.cumEvapLoss_m3, bal: st.balanceErrorPct, nan: st.hasNaN };
};
R.gulfHumid = await run('Gulf Coast humid');
R.temperate = await run('Temperate');
const G = R.gulfHumid, T = R.temperate;
check('gulfClimateSane', !G.nan && Math.abs(G.bal) < 0.01 && G.jan.snow_mm < 1 && G.jan.frost_m < 0.02 && G.meanVeg > 0.5 && G.precip_m3 > T.precip_m3,
  { gulf: G, temperate: T });
R.gpuErrors = window.__gpuErrors || 0;
check('noGpuErrors', R.gpuErrors === 0, { gpuErrors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
try { localStorage.clear(); } catch {}
return R;
