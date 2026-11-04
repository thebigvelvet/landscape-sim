// Round 11 pictures. Harness: sh tests/shoot-data.sh <name> 'window.__mode="arch"' tests/visual-landforms.js
//   arch     a Colorado Plateau map (window.__seed, default 4) after window.__years (default 10000):
//            the camera goes low beside the first standing arch, looking through it
//   karst    a Valley and Ridge map (seed 3) after window.__years (default 20000); window.__overlay
//            'subsurface' shows the rock
//   intrude  a map of window.__prov (default rockies) with an intrusion, after window.__years
const e = sim.engine, c = sim.renderer.camera, mode = window.__mode || 'arch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
const N = window.__size || 256;
const prov = window.__prov || (mode === 'arch' ? 'plateau' : mode === 'karst' ? 'valleyRidge' : 'rockies');
const preset = { plateau: 'Utah desert', valleyRidge: 'Temperate', rockies: 'Colorado alpine', gulf: 'Gulf Coast humid' }[prov];
const seed = window.__seed ?? (mode === 'arch' ? 4 : 3);
await sim.load('random', { size: N, seed, preset, province: prov, volcanoes: false }); sim.pause();
if (window.__karstOff) e.karstValleys = false;
out.seed = seed; out.notes = e.strataInfo.notes; out.anoms = e.strataInfo.anoms.map((a) => a.type + (a.kind ? ':' + a.kind : ''));
await e.run(365 * (window.__years ?? (mode === 'arch' ? 10000 : 20000)));
const doy = ((e.day % 365) + 365) % 365;
await e.run((240 - doy + 365) % 365 || 365, { batchDays: 5 });
let fx = N / 2, fy = N / 2;
if (mode === 'arch') {
  const A = sim.archStats(); out.arches = A.list; out.fallen = A.fallen;
  const a = A.list[window.__which ?? 0];
  if (a) {
    const q = e.arches.list[window.__which ?? 0];
    fx = a.x; fy = a.y;
    // look along the joint normal, through the opening
    c.yaw = window.__yaw ?? Math.atan2(q.nx, q.ny) + (window.__dyaw ?? 0.25);
    out.archTargetY = (a.floor + 0.6 * a.openH) * sim.renderer.vex;
  }
  c.pitch = window.__pitch ?? 0.12;
} else if (mode === 'intrude') {
  const s = e.strataInfo.anoms.find((q) => ['stock', 'sill', 'dike', 'neck', 'laccolith'].includes(q.type) && (q.kind || q.type !== 'dike'));
  if (s) { const cc = (N - 1) / 2, cs = e.world.cellSize; fx = s.seg[0] / cs + cc; fy = s.seg[1] / cs + cc; }
  c.yaw = window.__yaw ?? 0.7; c.pitch = window.__pitch ?? 0.5;
} else { c.yaw = window.__yaw ?? 0.7; c.pitch = window.__pitch ?? 0.6; }
if (window.__fx !== undefined) { fx = window.__fx; fy = window.__fy; }
const [wx, wz] = sim.renderer.gridToWorld(fx, fy);
c.target[0] = wx; c.target[2] = wz;
c.dist *= window.__zoom ?? (mode === 'arch' ? 0.05 : 0.6);
if (window.__ty !== undefined) c.target[1] = window.__ty;
else if (out.archTargetY !== undefined) c.target[1] = out.archTargetY;
if (window.__overlay) sim.setOverlay(window.__overlay);
e.lastClimate && (e.lastClimate.precipRate_mm_per_day = 0);
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, sedOut: s.cumSedimentOut_m3, nan: s.hasNaN, karst: (({ layer, ...r }) => r)(await sim.karstStats()), gpuErrors: window.__gpuErrors || 0, gpuMsgs: window.__gpuErrorMsgs, cam: { target: [...c.target], dist: c.dist } });
out.png = sim.renderer.canvas.toDataURL('image/png');
return out;
