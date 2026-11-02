// Screenshot scene for the round-2 README. Configured by a first line `window.__cfg = {...}`
// (tests/r2-shots.cjs writes it). The harness captures the window ~1.5 s after this returns.
const cfg = window.__cfg || {};
const FAST = 365000 / 60;
const E = sim.engine;
await sim.load(cfg.scen || 'random', { size: cfg.size || 512, seed: cfg.seed ?? 5, preset: cfg.preset || 'Colorado alpine' }); sim.pause();
await sim.run(365 * (cfg.years ?? 300), { batchDays: FAST });
await sim.run((((cfg.doy ?? 200) - (E.day % 365)) + 365) % 365, { batchDays: 3 });
const N = E.world.N;
const out = {};
if (cfg.fire) {
  out.fire = await sim.brush('wildfire', { x: N * cfg.fire[0], y: N * cfg.fire[1], radius: cfg.fire[2] });
  await sim.run(cfg.afterFireDays ?? 300, { batchDays: 3, nSub: 32 });
}
if (cfg.storm) {
  sim.setTool('storm');
  out.storm = await sim.brush('storm', { x: N * cfg.storm[0], y: N * cfg.storm[1], radius: cfg.storm[2] });
  const b = sim.renderer.brush; b.x = N * cfg.storm[0]; b.y = N * cfg.storm[1]; b.radius = cfg.storm[2]; b.visible = true;
  await sim.run(cfg.stormDays ?? 1.2, { batchDays: 1 / 60, nSub: 64 });
}
sim.setOverlay(cfg.overlay || 'none');
const cam = sim.renderer.camera;
if (cfg.cam) { cam.yaw = cfg.cam.yaw; cam.pitch = cfg.cam.pitch; cam.dist = cam.extent * cfg.cam.dist; if (cfg.cam.target) cam.target = [cfg.cam.target[0] * cam.extent, cfg.cam.target[1], cfg.cam.target[2] * cam.extent]; }
if (cfg.play) { sim.setSpeed(cfg.play); sim.play(); }
const s = await sim.stats();
out.stats = { year: s.year, meanVeg: s.meanVeg, vegCoveredFrac: s.vegCoveredFrac, burnedFrac: s.burnedFrac, bal: s.balanceErrorPct, nan: s.hasNaN };
out.gpuErrors = window.__gpuErrors || 0;
return out;
