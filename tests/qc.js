// QC-review regression checks (one per fixed bug that can be probed from the page).
//   node scripts/launch.cjs --eval=tests/qc.js --out=tests/out-qc.json
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e = sim.engine, R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const $ = (id) => document.getElementById(id);
const read = (n) => e.readLayer(n);
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// 1. Quick repeated undo: five overlapping strokes, five undos fired at once (no awaiting in between)
sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
const N = e.N, c = N / 2;
const b0 = await read('bedrock'), s0 = await read('soil'), h0 = await read('initHeight');
for (let k = 0; k < 5; k++) await sim.sculptStroke(k % 2 ? 'lower' : 'raise', [{ x: c + 3 * k, y: c }, { x: c + 3 * k + 6, y: c + 2 }], { dabs: 6, radius: 12 });
const mid = await read('initHeight');
await Promise.all([0, 1, 2, 3, 4].map(() => sim.undo()));
await e.device.queue.onSubmittedWorkDone();
const h1 = await read('initHeight'), b1 = await read('bedrock');
check('rapidUndoRestoresGround', maxDiff(h0, h1) < 1e-3 && maxDiff(b0, b1) < 1e-3,
  { changedBy: maxDiff(h0, mid), leftAfterUndo: maxDiff(h0, h1), bedrockLeft: maxDiff(b0, b1) });

// 2. Undoing a channel gives the stripped soil back as soil (not as rock)
await sim.sculptStroke('channel', [{ x: c - 30, y: c - 20 }, { x: c - 10, y: c - 20 }, { x: c + 10, y: c - 18 }], { radius: 14, intensity: 2 });
const s2 = await read('soil');
await sim.undo(); await e.device.queue.onSubmittedWorkDone();
const s3 = await read('soil'), b3 = await read('bedrock'), h3 = await read('initHeight');
check('channelUndoReturnsSoil', maxDiff(s2, s0) > 0.05 && maxDiff(s3, s0) < 1e-3 && maxDiff(b3, b0) < 1e-3 && maxDiff(h3, h0) < 1e-3,
  { soilCut: maxDiff(s2, s0), soilLeft: maxDiff(s3, s0), bedrockLeft: maxDiff(b3, b0) });
check('undoStackEmpty', !e.canUndo, {});

// 3. A load while the clock runs at top speed starts with clean water books
sim.setSpeed(365000); sim.play();
await sleep(500);
const dayBefore = e.day;
await sim.load('random', { size: 512, seed: 8, preset: 'Colorado alpine' });
sim.play();   // a new landscape now starts frozen (round 12 timelapse)
const st0 = await sim.stats();
await sleep(2500);
const st1 = await sim.stats();
check('loadAtTopSpeedBalances', Math.abs(st0.balanceErrorPct) < 0.01 && Math.abs(st1.balanceErrorPct) < 0.01 && st1.day > 0,
  { dayBefore, startDay: st0.day, startErrPct: st0.balanceErrorPct, after2s: st1.balanceErrorPct, yearsAfter2s: st1.year });
sim.pause();

// 4. "Make this landscape" keeps a custom wind
sim.setWind({ from: 123, speed: 1.6, steady: 0.2 });
$('size').value = '256'; $('generate').click();
await sleep(300); for (let k = 0; k < 300 && !$('loading').classList.contains('fade'); k++) await sleep(100);
const w = sim.wind;
check('regenerateKeepsWind', w.from === 123 && Math.abs(w.speed - 1.6) < 1e-9 && Math.abs(w.steady - 0.2) < 1e-9, { wind: w });

// 5. A Vulcanian vent gets its hard plug even where ash lands in the throat first
sim.pause(); await sim.load('flat', { size: 256, seed: 2, preset: 'Utah desert', volcanoes: false }); sim.pause();
const ev = sim.brush('volcano', { x: 128, y: 128, style: 'vulcanian', intensity: 2 });
await e.volcanoes.vents.at(-1).ready;
await e.run(ev.days + 30, { batchDays: 5 });
const vr = await read('volcRock');
let plug = 0, cells = 0;
for (let y = 126; y <= 130; y++) for (let x = 126; x <= 130; x++) {
  const i = y * 256 + x; cells++;
  for (let k = 0; k < 4; k++) if (Math.abs(vr[8 * i + 4 + k] - 3) < 0.5) { plug++; break; }
}
check('vulcanianHasPlug', plug >= 0.5 * cells, { plugCells: plug, of: cells });

// 6. Eruption bookkeeping no longer sums the whole map every batch
sim.pause(); await sim.load('random', { size: 1024, seed: 3, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
sim.brush('volcano', { x: 512, y: 512, style: 'plinian' });
const vent = e.volcanoes.vents.at(-1);
await vent.ready;
let t = performance.now(); e.volcanoes._landVolume(vent, 0, 0, 0.1, 0.2); const first = performance.now() - t;
t = performance.now(); for (let k = 0; k < 20; k++) e.volcanoes._landVolume(vent, 0, 0, 0.2 + k * 0.01, 0.21 + k * 0.01); const per = (performance.now() - t) / 20;
check('eruptionBooksCheap', per < 1, { firstMs: first, perBatchMs: per });

// 7. Still balanced, no NaN, no GPU errors
await e.run(200, { batchDays: 5 });
const st = await sim.stats();
check('booksAfterEruption', !st.hasNaN && Math.abs(st.balanceErrorPct) < 0.01 && Math.abs(st.solidsError_m3) < 1e-3 * Math.max(1, st.cumErupted_m3),
  { balPct: st.balanceErrorPct, solidsErr: st.solidsError_m3, erupted: st.cumErupted_m3 });
R.gpuErrors = window.__gpuErrors || 0;
check('noGpuErrors', R.gpuErrors === 0, { msgs: window.__gpuErrorMsgs });
R.passed = Object.values(R.checks).filter((q) => q.pass).length + '/' + Object.keys(R.checks).length;
try { localStorage.clear(); } catch {}
return R;
