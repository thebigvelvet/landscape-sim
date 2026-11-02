// Harness: --eval=<wrapper setting window.__preset etc. + this file> --shot=...
// Loads a preset, runs it to plant equilibrium, moves to a day of year, freezes on a clear day.
const preset = window.__preset || 'Colorado alpine';
await sim.load(window.__scen || 'random', { size: 512, seed: window.__seed || 2, preset });
sim.pause();
await sim.run(365 * 30);
const e = sim.engine;
const target = window.__doy ?? 200;
await sim.run((((target - e.day) % 365) + 365) % 365 + 0.01);
if (window.__setup) await window.__setup();
// a clear day for the picture
e.lastClimate.precipRate_mm_per_day = 0;
sim.renderer.cloud = 0;
const c = sim.renderer.camera;
if (window.__zoom) { c.dist *= window.__zoom; c.pitch = window.__pitch ?? 0.45; c.yaw += window.__yaw ?? 0; }
if (window.__target) { c.target[0] = window.__target[0]; c.target[2] = window.__target[1]; }
if (window.__overlay) sim.setOverlay(window.__overlay);
await new Promise((r) => setTimeout(r, 2500));
const s = await sim.stats();
return { preset, day: e.day, meanVeg: s.meanVeg, vegCoveredFrac: s.vegCoveredFrac, woody: s.meanWoodyCover, burnedFrac: s.burnedFrac, bal: s.balanceErrorPct, nan: s.hasNaN, gpuErrors: window.__gpuErrors || 0, fps: e.fps, extra: window.__extra };
