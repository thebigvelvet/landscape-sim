// Takes the round-2 screenshots: node tests/r2-shots.cjs [name...]
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const SHOTS = {
  'plants-utah': { preset: 'Utah desert', cam: { yaw: 0.9, pitch: 0.42, dist: 1.25 } },
  'plants-colorado': { preset: 'Colorado alpine', cam: { yaw: 0.9, pitch: 0.42, dist: 1.25 } },
  'plants-pnw': { preset: 'Pacific NW wet', cam: { yaw: 0.9, pitch: 0.42, dist: 1.25 } },
  'plants-overlay-colorado': { preset: 'Colorado alpine', overlay: 'plants', cam: { yaw: 0.9, pitch: 0.6, dist: 1.4 } },
  'fire-scar': { preset: 'Colorado alpine', doy: 180, fire: [0.42, 0.62, 45], afterFireDays: 410, cam: { yaw: 0.25, pitch: 0.6, dist: 0.75, target: [-0.08, 600, 0.12] } },
  'fire-scar-overlay': { preset: 'Colorado alpine', doy: 180, fire: [0.42, 0.62, 45], afterFireDays: 410, overlay: 'plants', cam: { yaw: 0.25, pitch: 0.6, dist: 0.75, target: [-0.08, 600, 0.12] } },
  'fire-scar-fresh': { preset: 'Colorado alpine', doy: 180, fire: [0.42, 0.62, 45], afterFireDays: 30, cam: { yaw: 0.25, pitch: 0.6, dist: 0.75, target: [-0.08, 600, 0.12] } },
  'storm-brush': { preset: 'Temperate', storm: [0.55, 0.5, 40], stormDays: 1.5, play: 1, cam: { yaw: 0.6, pitch: 0.5, dist: 0.9 } },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
for (const n of names) {
  const tmp = path.join(__dirname, `tmp-shot-${n}.js`);
  fs.writeFileSync(tmp, `window.__cfg = ${JSON.stringify(SHOTS[n])};\n` + fs.readFileSync(path.join(__dirname, 'r2-shot.js'), 'utf8'));
  spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'launch.cjs'), `--eval=${tmp}`, `--out=${path.join(__dirname, `out-shot-${n}.json`)}`, `--shot=${path.join(__dirname, `shot-${n}.png`)}`], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
}
