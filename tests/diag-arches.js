// Diagnostic: arches on Colorado Plateau maps. Finds seeds with joints + eolian sandstone, runs them.
const __pre = window.__seedsOverride; if (__pre) window.__seeds = __pre;
const e = sim.engine; const R = { seeds: {} };
const yrs = window.__years ?? 20000;
const seeds = window.__seeds ?? [1, 2, 3, 4, 5, 6, 7, 8];
for (const seed of seeds) {
  sim.pause(); await sim.load('random', { size: 256, seed, preset: 'Utah desert', province: 'plateau', volcanoes: false }); sim.pause();
  const T = e.strataInfo;
  const info = { joints: T.struct.joints.length, sandBeds: T.beds.filter((b) => ['eolian', 'massiveSand'].includes(b.type)).length, anoms: T.anoms.map((a) => a.type + (a.kind ? ':' + a.kind : '')) };
  R.seeds[seed] = info;
  if (!info.joints && !window.__all) continue;
  const steps = [];
  for (let t = 0; t < yrs; t += 2500) {
    await e.run(2500 * 365);
    const a = sim.archStats(); const s = await sim.stats();
    steps.push({ yr: t + 2500, standing: a.standing, fallen: a.fallen, bridges: a.bridges, cand: a.candidates, necks: a.necks, rock: Math.round(a.rock_m3), solidsErr: Math.round(s.solidsError_m3), sedOut: Math.round(s.cumSedimentOut_m3), bal: s.balanceErrorPct });
  }
  info.steps = steps; info.arches = sim.archStats().list; info.log = sim.archStats().log;
}
R.gpuErrors = window.__gpuErrors || 0; R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
return R;
