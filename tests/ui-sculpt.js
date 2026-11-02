// Drives the sculpt tools the way a person does: key to pick the tool, real pointer events on the
// canvas (press, drag, hold, release), then the Undo button. Run with --shot to see the panel.
const e = sim.engine, b = sim.brushTool, cv = sim.renderer.canvas;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = []; const ok = (n, c, i) => log.push(`${c ? 'PASS' : 'FAIL'} ${n}${i !== undefined ? ' - ' + i : ''}`);
const err0 = window.__gpuErrors || 0;
sim.pause(); await sim.load('random', { size: 512, seed: 3, preset: 'Colorado alpine' }); sim.pause();
await sleep(500);
const N = e.N, ground = async () => { const g = await e.readLayer('bedrock'), s = await e.readLayer('soil'); for (let i = 0; i < g.length; i++) g[i] += s[i]; return g; };
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
ok('Q selects Raise', b.tool === 'raise');
await b.refreshHeights(true);
const g0 = await ground();
const p0 = sim.screenOf(N * 0.5, N * 0.5), p1 = sim.screenOf(N * 0.56, N * 0.5);
const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
ev('pointerdown', p0);
for (let k = 1; k <= 20; k++) { ev('pointermove', { x: p0.x + (p1.x - p0.x) * k / 20, y: p0.y + (p1.y - p0.y) * k / 20 }); await sleep(30); }
await sleep(400);   // hold still: keeps pushing
ev('pointerup', p1);
await sleep(600);
const g1 = await ground();
// the brush lands wherever the pointer's ray meets the ground, which moves as the hill grows, so
// look for the highest rise anywhere
let i0 = 0; for (let i = 0; i < N * N; i++) if (g1[i] - g0[i] > g1[i0] - g0[i0]) i0 = i;
ok('dragging and holding raised the ground', g1[i0] - g0[i0] > 5, `${(g1[i0] - g0[i0]).toFixed(1)} m at (${i0 % N}, ${Math.floor(i0 / N)})`);
ok('Undo button enabled', !document.getElementById('undo').disabled);
document.getElementById('sculpt').scrollIntoView();
await sleep(300);
document.getElementById('undo').click();
await sleep(1500);
const g2 = await ground();
ok('Undo button put the ground back', Math.abs(g2[i0] - g0[i0]) < 0.01, (g2[i0] - g0[i0]).toExponential(1) + ' m');
ok('Undo button disabled again', document.getElementById('undo').disabled);
window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
ok('T selects Channel, help text shown', b.tool === 'channel' && /riverbed/.test(document.getElementById('sculpt-help').textContent));
// leave a stroke on screen for the picture
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
ev('pointerdown', p0); await sleep(700); ev('pointerup', p0); await sleep(800);
sim.renderer.setCursor(true, N * 0.5, N * 0.5, b.radius, 5);
ok('no GPU errors', (window.__gpuErrors || 0) === err0, (window.__gpuErrors || 0) - err0);
await sleep(1000);
return log;
