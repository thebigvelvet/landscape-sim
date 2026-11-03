// Round 7 pictures. Harness: tests/shoot.sh <name> 'window.__mode="ice"' tests/visual-glacier.js
//   ice       Colorado alpine at window.__T (default -6 C) after window.__years (1000), late August
//   overlay   the same, shown with the Glaciers view
//   retreat   grown as in `ice`, then warmed back to normal for 400 years: bare U-valleys and moraines
//   carved    the retreat, shown with the change-since-start view
const e = sim.engine, c = sim.renderer.camera, mode = window.__mode || 'ice';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
const T = window.__T ?? -6, years = window.__years ?? 1000;
await sim.load('random', { size: 512, seed: window.__seed ?? 7, preset: 'Colorado alpine' }); sim.pause();
e.climate.tempOffset = T;
await sim.run(365 * years);
if (mode === 'retreat' || mode === 'carved') {
  e.climate.tempOffset = 0;
  await sim.run(365 * 400);
}
// end in late August, when the seasonal snow is gone and bare ice shows below the snowline
const doy = ((e.day % 365) + 365) % 365;
await sim.run((240 - doy + 365) % 365 || 365, { batchDays: 5 });
c.yaw = window.__yaw ?? 0.6; c.pitch = window.__pitch ?? 0.5; c.dist *= window.__zoom ?? 0.7;
if (mode === 'overlay') sim.setOverlay('glaciers');
if (mode === 'carved') sim.setOverlay('change');
e.lastClimate.precipRate_mm_per_day = 0;
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, doy: e.day % 365, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, glacier: await sim.glacierStats(), gpuErrors: window.__gpuErrors || 0, gpuMsgs: window.__gpuErrorMsgs });
return out;
