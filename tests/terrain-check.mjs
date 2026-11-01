// node tests/terrain-check.mjs : terrain generator sanity (finite values, ranges, timing)
import { generateTerrain, SCENARIOS } from '../src/terrain.js';
for (const scen of SCENARIOS) for (const N of [256, 512, 1024]) for (const seed of [1, 2, 4]) {
  const t0 = performance.now();
  const { height, soil } = generateTerrain(scen, { N, seed });
  const ms = performance.now() - t0;
  let bad = 0, first = -1, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N * N; i++) {
    if (!Number.isFinite(height[i]) || !Number.isFinite(soil[i])) { bad++; if (first < 0) first = i; continue; }
    mn = Math.min(mn, height[i]); mx = Math.max(mx, height[i]);
  }
  console.log(`${scen} N=${N} seed=${seed} bad=${bad}${first >= 0 ? ` first=(${first % N},${(first / N) | 0})` : ''} range=${mn.toFixed(0)}..${mx.toFixed(0)} ${ms.toFixed(0)}ms`);
}
