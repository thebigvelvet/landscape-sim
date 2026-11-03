// Terrain generation on the CPU (one-off, at load): scenarios + fractal/ridged noise + a quick
// droplet "pre-erosion" pass so random terrain starts out looking like it has a drainage history.
// Heights are metres above the scenario datum (the climate preset's base elevation is added on
// the GPU for lapse-rate purposes), which keeps f32 precision high for small erosion increments.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D gradient (Perlin) noise with a seeded permutation
function makeNoise(seed) {
  const rnd = mulberry32(seed * 9973 + 17);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256), gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = rnd() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const h00 = perm[perm[X] + Y], h10 = perm[perm[X + 1] + Y], h01 = perm[perm[X] + Y + 1], h11 = perm[perm[X + 1] + Y + 1];
    const d00 = gx[h00] * xf + gy[h00] * yf;
    const d10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const d01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const d11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const u = fade(xf), v = fade(yf);
    const a = d00 + u * (d10 - d00), b = d01 + u * (d11 - d01);
    return (a + v * (b - a)) * 1.4142;   // ~[-1, 1]
  };
}

function fbm(noise, x, y, oct, gain = 0.5, lac = 2.0) {
  let s = 0, a = 1, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * noise(x * f + o * 17.3, y * f - o * 9.1); n += a; a *= gain; f *= lac; }
  return s / n;
}
function ridged(noise, x, y, oct, gain = 0.5) {
  let s = 0, a = 1, f = 1, n = 0, w = 1;
  for (let o = 0; o < oct; o++) {
    let r = 1 - Math.abs(noise(x * f + 31.7 * o, y * f + 11.3 * o));
    r = r * r * w; w = Math.min(1, r * 2);
    s += a * r; n += a; a *= gain; f *= 2.03;
  }
  return s / n;
}

// Classic particle (droplet) erosion on a normalised height field: carves dendritic gullies and
// fills hollows. Cheap: ~N^2 * 0.25 droplets of <= 48 steps.
function dropletErode(h, N, seed, amount = 1) {
  const rnd = mulberry32(seed * 7919 + 3);
  const drops = Math.floor(N * N * 0.22 * amount);
  const inertia = 0.05, capF = 4, minCap = 0.01, dep = 0.3, ero = 0.3, evap = 0.02, grav = 4, maxSteps = 48;
  const R = Math.max(1, Math.round(N / 256)); // erosion brush radius scales with resolution
  const brush = []; let wsum = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.sqrt(dx * dx + dy * dy); if (d <= R) { const w = R + 1 - d; brush.push([dx, dy, w]); wsum += w; }
  }
  for (const b of brush) b[2] /= wsum;
  const grad = (x, y) => {
    const xi = x | 0, yi = y | 0, u = x - xi, v = y - yi, i = yi * N + xi;
    const a = h[i], b = h[i + 1], c = h[i + N], d = h[i + N + 1];
    return [(b - a) * (1 - v) + (d - c) * v, (c - a) * (1 - u) + (d - b) * u, a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v];
  };
  for (let n = 0; n < drops; n++) {
    let x = rnd() * (N - 3) + 1, y = rnd() * (N - 3) + 1, dx = 0, dy = 0, sp = 1, w = 1, sed = 0;
    for (let s = 0; s < maxSteps; s++) {
      const xi = x | 0, yi = y | 0, u = x - xi, v = y - yi, i = yi * N + xi;
      const [gX, gY, hh] = grad(x, y);
      dx = dx * inertia - gX * (1 - inertia); dy = dy * inertia - gY * (1 - inertia);
      const len = Math.hypot(dx, dy); if (len < 1e-9) break;
      dx /= len; dy /= len; x += dx; y += dy;
      if (x < 1 || y < 1 || x >= N - 2 || y >= N - 2) break;
      const nh = grad(x, y)[2], dh = nh - hh;
      const cap = Math.max(-dh * sp * w * capF, minCap * 0.001);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * dep;
        sed -= amt;
        h[i] += amt * (1 - u) * (1 - v); h[i + 1] += amt * u * (1 - v); h[i + N] += amt * (1 - u) * v; h[i + N + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sed) * ero, -dh);
        for (const [bx, by, bw] of brush) {
          const X = xi + bx, Y = yi + by; if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
          const j = Y * N + X; const e = Math.min(h[j], amt * bw); h[j] -= e; sed += e;
        }
      }
      sp = Math.sqrt(Math.max(0, sp * sp + dh * -grav)); w *= 1 - evap;
    }
  }
}

function smooth(h, N, passes = 1) {
  const t = new Float32Array(h.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= N || Y >= N) continue; s += h[Y * N + X]; c++;
      }
      t[y * N + x] = s / c;
    }
    h.set(t);
  }
}

