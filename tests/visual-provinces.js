// Round 9 pictures: one landscape per province after some erosion, natural view and Subsurface view.
//   window.__province  plateau | rockies | valleyRidge | gulf
//   window.__seed      seed (default 5), window.__years (default 15000), window.__overlay (true: Subsurface)
// Run with tests/shoot-data.sh, which saves the returned data URL as tests/shot-<name>.png.
const e = sim.engine, c = sim.renderer.camera;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prov = window.__province || 'plateau';
const preset = window.__preset || sim.provinces[prov].climate;   // the province's home climate
await sim.load('random', { size: window.__size || 512, seed: window.__seed || 5, preset, province: prov, volcanoes: false }); sim.pause();
const out = { province: prov, describe: e.strataInfo.describe, notes: e.strataInfo.notes };
if (window.__years !== 0) await e.run(365 * (window.__years ?? 15000));
const doy = ((e.day % 365) + 365) % 365;
await e.run((240 - doy + 365) % 365 || 365, { batchDays: 5 });   // late August
if (window.__overlay) sim.setOverlay('subsurface');
c.yaw = window.__yaw ?? 0.7; c.pitch = window.__pitch ?? 0.6; c.dist *= window.__zoom ?? 0.85;
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, gpuErrors: window.__gpuErrors || 0 });
out.png = sim.renderer.canvas.toDataURL('image/png');
return out;
