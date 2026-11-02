// Round-2 test suite (plants, soil, weather brushes, picking, robustness). Runs on the real GPU:
//   node scripts/launch.cjs --eval=tests/round2.js --out=tests/out-round2.json
// (or `npm test`). Prints one PASS/FAIL line per check and exits non-zero if anything fails.
// window.__only = ['name', ...] runs a subset (set it from a wrapper script).
const T0 = performance.now();
const report = [];
const results = {};
const only = window.__only || null;
const e = sim.engine;
const r6 = (v) => (Number.isFinite(v) ? +(+v).toPrecision(6) : v);
function check(name, ok, detail) {
  report.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  results[name] = { ok: !!ok, detail };
}
const want = (name) => !only || only.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fresh(scenario, opts) { await sim.load(scenario, opts); sim.pause(); }
const BAL = 0.01;   // % - required water balance closure
async function bal(s) { s = s || await sim.stats(); return { pct: s.balanceErrorPct, ok: Math.abs(s.balanceErrorPct) < BAL && !s.hasNaN }; }
async function layers(names) { const o = {}; for (const n of names) o[n] = await e.readLayer(n); return o; }
function patchMean(arr, N, cx, cy, r, stride = 1, off = 0) {
  let s = 0, n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.ceil(cx + r)); x++)
      if (Math.hypot(x - cx, y - cy) <= r) { s += arr[(y * N + x) * stride + off]; n++; }
  return s / Math.max(1, n);
}
const errors0 = () => ({ gpu: window.__gpuErrors || 0, console: (window.__errors || []).length });

