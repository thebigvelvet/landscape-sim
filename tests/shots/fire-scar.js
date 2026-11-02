// Screenshot: a wildfire on a forested slope, then two years with a storm over the scar (natural view).
await sim.load('random', { size: 512, seed: 4, preset: 'Colorado alpine' }); sim.pause();
await sim.run(30 * 365 + 150);
const v = await sim.engine.readLayer('veg'); let best = [0, 256, 256];
for (let y = 120; y < 400; y += 8) for (let x = 120; x < 400; x += 8) { let s = 0; for (let k = -10; k <= 10; k += 5) for (let j = -10; j <= 10; j += 5) s += v[(y + k) * 512 + x + j]; if (s > best[0]) best = [s, x, y]; }
sim.brush('wildfire', { x: best[1], y: best[2], radius: 30 });
sim.brush('storm', { x: best[1], y: best[2], radius: 60, days: 3 });
await sim.run(2 * 365);
const R = sim.renderer; const N = 512, c = (N - 1) / 2, dx = 10;
R.camera.target = [(best[1] - c) * dx, R.camera.target[1], (best[2] - c) * dx]; R.camera.dist *= 0.45;
await new Promise((r) => setTimeout(r, 800));
const s = await sim.stats();
return { fireAt: best.slice(1), burnedFrac: s.burnedFrac, meanVeg: s.meanVeg, balance: s.balanceErrorPct };
