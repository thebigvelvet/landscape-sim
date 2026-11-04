// Which seeds get which intrusions, per province (CPU only: loads without spin-up).
const e = sim.engine; const R = {};
for (const prov of ['plateau', 'rockies', 'valleyRidge', 'gulf']) {
  R[prov] = {};
  for (let seed = 1; seed <= 12; seed++) {
    await sim.load('random', { size: 256, seed, province: prov, volcanoes: false, spinUp: false }); sim.pause();
    const a = e.strataInfo.anoms.filter((q) => ['stock', 'sill', 'laccolith', 'neck'].includes(q.type) || q.kind === 'swarm');
    if (a.length) R[prov][seed] = a.map((q) => `${q.type}${q.kind ? ':' + q.kind : ''} hw${Math.round(q.hw)} below${Math.round(q.below ?? 0)}`);
  }
}
return R;
