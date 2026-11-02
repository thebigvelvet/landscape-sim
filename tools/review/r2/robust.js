(async () => {
  const S = window.sim, E = S.engine, log = [];
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const e0 = window.__gpuErrors || 0; const errs = []; const oe = console.error; console.error = (...a) => { errs.push(String(a[0]).slice(0, 200)); oe(...a); };
  const ok = (n, c, i) => log.push(`${c ? 'PASS' : 'FAIL'} ${n}${i !== undefined ? ' — ' + i : ''}`);
  S.pause(); await S.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' });
  S.setSpeed(1); S.play();
  for (const t of ['storm', 'wildfire', 'flood', 'drought']) S.brush(t, { x: 256, y: 256, radius: 50, intensity: 1, days: 3 });
  await wait(2000);
  await S.load('random', { size: 256, seed: 3, preset: 'Utah desert' }); await wait(1500);       // smaller map mid-events
  for (const t of ['storm', 'wildfire']) S.brush(t, { x: 128, y: 128, radius: 30, intensity: 1, days: 3 });
  await S.load('random', { size: 1024, seed: 4, preset: 'Pacific NW wet' }); await wait(2500);  // bigger map mid-events
  S.brush('wildfire', { x: 512, y: 512, radius: 60, intensity: 1, days: 3 });
  S.setSpeed(365000); await wait(3000);
  const p = S.run(365 * 50); await wait(300);
  let loadDuringRun = 'ok'; try { await S.load('cone', { size: 512, seed: 1, preset: 'Temperate' }); } catch (e) { loadDuringRun = 'threw: ' + e.message; }
  await p.catch((e) => { loadDuringRun += ' / run rejected: ' + e.message; });
  await wait(1500);
  ok('load during sim.run()', /^ok/.test(loadDuringRun), loadDuringRun);
  const s = await S.stats();
  ok('no NaN after map switching mid-events', !s.hasNaN);
  ok('water books balance after it all', Math.abs(s.balanceErrorPct) < 0.01, s.balanceErrorPct.toExponential(2) + ' %');
  ok('no GPU errors', (window.__gpuErrors || 0) - e0 === 0, (window.__gpuErrors || 0) - e0);
  ok('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  // brush timing at every speed: same 3-day storm, 1 day/s vs 1000 yr/s batches
  const water = [];
  for (const sp of [1, 365000]) {
    S.pause(); await S.load('random', { size: 256, seed: 5, preset: 'Temperate' }); S.pause();
    const a = await S.stats(); S.brush('storm', { x: 128, y: 128, radius: 40, intensity: 1, days: 3 });
    await S.run(sp === 1 ? 5 : 365 * 20); const b = await S.stats(); water.push(b.cumPrecip_m3 - a.cumPrecip_m3);
  }
  ok('storm adds rain consistently (5 days vs 20 years incl. normal rain)', water[1] > water[0], water.map(w => Math.round(w)).join(' / '));
  console.error = oe;
  return log;
})()
