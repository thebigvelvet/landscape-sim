// Live app check: play at 1000 yr/s and at 1 day/s with rendering, then paint each tool through
// the API while it runs. No NaN, no GPU errors, balance closes, frame rate reported.
const R = {};
await sim.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' });
sim.setOverlay('plants');
sim.setSpeed(365000); sim.play();
await new Promise((r) => setTimeout(r, 6000));
let s = await sim.stats();
R.fast = { year: Math.round(s.year), fps: Math.round(s.fps), meanVeg: s.meanVeg, bal: s.balanceErrorPct, nan: s.hasNaN, gpu: sim.gpuTimes };
for (const t of ['storm', 'drought', 'flood', 'wildfire']) await sim.brush(t, { x: 256, y: 256, radius: 30 });
await new Promise((r) => setTimeout(r, 2000));
sim.setSpeed(1);
await new Promise((r) => setTimeout(r, 4000));
s = await sim.stats();
R.slow = { day: s.day, fps: Math.round(s.fps), meanVeg: s.meanVeg, burnedFrac: s.burnedFrac, bal: s.balanceErrorPct, nan: s.hasNaN };
sim.pause();
R.gpuErrors = window.__gpuErrors || 0; R.gpuErrorMsgs = window.__gpuErrorMsgs;
R.pass = !R.fast.nan && !R.slow.nan && R.gpuErrors === 0 && Math.abs(R.slow.bal) < 0.01;
return R;
