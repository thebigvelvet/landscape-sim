// Round 3 pictures. Harness: tests/shoot.sh <name> 'window.__mode="dam"' tests/visual-r3.js
//   dam        a ridge raised across a valley, then a flood from upstream fills the lake behind it
//   channel    a spiral channel carved down a cone, then a cloudburst on the summit
//   avalanche  rugged alpine terrain after 50 years, early March (window.__aval = false: no avalanches)
const e = sim.engine, c = sim.renderer.camera, mode = window.__mode || 'dam';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
e.avalanches = window.__aval ?? true;
if (mode === 'dam') {
  await sim.load('valley', { size: 512, seed: 1, preset: 'Temperate' }); sim.pause();
  await sim.run(365 * 2 + 150);
  const N = e.N, pts = [];
  for (let x = N * 0.22; x <= N * 0.78; x += 6) pts.push({ x, y: N * 0.4 });
  await sim.sculptStroke('raise', pts, { radius: 16, intensity: 2.8, dabs: 14 });
  sim.brush('flood', { x: N * 0.5, y: N * 0.9, days: 2, intensity: 3 });
  await sim.run(3, { batchDays: 1 / 48 });
  c.yaw = 2.6; c.pitch = 0.5; c.dist *= 0.8;
} else if (mode === 'channel') {
  await sim.load('cone', { size: 512, seed: 2, preset: 'Temperate' }); sim.pause();
  await sim.run(365 * 2 + 160);
  const N = e.N, pts = [];
  for (let t = 0; t <= 1; t += 0.004) { const r = N * (0.04 + 0.36 * t), a = 9.5 * t; pts.push({ x: N / 2 + r * Math.cos(a), y: N / 2 + r * Math.sin(a) }); }
  await sim.sculptStroke('channel', pts, { radius: 8, intensity: 1.5 });
  sim.brush('storm', { x: N / 2, y: N / 2, radius: 40, days: 2, intensity: 2 });
  await sim.run(1.2, { batchDays: 1 / 48 });
  c.pitch = 0.75; c.dist *= 0.75;
} else {
  await sim.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' }); sim.pause();
  await sim.run(365 * 50 + 65);
  c.yaw = 0.3; c.pitch = 0.42; c.dist *= 0.55;
}
e.lastClimate.precipRate_mm_per_day = 0;
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, woody: s.meanWoodyCover, snow_m3: s.totalSnowSWE_m3, maxWater: s.maxWaterDepth, gpuErrors: window.__gpuErrors || 0 });
return out;
