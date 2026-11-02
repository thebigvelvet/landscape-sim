// Rock layer pictures. Harness: tests/shoot.sh <name> 'window.__strata=false' tests/visual-strata.js
// A random Utah landscape (window.__seed, default 3) after 30,000 years, rock layers on (default) or off.
const e = sim.engine, c = sim.renderer.camera;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
e.strata = window.__strata ?? true;
await sim.load('random', { size: 512, seed: window.__seed ?? 3, preset: 'Utah desert' }); sim.pause();
await sim.run(365 * 30000 + 160);
c.yaw = window.__yaw ?? 0.7; c.pitch = 0.38; c.dist *= 0.6;
e.lastClimate.precipRate_mm_per_day = 0;
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
return { strata: e.strata, rocks: e.strataInfo.describe, day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, maxErosion: s.maxErosion_m, gpuErrors: window.__gpuErrors || 0 };
