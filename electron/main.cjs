// Electron shell: serves the built page (dist/) over a privileged app:// protocol (secure context,
// proper MIME types for ES modules), forces the discrete GPU and enables WebGPU.
//
//   electron .               normal desktop app (loads dist/)
//   electron . --dev         loads the Vite dev server at http://localhost:5173
//   electron . --selftest    runs the cone 1000-year audit + benchmark on the real GPU, writes
//                            selftest-results.json next to package.json and quits
const { app, BrowserWindow, protocol, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// GPU switches must be set before the app is ready.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('force_high_performance_gpu');      // pick the NVIDIA/AMD dGPU on hybrid laptops
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(1);
const DEV = args.includes('--dev');
const SELFTEST = args.includes('--selftest');
const SCRIPTED = SELFTEST || args.some((a) => a.startsWith('--eval='));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// One window at a time. A second launch hands focus to the first and stops here; a scripted run
// (--selftest / --eval) says why and exits with an error so no stale results are mistaken for new ones.
const GOT_LOCK = app.requestSingleInstanceLock();
if (!GOT_LOCK) {
  if (SCRIPTED) console.error('Landscape Time-Lapse is already open: close it first, then run the test again.');
  app.exit(SCRIPTED ? 4 : 0);
}

let win = null;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: '#12161b', title: 'Landscape Time-Lapse', show: true,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.removeMenu();
  const query = SCRIPTED ? '?scenario=cone&size=512&seed=1&preset=Colorado%20alpine&paused=1' : '';
  if (DEV) win.loadURL('http://localhost:5173/' + query);
  else win.loadURL('app://local/index.html' + query);

  win.webContents.on('render-process-gone', (_e, d) => {
    dialog.showErrorBox('Landscape Time-Lapse', `The display process stopped (${d.reason}). Please restart the app.`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
  });
  const evalArg = args.find((a) => a.startsWith('--eval='));
  const outArg = args.find((a) => a.startsWith('--out='));
  if (SELFTEST) runScript(SELFTEST_BODY, path.join(ROOT, 'selftest-results.json'));
  else if (evalArg) {
    const out = outArg ? outArg.slice(6) : path.join(ROOT, 'eval-result.json');
    let body;
    try { body = fs.readFileSync(evalArg.slice(7), 'utf8'); } catch (e) {
      fs.writeFileSync(out, JSON.stringify({ error: `could not read ${evalArg.slice(7)}: ${e.message}` }, null, 2));
      console.error(`could not read ${evalArg.slice(7)}`);
      app.exit(5);
      return;
    }
    runScript(body, out);
  }
}

// Built-in self test: cone 1000-year audit + benchmark. Body of an async function run in the page.
const SELFTEST_BODY = `
  const info = window.sim.adapterInfo;
  const t0 = performance.now();
  await window.sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' });
  window.sim.pause();
  await window.sim.run(365000);
  const cone = await window.sim.stats();
  cone.wallSeconds = (performance.now() - t0) / 1000;
  const bench = await window.sim.bench();
  return { adapter: { vendor: info.vendor, architecture: info.architecture }, cone1000y: cone, bench };
`;

// --eval=<file.js> --out=<file.json>: run an async function body in the page (test harness on the
// real GPU), write the JSON result and quit. --selftest uses SELFTEST_BODY.
function runScript(body, out) {
  const js = `new Promise((resolve) => {
    const go = async () => {
      try {
        if (window.__fatal) return resolve({ error: window.__fatal });
        const f = new (Object.getPrototypeOf(async function () {}).constructor)(${JSON.stringify(body)});
        resolve(await f());
      } catch (e) { resolve({ error: String(e && e.stack || e) }); }
    };
    if (window.sim) go(); else { window.addEventListener('sim-ready', go); setTimeout(() => { if (!window.sim) resolve({ error: window.__fatal || 'sim did not start' }); }, 30000); }
  })`;
  win.webContents.once('did-finish-load', async () => {
    let res;
    try { res = await win.webContents.executeJavaScript(js, true); } catch (e) { res = { error: String(e) }; }
    if (res && typeof res === 'object') {
      res.gpuFeatureStatusWebGPU = app.getGPUFeatureStatus().webgpu;
      res.electron = process.versions.electron; res.chrome = process.versions.chrome;
    }
    fs.writeFileSync(out, JSON.stringify(res, null, 2));
    const shot = args.find((a) => a.startsWith('--shot='));
    if (shot) {
      // capture what is on screen now; the script can leave the view set up (overlay, camera)
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(shot.slice(7), img.toPNG());
    }
    console.log('result written to', out);
    app.quit();
  });
}

if (GOT_LOCK) app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname);
      if (!p || p === '/') p = '/index.html';
      const file = path.normalize(path.join(DIST, p));
      if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('forbidden', { status: 403 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  if (!DEV && !fs.existsSync(path.join(DIST, 'index.html'))) {
    dialog.showErrorBox('Landscape Time-Lapse', 'The app has not been built yet. Please run start.bat (it builds automatically).');
    app.quit();
    return;
  }
  const gpu = app.getGPUFeatureStatus();
  if (gpu && gpu.webgpu && /disabled|unavailable/i.test(gpu.webgpu) && !SCRIPTED) {
    dialog.showMessageBox({
      type: 'warning', title: 'Landscape Time-Lapse',
      message: 'WebGPU looks unavailable on this computer.',
      detail: 'The simulator needs WebGPU (GPU compute). Updating your graphics driver usually fixes this. The app will try anyway.',
    });
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
