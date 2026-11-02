// Runs a round-2 ecology test on the real GPU: node tests/run-eco.cjs <test.js> [--shot=file.png]
// Prepends tests/eco-lib.js (shared analysis helpers) and writes tests/out-<name>.json.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = process.argv[2];
const extra = process.argv.slice(3);
const name = path.basename(test, '.js');
const tmp = path.join(require('os').tmpdir(), `eco-${name}-${process.pid}.js`);
fs.writeFileSync(tmp, fs.readFileSync(path.join(__dirname, 'eco-lib.js'), 'utf8') + '\n' + fs.readFileSync(test, 'utf8'));
const out = path.join(__dirname, `out-${name}.json`);
const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'launch.cjs'), `--eval=${tmp}`, `--out=${out}`, ...extra], { stdio: 'inherit' });
fs.unlinkSync(tmp);
process.exit(r.status ?? 0);
