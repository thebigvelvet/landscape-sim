const e = sim.engine; const out = [];
for (const spin of [true, false]) {
await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine', spinUp: spin });
sim.pause();
const st = async (l) => { const s = await sim.stats(); out.push({ spin, l, err_m3: s.balanceError_m3, pct: s.balanceErrorPct, P: s.cumPrecip_m3, gw: s.totalGroundwater_m3 }); };
await st('load');
await e.run(1 / 60, { batchDays: 1 / 60 }); await st('1 batch');
await e.run(1, { batchDays: 1 / 60 }); await st('1 day');
await e.run(10, { batchDays: 1 / 60 }); await st('11 days');
await e.run(30, { batchDays: 1 / 60 }); await st('41 days');
}
return out;
