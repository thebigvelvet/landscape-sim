// Neutral review harness: serves a build's dist/ over http://127.0.0.1, runs fixed scenarios, saves stats + screenshots.
const { app, BrowserWindow } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan,WebGPU');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const arg = (k) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const DIST = arg('dist'), OUT = arg('out'), NAME = arg('name');
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wgsl': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

const log = (...a) => { const s = `[${NAME}] ` + a.join(' '); console.log(s); fs.appendFileSync(path.join(OUT, 'log.txt'), s + '\n'); };
const results = {};
async function js(win, code, ms = 900000) {
  return Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}
async function shot(win, file) { await new Promise(r => setTimeout(r, 1500)); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, file), img.toPNG()); }

async function scenario(win, key, loadArgs, days, shotName, ovName = 'change') {
  try {
    await js(win, `window.sim.pause && window.sim.pause(); true`);
    const t0 = Date.now();
    await js(win, `window.sim.load(${JSON.stringify(loadArgs[0])}, ${JSON.stringify(loadArgs[1])}).then(()=>true)`);
    const s0 = await js(win, `window.sim.stats()`);
    const t1 = Date.now();
    if (days) await js(win, `window.sim.run(${days}).then(()=>true)`);
    const s1 = await js(win, `window.sim.stats()`);
    const wall = (Date.now() - t1) / 1000;
    const bal = s1.cumPrecip_m3 - (s1.totalWater_m3 + s1.totalSnowSWE_m3 - (s0.totalWater_m3 + s0.totalSnowSWE_m3)) - s1.cumOutflow_m3 - s1.cumEvapLoss_m3;
    results[key] = { loadSec: (t1 - t0) / 1000, runWallSec: wall, before: s0, after: s1, naiveBalanceErr_m3: bal, naiveBalanceRel: bal / Math.max(1, s1.cumPrecip_m3) };
    log(key, 'ok', `run ${wall.toFixed(1)}s`, `NaN=${s1.hasNaN}`, `relErr=${(bal / Math.max(1, s1.cumPrecip_m3)).toExponential(2)}`, `h ${s0.minHeight?.toFixed(1)}-${s0.maxHeight?.toFixed(1)} -> ${s1.minHeight?.toFixed(1)}-${s1.maxHeight?.toFixed(1)}`);
    if (shotName) {
      await js(win, `window.sim.pause && window.sim.pause(); true`);
      await shot(win, shotName + '.png');
      const ov = await js(win, `typeof window.sim.setOverlay === 'function'`);
      await js(win, ov ? `window.sim.setOverlay(${JSON.stringify(ovName)}); true` : `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='change')?.click(); true`, 5000).catch(()=>{});
      await shot(win, shotName + '-overlay.png');
    }
  } catch (e) { results[key] = { error: String(e) }; log(key, 'ERROR', e); }
}

async function fpsTest(win) {
  try {
    await js(win, `window.sim.load('random', {size:1024, seed:7, preset:'Colorado alpine'}).then(()=>true)`);
    await js(win, `window.sim.setSpeed(365000); window.sim.play(); true`);
    await new Promise(r => setTimeout(r, 3000));
    const r = await js(win, `new Promise(res=>{let n=0;const t0=performance.now();(function f(){n++; if(performance.now()-t0<5000) requestAnimationFrame(f); else res(n/((performance.now()-t0)/1000));})()}).then(async fps=>({rafFps:fps, stats: await window.sim.stats()}))`, 60000);
    await js(win, `window.sim.pause(); true`);
    results.fps1024 = { rafFps: r.rafFps, simFps: r.stats.fps, year: r.stats.year, hasNaN: r.stats.hasNaN };
    log('fps1024', r.rafFps.toFixed(1), 'sim-reported', r.stats.fps, 'year', r.stats.year, 'NaN', r.stats.hasNaN);
    await shot(win, 'fps1024-random.png');
  } catch (e) { results.fps1024 = { error: String(e) }; log('fps1024 ERROR', e); }
}

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = new BrowserWindow({ width: 1600, height: 1000, show: true, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) fs.appendFileSync(path.join(OUT, 'console.txt'), msg + '\n'); });
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  for (let i = 0; i < 120; i++) { if (await js(win, `!!(window.sim && window.sim.load)`).catch(() => false)) break; await new Promise(r => setTimeout(r, 500)); }
  results.adapter = await js(win, `navigator.gpu.requestAdapter({powerPreference:'high-performance'}).then(a=>a && a.info ? (a.info.vendor+' '+a.info.architecture+' '+a.info.description) : 'n/a')`).catch(e => String(e));
  log('adapter', results.adapter);
  if (arg('eval')) { const code = fs.readFileSync(arg('eval'), 'utf8'); try { const r = await js(win, code); fs.writeFileSync(path.join(OUT, 'eval.json'), JSON.stringify(r, null, 2)); log('eval', JSON.stringify(r)); } catch (e) { log('eval ERROR', e); } if (arg('shot')) await shot(win, arg('shot')); app.exit(0); return; }
  if (process.argv.includes('--overlayOnly')) { await scenario(win, 'random10k', ['random', { size: 512, seed: 7, preset: 'Temperate' }], 3650000, 'temperate-10000yr'); fs.writeFileSync(path.join(OUT, 'results-overlay.json'), JSON.stringify(results, null, 2)); app.exit(0); return; }
  await scenario(win, 'cone1000', ['cone', { size: 512, seed: 1, preset: 'Colorado alpine' }], 365000, 'cone-1000yr');
  await scenario(win, 'valleyJune', ['valley', { size: 512, seed: 1, preset: 'Colorado alpine' }], 175, 'valley-alpine-late-june');
  await scenario(win, 'random10k', ['random', { size: 512, seed: 7, preset: 'Colorado alpine' }], 3650000, 'random-10000yr');
  await scenario(win, 'desert2k', ['random', { size: 512, seed: 3, preset: 'Utah desert' }], 730000, 'utah-desert-2000yr');
  await scenario(win, 'gw200', ['random', { size: 512, seed: 7, preset: 'Temperate' }], 73000, 'temperate-200yr-gw', 'groundwater');
  await fpsTest(win);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log('done');
  app.exit(0);
});