// initial soil: thick on gentle ground, thin on steep, none on cliffs
function soilFor(height, N, cellSize) {
  const soil = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const zx = (height[y * N + Math.min(N - 1, x + 1)] - height[y * N + Math.max(0, x - 1)]) / (2 * cellSize);
    const zy = (height[Math.min(N - 1, y + 1) * N + x] - height[Math.max(0, y - 1) * N + x]) / (2 * cellSize);
    const sl = Math.hypot(zx, zy);
    soil[i] = Math.max(0, 1.5 * (1 - Math.min(1, sl / 0.9))) + 0.05;
  }
  return soil;
}

// Old volcanoes (about 1 random map in 3): a worn-down cinder cone with its throat plugged by hard
// lava, and one to three basalt flows that once ran down the valleys from its foot. They come with
// their rock (world.volcRock, see ROCK_WGSL in sim/common.js), so the soft cinders wash off and the
// hard basalt and plug stand up as the map erodes: lava-capped ridges and a volcanic neck.
// Adds to height in place; returns { volcRock, info } or null. Its own random stream, so maps
// without volcanoes are exactly as before.
function oldVolcanoes(height, N, cellSize, seed, noise) {
  const rnd = mulberry32(seed * 31337 + 5);
  if (rnd() > 0.35) return null;
  const count = rnd() < 0.7 ? 1 : 2;
  const rockTop = soilFor(height, N, cellSize).map((s, i) => height[i] - s);   // bedrock frame for the unit bases
  const vr = new Float32Array(N * N * 8);
  const at = (x, y) => height[Math.min(N - 1, Math.max(0, Math.round(y))) * N + Math.min(N - 1, Math.max(0, Math.round(x)))];
  const unit = (i, base, type) => {
    const c = 8 * i;
    let n = 0;
    while (n < 4 && vr[c + 4 + n] > 0.5) n++;
    if (n > 0 && vr[c + 4 + n - 1] === type) return;
    if (n < 4) { vr[c + n] = base; vr[c + 4 + n] = type; }
  };
  const info = [];
  for (let v = 0; v < count; v++) {
    // cones sit low: on plains and valley sides, not on the peaks
    let vx = 0, vy = 0, best = Infinity;
    for (let k = 0; k < 6; k++) {
      const x = N * (0.2 + 0.6 * rnd()), y = N * (0.2 + 0.6 * rnd());
      if (at(x, y) < best) { best = at(x, y); vx = x; vy = y; }
    }
    const s = 0.45;                                   // worn flanks
    const Hc = 50 + 110 * rnd();                      // what is left of the cone (m)
    const rr = 0.25 * Hc / s;
    // lava flows: from the foot of the cone, down the steepest way with some wander
    const nFlows = 1 + Math.floor(rnd() * 3);
    const add = new Float32Array(N * N);
    for (let f = 0; f < nFlows; f++) {
      let dir = rnd() * 2 * Math.PI, lowest = Infinity;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI, z = at(vx + Math.cos(a) * 30, vy + Math.sin(a) * 30) + 40 * rnd();
        if (z < lowest) { lowest = z; dir = a; }
      }
      const R0 = (1.25 * Hc / s) / cellSize;
      let x = vx + Math.cos(dir) * R0 * 0.8, y = vy + Math.sin(dir) * R0 * 0.8;
      let hx = Math.cos(dir), hy = Math.sin(dir);
      const len = Math.round((600 + 1400 * rnd()) / cellSize);
      const th = 8 + 12 * rnd(), w = (25 + 25 * rnd()) / cellSize;
      for (let k = 0; k < len; k++) {
        // steer downhill (with momentum), like the lava did
        let gx = (at(x + 2, y) - at(x - 2, y)) / 4, gy = (at(x, y + 2) - at(x, y - 2)) / 4;
        const g = Math.hypot(gx, gy) || 1;
        hx = 0.8 * hx - 0.2 * gx / g + 0.08 * (rnd() - 0.5); hy = 0.8 * hy - 0.2 * gy / g + 0.08 * (rnd() - 0.5);
        const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
        x += hx; y += hy;
        if (x < 3 || y < 3 || x > N - 4 || y > N - 4) break;
        const t = th * (1 - 0.4 * k / len), ww = w * (1 + 0.6 * k / len);
        const W = Math.ceil(ww) + 1;
        for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) {
          const X = Math.round(x) + dx, Y = Math.round(y) + dy;
          if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
          const d = Math.hypot(X - x, Y - y) / ww;
          if (d >= 1) continue;
          const i = Y * N + X;
          add[i] = Math.max(add[i], t * (1 - d ** 6));
        }
      }
    }
    for (let i = 0; i < N * N; i++) if (add[i] > 0.5) { unit(i, rockTop[i], 1); height[i] += add[i]; rockTop[i] += add[i]; }
    // the cone, gullied, with a filled-in crater; its throat is a plug of hard lava
    const R = Math.ceil((Hc / s + rr) / cellSize) + 1, gul = 5 + Math.floor(rnd() * 5), ph = rnd() * 7;
    for (let y = Math.max(0, Math.floor(vy - R)); y <= Math.min(N - 1, Math.ceil(vy + R)); y++) {
      for (let x = Math.max(0, Math.floor(vx - R)); x <= Math.min(N - 1, Math.ceil(vx + R)); x++) {
        const rc = Math.hypot(x - vx, y - vy), r = rc * cellSize;
        let dz = Math.max(0, Hc - s * Math.max(r - rr, 0)) * (0.92 + 0.08 * Math.cos(r / rr * 1.5));
        const a = Math.atan2(y - vy, x - vx);
        const g = 0.5 + 0.5 * Math.sin(a * gul + ph + 2 * noise(x / 9, y / 9));
        dz *= 1 - 0.3 * g ** 4 * Math.min(1, r / (Hc / s));
        if (dz < 0.5) continue;
        const i = y * N + x;
        if (rc <= 3) { vr.fill(0, 8 * i, 8 * i + 8); vr[8 * i] = rockTop[i] - 200; vr[8 * i + 4] = 3; }
        else unit(i, rockTop[i], 2);
        height[i] += dz; rockTop[i] += dz;
      }
    }
    info.push({ x: vx, y: vy, cone_m: Hc, flows: nFlows });
  }
  return { volcRock: vr, info };
}

