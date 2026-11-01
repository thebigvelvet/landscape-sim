(async () => {
  const S = window.sim, E = S.engine, out = [];
  for (const seed of [3, 4, 5, 6]) {
    await S.load('random', { size: 256, seed, preset: 'Colorado alpine' });
    S.setSpeed(1); S.play(); await new Promise(r => setTimeout(r, 1200 + 400 * seed));
    document.getElementById('storm').click(); await new Promise(r => setTimeout(r, 600));
    const lc = E.lastClimate; out.push((lc.precipRate_mm_per_day / E.climate.precipAt(lc.dayOfYear)).toFixed(2));
  }
  return 'storm / normal on 4 random days: ' + out.join(', ');
})()
