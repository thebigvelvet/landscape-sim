(async () => {
  const S = window.sim, E = S.engine, out = {};
  S.pause();
  // treeline on the Colorado cone: tree cover by elevation band
  await S.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); S.pause(); await S.run(365 * 100 + 200);
  let N = E.world.N, v = await E.readLayer('veg'), pl = await E.readLayer('plant'), b = await E.readLayer('bedrock'), so = await E.readLayer('soil');
  const bands = {};
  for (let i = 0; i < N * N; i++) { const z = Math.round((b[i] + so[i] + E.datum) / 200) * 200; (bands[z] ||= [0, 0, 0]); bands[z][0] += v[i] * pl[4 * i]; bands[z][1] += v[i]; bands[z][2]++; }
  out.coneByElevation = Object.fromEntries(Object.entries(bands).sort().map(([z, a]) => [z + ' m', `trees ${(a[0] / a[2]).toFixed(2)} all ${(a[1] / a[2]).toFixed(2)}`]));
  // Utah: north vs south faces, and near streams vs uplands
  await S.load('random', { size: 512, seed: 7, preset: 'Utah desert' }); S.pause(); await S.run(365 * 100 + 200);
  N = E.world.N; v = await E.readLayer('veg'); b = await E.readLayer('bedrock'); so = await E.readLayer('soil'); const w = await E.readLayer('water');
  const h = (i) => b[i] + so[i]; let nf = [0, 0], sf = [0, 0], rp = [0, 0], up = [0, 0];
  for (let y = 3; y < N - 3; y++) for (let x = 3; x < N - 3; x++) { const i = y * N + x; const gy = (h(i + N) - h(i - N)) / 20;
    if (gy > 0.2) { nf[0] += v[i]; nf[1]++; } else if (gy < -0.2) { sf[0] += v[i]; sf[1]++; }
    let hn = 0; for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) hn = Math.max(hn, w[i + d * N + e]);
    if (hn > 0.08 && w[i] < 0.08) { rp[0] += v[i]; rp[1]++; } else if (hn < 0.005) { up[0] += v[i]; up[1]++; } }
  out.utah = { northFaces: +(nf[0] / nf[1]).toFixed(2), southFaces: +(sf[0] / sf[1]).toFixed(2), streamBanks: +(rp[0] / rp[1]).toFixed(2), uplands: +(up[0] / up[1]).toFixed(2) };
  for (const p of ['Colorado alpine', 'Pacific NW wet', 'Temperate']) { await S.load('random', { size: 512, seed: 7, preset: p }); S.pause(); await S.run(365 * 100 + 200); out[p] = +(await S.stats()).meanVeg.toFixed(2); }
  out.utahMean = null; return out;
})()
