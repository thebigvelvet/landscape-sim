// One-stop launcher used by start.bat and `npm run app`:
//   1. makes sure the Electron binary is downloaded (npm 11 may skip install scripts),
//   2. rebuilds dist/ if any source file is newer than the last build,
//   3. starts Electron detached and exits.
// Extra arguments are passed to Electron (e.g. --selftest, --dev).
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const extra = process.argv.slice(2);
const wait = extra.some((a) => a === '--selftest' || a === '--wait' || a.startsWith('--eval='));

function newestMtime(p) {
  let t = 0;
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) t = Math.max(t, newestMtime(path.join(p, f)));
  else t = st.mtimeMs;
  return t;
}

function electronExe() {
  const dir = path.join(ROOT, 'node_modules', 'electron');
  const pathTxt = path.join(dir, 'path.txt');
  const exeOk = () => fs.existsSync(pathTxt) && fs.existsSync(path.join(dir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim()));
  if (!exeOk()) {
    console.log('Downloading the Electron runtime (one time, about 100 MB)...');
    const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit', cwd: dir });
    if (r.status !== 0 || !exeOk()) {
      console.error('\nCould not download Electron. Check your internet connection and run start.bat again.');
      process.exit(2);
    }
  }
  return path.join(dir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim());
}

function buildIfNeeded() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  const srcT = Math.max(newestMtime(path.join(ROOT, 'src')), newestMtime(path.join(ROOT, 'index.html')), newestMtime(path.join(ROOT, 'vite.config.js')));
  if (fs.existsSync(distIndex) && fs.statSync(distIndex).mtimeMs >= srcT) return;
  console.log('Building the simulator...');
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    if (fs.existsSync(distIndex) && !wait) console.warn('Build failed; starting the previous build.');
    else { console.error('Build failed.'); process.exit(3); }
  }
}

buildIfNeeded();
const exe = electronExe();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (wait) {
  const r = spawnSync(exe, [ROOT, ...extra], { stdio: 'inherit', env });
  // no status means Electron was killed by a signal (crash): that is a failure, not a pass
  if (r.status === null) console.error(`Electron stopped unexpectedly (${r.signal || r.error?.message || 'unknown'}).`);
  process.exit(r.status ?? 1);
} else {
  const child = spawn(exe, [ROOT, ...extra], { detached: true, stdio: 'ignore', env });
  child.unref();
  console.log('Landscape Time-Lapse started.');
}
