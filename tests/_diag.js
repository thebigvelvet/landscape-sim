const out = {};
const presets = window.__presets || ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate'];
for (const preset of presets) {
  for (const sc of ['cone', 'random']) {
    await sim.load(sc, { size: 256, seed: 3, preset }); sim.pause();
    const e = sim.engine;
    const [b, s, v, aux, gw] = [await e.readLayer('bedrock'), await e.readLayer('soil'), await e.readLayer('veg'), await e.readLayer('vegAux'), await e.readLayer('groundwater')];
    const N = e.world.N, datum = e.datum;
    let zmin = 1e9, zmax = -1e9;
    for (let i = 0; i < N * N; i++) { const z = b[i] + s[i]; zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
    const bands = Array.from({ length: 6 }, () => ({ n: 0, v: 0, W: 0, soil: 0 }));
    for (let i = 0; i < N * N; i++) {
      const z = b[i] + s[i]; const k = Math.min(5, Math.floor(6 * (z - zmin) / (zmax - zmin + 1e-9)));
      bands[k].n++; bands[k].v += v[i]; bands[k].W += aux[4 * i]; bands[k].soil += s[i];
    }
    const st = await sim.stats();
    out[preset + '/' + sc] = {
      zRange: [Math.round(zmin + datum), Math.round(zmax + datum)], meanVeg: +st.meanVeg.toFixed(3), cov: +st.vegCoveredFrac.toFixed(3),
      bands: bands.map((q) => `${(q.v / q.n).toFixed(2)} W${(q.W / q.n).toFixed(2)} s${(q.soil / q.n).toFixed(2)}`),
    };
  }
}
return out;
