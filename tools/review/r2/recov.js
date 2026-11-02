(async () => {
  const sim = window.sim, e = sim.engine; sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' }); sim.pause();
  const N = e.N, x = N / 2, y = N / 2, r = 25;
  const disc = (a, k = 1, o = 0) => { let s = 0, n = 0; for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) if ((i - x) ** 2 + (j - y) ** 2 <= r * r) { s += a[(j * N + i) * k + o]; n++; } return +(s / n).toFixed(3); };
  const snap = async (t) => ({ t, veg: disc(await e.readLayer('veg')), soil: disc(await e.readLayer('soil')), moist: disc(await e.readLayer('plant'), 4, 1) });
  const out = [await snap('before')];
  sim.brush('wildfire', { x, y, radius: r }); e.events.fireWeather = 0; await e.run(2.5, { batchDays: 0.01 });
  out.push(await snap('after fire'));
  await e.run(365 * 60); out.push(await snap('60 yr'));
  // control: same map, no fire, 60 years
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' }); sim.pause(); await e.run(365 * 60 + 2.5); out.push(await snap('60 yr, no fire'));
  return out;
})()