export const SCENARIOS = ['random', 'cone', 'valley'];

// Returns { height, soil, volcRock, volcanoInfo } (metres above datum); volcRock is null when the
// map has no old volcanoes (volcanoes: false never adds any)
export function generateTerrain(scenario, { N = 512, cellSize = 10, seed = 1, ruggedness = 0.5, relief = 1, preErode = true, volcanoes = false } = {}) {
  const L = N * cellSize;
  const height = new Float32Array(N * N);
  const noise = makeNoise(seed);
  const rnd = mulberry32(seed);
  if (scenario === 'cone') {
    const H = 900 * relief, R = 0.42 * L;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const px = (x - N / 2 + 0.5) * cellSize, py = (y - N / 2 + 0.5) * cellSize;
      const r = Math.hypot(px, py);
      let z = r < R ? H * (1 - r / R) : -25 * (r - R) / (0.5 * L);
      z += 3 * fbm(noise, x / 24, y / 24, 4) + 25 * fbm(noise, x / 160 + 5, y / 160, 3) * Math.min(1, r / R);
      height[y * N + x] = z + 30;
    }
  } else if (scenario === 'valley') {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const px = (x - N / 2 + 0.5) * cellSize, py = y * cellSize;
      // V valley draining to the y = 0 edge: ~250 m fall along the axis, ~450 m side walls, any N
      let z = relief * (250 * (py / L) + 450 * Math.abs(px) / (0.5 * L)) + 3 * fbm(noise, x / 20, y / 20, 4) + 30 * relief * fbm(noise, x / 150, y / 150, 4);
      height[y * N + x] = z + 20;
    }
  } else {
    // random: fBm hills + ridged mountains, ruggedness blends + sharpens
    const s = 3.0 / N; // ~3 large features across the map regardless of resolution
    const ox = rnd() * 1000, oy = rnd() * 1000;
    const oct = Math.min(9, Math.round(Math.log2(N)) - 1);
    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const X = x * s + ox, Y = y * s + oy;
      const warp = 0.35 * fbm(noise, X * 0.7 + 50, Y * 0.7 + 50, 3);
      const base = fbm(noise, X + warp, Y - warp, oct, 0.45 + 0.15 * ruggedness);
      const r = ridged(noise, (X - warp) * 0.8, (Y + warp) * 0.8, oct, 0.45 + 0.1 * ruggedness);
      const m = 0.5 + 0.5 * fbm(noise, X * 0.35 + 99, Y * 0.35 - 33, 2);   // where mountains live
      let z = 0.55 * base + ruggedness * 1.3 * r * m * m;
      height[y * N + x] = z;
      if (z < mn) mn = z; if (z > mx) mx = z;
    }
    // normalise to 0..1, gentle power curve for broad valleys
    for (let i = 0; i < N * N; i++) { const t = Math.min(1, Math.max(0, (height[i] - mn) / (mx - mn))); height[i] = Math.pow(t, 1.25 + 0.4 * ruggedness); }
    if (preErode) { dropletErode(height, N, seed, 0.8 + ruggedness); smooth(height, N, 1); }
    const H = (700 + 900 * ruggedness) * relief;
    for (let i = 0; i < N * N; i++) height[i] = height[i] * H + 10;
  }
  const volc = scenario === 'random' && volcanoes ? oldVolcanoes(height, N, cellSize, seed, noise) : null;
  const soil = soilFor(height, N, cellSize);
  for (let i = 0; i < N * N; i++) { if (!Number.isFinite(height[i])) height[i] = 0; if (!Number.isFinite(soil[i])) soil[i] = 0.5; }
  return { height, soil, volcRock: volc?.volcRock ?? null, volcanoInfo: volc?.info ?? [] };
}