try {
  // ---------------------------------------------------------------- 1. balance with plants, 1000 years
  if (want('balance_plants_1000y')) {
    await fresh('cone', { size: 512, seed: 1, preset: 'Colorado alpine' });
    const t = performance.now();
    await sim.run(365000);
    const s = await sim.stats();
    const b = await bal(s);
    check('balance_plants_1000y', b.ok && s.meanVeg > 0.05, `cone 512 Colorado 1000 yr: balance ${r6(b.pct)} %, NaN ${s.hasNaN}, meanVeg ${s.meanVeg.toFixed(3)}, ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }

  // ---------------------------------------------------------------- 2. each brush keeps the books exact
  if (want('balance_each_brush')) {
    const out = {};
    let ok = true;
    for (const [type, opts, days] of [
      ['storm', { x: 200, y: 260, radius: 40, days: 3 }, 30],
      ['flood', { x: 256, y: 300, radius: 6, days: 0.5 }, 10],
      ['drought', { days: 3 * 365 }, 4 * 365],
      ['wildfire', { x: 300, y: 256, radius: 40 }, 3 * 365],
    ]) {
      for (const bd of [0.02, 365]) {
        await fresh('cone', { size: 512, seed: 1, preset: 'Colorado alpine' });
        await sim.run(30, { batchDays: 1 });
        sim.brush(type, opts);
        if (type === 'wildfire') sim.brush('storm', { x: 300, y: 256, radius: 45, days: 3 });   // rain on the fresh scar
        await sim.run(bd < 1 ? Math.min(days, 12) : days, { batchDays: bd });
        const s = await sim.stats();
        const b = await bal(s);
        out[`${type}@${bd}d`] = r6(b.pct);
        ok = ok && b.ok;
      }
    }
    check('balance_each_brush', ok, `balance error % per brush @ batch length: ${JSON.stringify(out)}`);
  }

  // ---------------------------------------------------------------- 3. no NaN at 1 day/s and 1000 yr/s (interactive)
  if (want('nan_speeds')) {
    const out = {};
    let ok = true;
    for (const speed of [1, 365000]) {
      await fresh('random', { size: 512, seed: 5, preset: 'Colorado alpine' });
      sim.brush('storm', { x: 250, y: 250, radius: 50 });
      sim.brush('wildfire', { x: 150, y: 300, radius: 30 });
      sim.brush('flood', { x: 300, y: 200, radius: 5 });
      sim.brush('drought', { days: 365 });
      sim.setSpeed(speed); sim.play();
      await sleep(4000);
      sim.pause();
      const s = await sim.stats();
      out[speed] = { years: r6(s.year), nan: s.hasNaN, balance: r6(s.balanceErrorPct), meanVeg: r6(s.meanVeg) };
      ok = ok && !s.hasNaN && Math.abs(s.balanceErrorPct) < BAL;
    }
    check('nan_speeds', ok, JSON.stringify(out));
  }

  // ---------------------------------------------------------------- 4. storm & flood volumes are speed-independent
  if (want('event_volume_speed_independent')) {
    // No natural precipitation (precip slider 0): everything that falls is the brushed storm.
    const out = {};
    let ok = true;
    for (const type of ['storm', 'flood']) {
      const vols = [];
      for (const bd of [1 / 60, 0.5, 5, 365, 6083]) {
        await fresh('cone', { size: 256, seed: 1, preset: 'Colorado alpine' });
        e.climate.precipMul = 0;
        const ev = type === 'storm' ? sim.brush('storm', { x: 128, y: 128, radius: 30, days: 3 }) : sim.brush('flood', { x: 128, y: 100, radius: 4, days: 0.5 });
        await sim.run(Math.max(4, bd), { batchDays: bd, nSub: 8 });
        const s = await sim.stats();
        vols.push(s.cumPrecip_m3);
        ok = ok && Math.abs(s.balanceErrorPct) < BAL && !s.hasNaN;
        if (bd === 1 / 60) {
          // expected volume from the brush's own numbers
          let w = 0;
          for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const d = Math.hypot(x - ev.x, y - ev.y); w += Math.min(1, Math.max(0, (ev.r - d) / Math.max(0.3 * ev.r, 1))); }
          out[type + '_expected_m3'] = Math.round(type === 'storm' ? ev.rate * ev.days * w * 100 : 150 * 0.5 * 86400);
        }
        e.climate.precipMul = 1;
      }
      out[type + '_m3_by_batch(1min,12h,5d,1y,16.7y)'] = vols.map(Math.round);
      const exp = out[type + '_expected_m3'];
      const dev = Math.max(...vols.map((v) => Math.abs(v - exp) / exp));
      out[type + '_maxDev'] = r6(dev);
      ok = ok && dev < 0.002;
    }
    check('event_volume_speed_independent', ok, JSON.stringify(out));
  }

  // ---------------------------------------------------------------- 5. same scenario, different batch lengths
  if (want('scenario_batch_consistency')) {
    // Terrain frozen (setLandscapeChange(false)): this isolates plants + water + events from the
    // round-1 talus model, whose relaxation is counted per batch. Batches of 1 day use the round-1
    // daily wet/dry weather instead of mean weather, so they are reported but not gated.
    const rows = {};
    for (const bd of [1, 3, 30, 365, 6083]) {
      await fresh('random', { size: 256, seed: 3, preset: 'Colorado alpine' });
      e.setLandscapeChange(false);
      sim.brush('wildfire', { x: 90, y: 150, radius: 25, spread: false });
      sim.brush('storm', { x: 90, y: 150, radius: 35, days: 3 });
      sim.brush('drought', { days: 2 * 365 });
      const t = performance.now();
      await sim.run(20 * 365, { batchDays: bd, nSub: 16 });
      const s = await sim.stats();
      rows[bd] = {
        meanVeg: s.meanVeg, burned: s.burnedFrac, gw: s.totalGroundwater_m3, outFrac: s.cumOutflow_m3 / s.cumPrecip_m3,
        etFrac: s.cumEvapLoss_m3 / s.cumPrecip_m3, precip: s.cumPrecip_m3, bal: s.balanceErrorPct, sec: (performance.now() - t) / 1000,
      };
      e.setLandscapeChange(true);
    }
    const keys = ['meanVeg', 'burned', 'gw', 'outFrac', 'etFrac', 'precip'];
    const spread = {};
    let ok = true;
    for (const k of keys) {
      const v = Object.entries(rows).filter(([bd]) => +bd >= 30).map(([, r]) => r[k]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      spread[k] = r6((Math.max(...v) - Math.min(...v)) / Math.max(Math.abs(m), 1e-12));
    }
    ok = spread.meanVeg < 0.03 && spread.gw < 0.03 && spread.outFrac < 0.02 && spread.etFrac < 0.03 && spread.precip < 0.01
      && Object.values(rows).every((r) => Math.abs(r.bal) < BAL);
    for (const k in rows) for (const q in rows[k]) rows[k][q] = r6(rows[k][q]);
    const dev = (bd) => `${(100 * (rows[bd].meanVeg / rows[30].meanVeg - 1)).toFixed(1)} % cover, ${(100 * (rows[bd].gw / rows[30].gw - 1)).toFixed(1)} % groundwater`;
    check('scenario_batch_consistency', ok, `20 yr with fire+storm+2yr drought, terrain frozen, batch 30/365/6083 d (1000 yr/s frames are 6083 d): relative spread ${JSON.stringify(spread)}; [info, not gated: vs 30-day batches, 3-day batches differ by ${dev(3)}, 1-day batches (round-1 daily wet/dry weather) by ${dev(1)}]; rows ${JSON.stringify(rows)}`);
  }

  // ---------------------------------------------------------------- 6. burned patch erodes more than an identical unburned one
  if (want('fire_erosion') || want('fire_recovery')) {
    await fresh('cone', { size: 512, seed: 1, preset: 'Colorado alpine' });
    const N = 512, R = 28;
    // the cone is symmetric east-west (aspect only follows north-south), so these patches are twins
    const E = [N / 2 + 120, N / 2], W = [N / 2 - 120, N / 2];
    const L0 = await layers(['bedrock', 'soil', 'veg']);
    const vegE0 = patchMean(L0.veg, N, E[0], E[1], R), vegW0 = patchMean(L0.veg, N, W[0], W[1], R);
    sim.brush('wildfire', { x: E[0], y: E[1], radius: R + 6, spread: false });
    const L1 = await layers(['veg', 'burn']);
    const vegE1 = patchMean(L1.veg, N, E[0], E[1], R);
    // the same storms on both flanks
    for (const P of [E, W]) sim.brush('storm', { x: P[0], y: P[1], radius: R + 20, days: 3 });
    await sim.run(5 * 365, { nSub: 32 });
    const L2 = await layers(['bedrock', 'soil', 'veg']);
    const lowering = (P) => {
      let s = 0, n = 0;
      for (let y = P[1] - R; y <= P[1] + R; y++) for (let x = P[0] - R; x <= P[0] + R; x++) {
        if (Math.hypot(x - P[0], y - P[1]) > R) continue;
        const i = y * N + x;
        s += (L0.bedrock[i] + L0.soil[i]) - (L2.bedrock[i] + L2.soil[i]); n++;
      }
      return s / n;
    };
    const ero = (P) => {   // gross erosion: sum of positive lowering (deposition elsewhere does not cancel)
      let s = 0, n = 0;
      for (let y = P[1] - R; y <= P[1] + R; y++) for (let x = P[0] - R; x <= P[0] + R; x++) {
        if (Math.hypot(x - P[0], y - P[1]) > R) continue;
        const i = y * N + x;
        s += Math.max(0, (L0.bedrock[i] + L0.soil[i]) - (L2.bedrock[i] + L2.soil[i])); n++;
      }
      return s / n;
    };
    const eE = ero(E), eW = ero(W);
    if (want('fire_erosion')) {
      const s = await sim.stats();
      check('fire_erosion', eE > 2 * eW && Math.abs(s.balanceErrorPct) < BAL, `5 yr after fire + identical 3-day storms: burned flank mean erosion ${(eE * 1000).toFixed(2)} mm vs unburned twin ${(eW * 1000).toFixed(2)} mm (x${(eE / Math.max(eW, 1e-9)).toFixed(1)}); net lowering ${(lowering(E) * 1000).toFixed(2)} vs ${(lowering(W) * 1000).toFixed(2)} mm; balance ${r6(s.balanceErrorPct)} %`);
    }
    if (want('fire_recovery')) {
      const v5 = patchMean(L2.veg, N, E[0], E[1], R);
      await sim.run(55 * 365);
      const L3 = await layers(['veg', 'burn']);
      const v60 = patchMean(L3.veg, N, E[0], E[1], R), b60 = patchMean(L3.burn, N, E[0], E[1], R);
      const vW = patchMean(L3.veg, N, W[0], W[1], R);
      check('fire_recovery', vegE1 < 0.3 * vegE0 && v60 > 0.85 * vW && v5 > vegE1, `burned patch cover: before ${vegE0.toFixed(3)} (twin ${vegW0.toFixed(3)}), right after fire ${vegE1.toFixed(3)}, after 5 yr ${v5.toFixed(3)}, after 60 yr ${v60.toFixed(3)} (twin ${vW.toFixed(3)}); burn severity left ${b60.toFixed(3)}`);
    }
  }

  // ---------------------------------------------------------------- 7. climate: desert < Pacific NW; treeline
  if (want('desert_vs_pnw') || want('treeline')) {
    const m = {};
    for (const preset of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
      await fresh('random', { size: 512, seed: 3, preset });
      await sim.run(50 * 365);
      const s = await sim.stats();
      m[preset] = { meanVeg: s.meanVeg, covered: s.vegCoveredFrac };
      if (preset === 'Colorado alpine') {
        const L = await layers(['bedrock', 'soil', 'veg']);
        const bands = {};
        for (let i = 0; i < 512 * 512; i++) {
          const z = L.bedrock[i] + L.soil[i] + e.datum;
          const k = Math.floor(z / 200) * 200;
          (bands[k] ||= { n: 0, v: 0 }); bands[k].n++; bands[k].v += L.veg[i];
        }
        m.bands = Object.fromEntries(Object.entries(bands).filter(([, q]) => q.n > 500).map(([k, q]) => [k, +(q.v / q.n).toFixed(3)]));
      }
    }
    if (want('desert_vs_pnw')) check('desert_vs_pnw', m['Utah desert'].meanVeg < 0.5 * m['Pacific NW wet'].meanVeg, `mean cover after 50 yr (random 512): ${Object.entries(m).filter(([k]) => k !== 'bands').map(([k, v]) => `${k} ${v.meanVeg.toFixed(3)} (${Math.round(100 * v.covered)}% >30% cover)`).join(', ')}`);
    if (want('treeline')) {
      const ks = Object.keys(m.bands).map(Number).sort((a, b) => a - b);
      const low = m.bands[ks[0]], high = m.bands[ks[ks.length - 1]];
      const hiZ = ks.filter((z) => z >= 3700).map((z) => m.bands[z]);
      const ok = hiZ.length > 0 && Math.max(...hiZ) < 0.35 * low && high < 0.1;
      check('treeline', ok, `Colorado cover by 200 m band (m: cover): ${JSON.stringify(m.bands)}`);
    }
  }

  // ---------------------------------------------------------------- 8. drought: groundwater falls, plants brown, then recover
  if (want('drought_response')) {
    await fresh('random', { size: 256, seed: 3, preset: 'Colorado alpine' });
    await sim.run(10 * 365);
    const s0 = await sim.stats();
    const st0 = await e.readLayer('light');
    sim.brush('drought', { days: 5 * 365 });
    await sim.run(5 * 365);
    const s1 = await sim.stats();
    const li = await e.readLayer('light');
    let stress = 0; for (let i = 0; i < 256 * 256; i++) stress += li[8 * i + 6]; stress /= 256 * 256;
    await sim.run(60 * 365);
    const s2 = await sim.stats();
    const ok = s1.meanVeg < 0.85 * s0.meanVeg && s1.totalGroundwater_m3 < 0.8 * s0.totalGroundwater_m3 && s2.meanVeg > 0.9 * s0.meanVeg && stress > 0.05 && Math.abs(s2.balanceErrorPct) < BAL;
    check('drought_response', ok, `mean cover ${s0.meanVeg.toFixed(3)} -> ${s1.meanVeg.toFixed(3)} after 5-yr drought -> ${s2.meanVeg.toFixed(3)} 60 yr later; groundwater ${(s0.totalGroundwater_m3 / 1e6).toFixed(2)} -> ${(s1.totalGroundwater_m3 / 1e6).toFixed(2)} million m3; mean drought stress ${stress.toFixed(3)}; balance ${r6(s2.balanceErrorPct)} %`);
  }

  // ---------------------------------------------------------------- 9. equilibrium is batch-independent (no events)
  if (want('equilibrium_batch_independent')) {
    const v = {};
    for (const bd of [10, 365, 6083]) {
      await fresh('random', { size: 256, seed: 8, preset: 'Colorado alpine' });
      e.setLandscapeChange(false);
      e.climate.tempOffset = +3;     // climate change after the spin-up: plants must move to a new equilibrium
      await sim.run(150 * 365, { batchDays: bd, nSub: 8 });
      v[bd] = (await sim.stats()).meanVeg;
      e.climate.tempOffset = 0;
      e.setLandscapeChange(true);
    }
    const vals = Object.values(v);
    const sp = (Math.max(...vals) - Math.min(...vals)) / vals[0];
    check('equilibrium_batch_independent', sp < 0.08, `Colorado, 3 C warmer after spin-up, terrain frozen, 150 yr: mean cover by batch length ${JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r6(x)])))} (spread ${(100 * sp).toFixed(2)} %)`);
  }

  // ---------------------------------------------------------------- 10. picking: GPU vs float64 reference, steep terrain + exaggeration
  if (want('pick_accuracy') || want('brush_lands_where_clicked')) {
    await fresh('random', { size: 512, seed: 4, preset: 'Colorado alpine', ruggedness: 1 });
    await sim.run(365);              // some snow and erosion: picking must see the current surface
    const R = sim.renderer;
    R.exaggeration = 3;
    R.camera.autoRotate = false;
    R.camera.pitch = 0.32; R.camera.yaw = 1.1; R.camera.dist = R.camera.extent * 0.9;
    await sleep(400);
    let maxErr = 0, hits = 0, misses = 0, agreeMiss = 0;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 40; k++) {
      const nx = rnd() * 1.6 - 0.8 + 0.15, ny = rnd() * 1.4 - 0.75;
      const g = await sim.pickNDC(nx, ny);
      const c = await sim.pickReference(nx, ny);
      if (!g && !c) { agreeMiss++; continue; }
      if (!g || !c) { misses++; continue; }
      hits++;
      maxErr = Math.max(maxErr, Math.hypot(g.x - c.x, g.y - c.y));
    }
    // round trip: project known surface vertices to the screen, pick there, compare
    const L = await layers(['bedrock', 'soil', 'snowSWE']);
    const N = 512, vp = R.lastViewProj, cN = (N - 1) / 2, dx = e.world.cellSize;
    let rt = 0, rtMax = 0, rtVisible = 0, rtBad = 0;
    const eye = R.camera.eye();
    for (let k = 0; k < 40; k++) {
      const gx = 40 + Math.floor(rnd() * 430), gy = 40 + Math.floor(rnd() * 430), i = gy * N + gx;
      const H = (L.bedrock[i] + L.soil[i] + L.snowSWE[i] / 0.33) * R.vex;
      const X = (gx - cN) * dx, Z = (gy - cN) * dx;
      const cx = vp[0] * X + vp[4] * H + vp[8] * Z + vp[12], cy = vp[1] * X + vp[5] * H + vp[9] * Z + vp[13], cw = vp[3] * X + vp[7] * H + vp[11] * Z + vp[15];
      const nx = cx / cw, ny = cy / cw;
      if (Math.abs(nx) > 0.98 || Math.abs(ny) > 0.98) continue;
      const g = await sim.pickNDC(nx, ny);
      if (!g) continue;
      rt++;
      const d = Math.hypot(g.x - gx, g.y - gy);
      if (d < 0.05) { rtVisible++; rtMax = Math.max(rtMax, d); continue; }
      // otherwise the vertex must be hidden: the hit has to be NEARER the camera than the vertex
      const hx = (g.x - cN) * dx, hz = (g.y - cN) * dx, hy = g.height * R.vex;
      const dHit = Math.hypot(hx - eye[0], hy - eye[1], hz - eye[2]), dV = Math.hypot(X - eye[0], H - eye[1], Z - eye[2]);
      if (!(dHit < dV)) rtBad++;
    }
    if (want('pick_accuracy')) check('pick_accuracy', hits >= 20 && misses === 0 && maxErr < 0.02 && rtVisible >= 4 && rtMax < 0.05 && rtBad === 0,
      `vex 3, pitch 18 deg, rugged terrain: ${hits} hits, max GPU-vs-float64 difference ${maxErr.toFixed(4)} cells, ${misses} disagreements, ${agreeMiss} sky; vertex round trip: ${rtVisible}/${rt} land back on their own vertex (max error ${rtMax.toFixed(4)} cells), the other ${rt - rtVisible} are hidden behind ridges and hit terrain nearer the camera (${rtBad} wrong)`);
    if (want('brush_lands_where_clicked')) {
      // simulate a real click with the Storm tool on the canvas at the screen position of a grid point
      const canvas = R.canvas, rect = canvas.getBoundingClientRect();
      let found = null;
      for (let k = 0; k < 30 && !found; k++) {
        const gx = 150 + Math.floor(rnd() * 250), gy = 150 + Math.floor(rnd() * 250), i = gy * N + gx;
        const H = (L.bedrock[i] + L.soil[i] + L.snowSWE[i] / 0.33) * R.vex;
        const X = (gx - cN) * dx, Z = (gy - cN) * dx;
        const cx = vp[0] * X + vp[4] * H + vp[8] * Z + vp[12], cy = vp[1] * X + vp[5] * H + vp[9] * Z + vp[13], cw = vp[3] * X + vp[7] * H + vp[11] * Z + vp[15];
        const px = rect.left + (cx / cw + 1) / 2 * rect.width, py = rect.top + (1 - cy / cw) / 2 * rect.height;
        const g = await sim.pick(px, py);
        if (g && Math.hypot(g.x - gx, g.y - gy) < 0.5 && px > rect.left + 360) found = { gx, gy, px, py };
      }
      let ok = false, detail = 'no visible test point';
      if (found) {
        sim.setTool('storm');
        const n0 = e.events.list.length;
        const opt = { clientX: found.px, clientY: found.py, button: 0, buttons: 1, pointerId: 1, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opt));
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...opt, buttons: 0 }));
        for (let k = 0; k < 50 && e.events.list.length === n0; k++) await sleep(20);
        const ev = e.events.list[e.events.list.length - 1];
        sim.setTool('off');
        if (ev) {
          const d = Math.hypot(ev.x - found.gx, ev.y - found.gy);
          ok = d < 0.25 && e.events.list.length === n0 + 1;
          detail = `clicked the screen pixel of cell (${found.gx}, ${found.gy}) with the Storm tool: storm placed at (${ev.x.toFixed(2)}, ${ev.y.toFixed(2)}), ${d.toFixed(3)} cells away`;
        } else detail = 'click did not create a storm';
      }
      check('brush_lands_where_clicked', ok, detail);
    }
    R.exaggeration = 1.25;
  }

  // ---------------------------------------------------------------- 11. robustness: size switches / new terrain mid-event, load during run()
  if (want('robust_switching')) {
    const g0 = errors0();
    await fresh('random', { size: 512, seed: 2, preset: 'Colorado alpine' });
    const brushAll = (N) => {
      sim.brush('storm', { x: N / 2, y: N / 2, radius: N / 8 });
      sim.brush('flood', { x: N / 3, y: N / 2, radius: 4 });
      sim.brush('drought', {});
      sim.brush('wildfire', { x: N / 4, y: N / 4, radius: N / 10 });
    };
    brushAll(512);
    sim.setSpeed(365000); sim.play();
    await sleep(800);
    await sim.load('random', { size: 256, seed: 3 });          // while playing, mid-event
    sim.play(); brushAll(256);
    await sleep(800);
    await sim.load('cone', { size: 1024, seed: 1 });
    sim.play(); brushAll(1024);
    sim.setSpeed(1);
    await sleep(800);
    await sim.load('valley', { size: 512, seed: 1 });          // same size: buffers reused
    sim.play(); brushAll(512);
    await sleep(600);
    // load while a sim.run() is in flight
    sim.pause();
    const pr = sim.run(365 * 2000);
    await sleep(300);
    await sim.load('random', { size: 256, seed: 9 });
    await pr.catch(() => {});
    sim.brush('storm', { x: 128, y: 128, radius: 20 });
    await sim.run(400);
    const s = await sim.stats();
    const g1 = errors0();
    const ok = g1.gpu === g0.gpu && g1.console === g0.console && !s.hasNaN && Math.abs(s.balanceErrorPct) < BAL;
    check('robust_switching', ok, `512->256->1024->512 loads while playing with storm+flood+drought+fire running, plus load during sim.run(): GPU errors ${g1.gpu - g0.gpu}, console errors ${g1.console - g0.console}${g1.console > g0.console ? ' ' + JSON.stringify(window.__errors.slice(g0.console)) : ''}, NaN ${s.hasNaN}, balance after ${r6(s.balanceErrorPct)} %`);
  }

  // ---------------------------------------------------------------- 12. 1024^2 at 1000 yr/s with plants on: frame rate
  if (want('fps_1024')) {
    await sim.load('random', { size: 1024, seed: 4, preset: 'Colorado alpine' });
    sim.setSpeed(365000); sim.play();
    await sleep(2500);
    const f = [], subs = [];
    for (let k = 0; k < 16; k++) { await sleep(500); f.push(e.fps); subs.push(e.nSub); }
    sim.pause();
    const s = await sim.stats();
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    const gt = sim.gpuTimes;
    check('fps_1024', avg >= 55 && !s.hasNaN, `1024x1024 random at 1000 yr/s, plants on: ${avg.toFixed(1)} fps (min ${Math.min(...f).toFixed(1)}), hydraulic sub-steps/frame ${Math.round(subs.reduce((a, b) => a + b) / subs.length)}, GPU sim ${gt.simMs.toFixed(2)} ms + render ${gt.renderMs.toFixed(2)} ms, ${r6(s.year)} years simulated, NaN ${s.hasNaN}`);
  }
} catch (err) {
  report.push(`FAIL exception: ${String(err && err.stack || err)}`);
}

const nFail = report.filter((l) => l.startsWith('FAIL')).length;
report.push(`${nFail ? 'FAIL' : 'PASS'} SUMMARY: ${report.length - nFail}/${report.length} checks passed in ${((performance.now() - T0) / 1000).toFixed(0)} s on ${sim.adapterInfo?.vendor} ${sim.adapterInfo?.architecture}`);
return { report, results, gpuErrors: window.__gpuErrors || 0, consoleErrors: window.__errors || [] };
