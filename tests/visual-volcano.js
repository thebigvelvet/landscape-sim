// Round 8 pictures. Harness: tests/shoot.sh <name> 'window.__mode="erupt"' tests/visual-volcano.js
//   erupt     a fresh eruption on a valley side, a few months in: cone, plume, glowing flows
//   cooled    the same eruption after it has set: black basalt down the valley, red-black cone
//   overlay   the cooled flow shown with the Volcanic rock view
//   old       a random map that starts with an old volcano (window.__seed, default: first such seed)
//   worn      that old-volcano map after window.__years (default 20000) of erosion
//   side      block side cut through the cooled flow (camera low, looking at the south edge)
// window.__style picks the eruption style (sim/volcano.js ERUPTION_STYLES; default Strombolian).
// The result includes the picture as a data URL (canvas.toDataURL), as capturePage can hang.
const e = sim.engine, c = sim.renderer.camera, mode = window.__mode || 'erupt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
const N = window.__size || 512;
if (mode === 'old' || mode === 'worn') {
  let seed = window.__seed;
  if (!seed) for (seed = 1; seed < 60; seed++) { await sim.load('random', { size: N, seed, volcanoes: true, spinUp: false }); if (e.volcanoInfo.length) break; }
  await sim.load('random', { size: N, seed, volcanoes: true }); sim.pause();
  out.seed = seed; out.info = e.volcanoInfo;
  if (mode === 'worn') await sim.run(365 * (window.__years ?? 20000));
  const doy = ((e.day % 365) + 365) % 365;
  await e.run((240 - doy + 365) % 365 || 365, { batchDays: 5 });   // late August
  if (window.__overlay) sim.setOverlay('volcanic');
  const v = e.volcanoInfo[0];
  if (v) { const [wx, wz] = sim.renderer.gridToWorld(v.x, v.y); c.target[0] = wx; c.target[2] = wz; }
  c.yaw = window.__yaw ?? 0.6; c.pitch = window.__pitch ?? 0.55; c.dist *= window.__zoom ?? 0.45;
} else {
  await sim.load('valley', { size: N, seed: 3, relief: 0.6, preset: window.__preset || 'Colorado alpine', volcanoes: false }); sim.pause();
  const k = N / 256;
  await e.run(window.__startDay ?? 150, { batchDays: 5 });   // erupt in early summer
  const ev = sim.brush('volcano', { x: (128 + 25) * k, y: 184 * k, style: window.__style }); await ev.ready;
  if (mode === 'erupt') await e.run(window.__days ?? 120, { batchDays: 1 });
  else {
    while (true) { await e.run(30, { batchDays: 2 }); const s = await sim.stats(); if (!s.erupting && s.hotLavaCells === 0) break; }
    // end in late August, when the seasonal snow is gone
    const doy = ((e.day % 365) + 365) % 365;
    await e.run((240 - doy + 365) % 365 || 365, { batchDays: 5 });
  }
  const [wx, wz] = sim.renderer.gridToWorld((128 + 15) * k, 150 * k);
  c.target[0] = wx; c.target[2] = wz;
  c.yaw = window.__yaw ?? (mode === 'side' ? 0.05 : 0.9); c.pitch = window.__pitch ?? (mode === 'side' ? 0.12 : 0.5); c.dist *= window.__zoom ?? 0.4;
  if (mode === 'erupt') { sim.setSpeed(0.05); sim.play(); }
}
if (mode === 'overlay') sim.setOverlay('volcanic');
e.lastClimate && (e.lastClimate.precipRate_mm_per_day = 0);
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, erupted: s.cumErupted_m3, nan: s.hasNaN, volc: await sim.volcanoStats(), gpuErrors: window.__gpuErrors || 0, gpuMsgs: window.__gpuErrorMsgs });
out.png = sim.renderer.canvas.toDataURL('image/png');
sim.pause();
return out;
