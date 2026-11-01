// Raw-WebGPU renderer that reads the simulation storage buffers DIRECTLY in the vertex shader:
// zero copies, zero CPU readback. One shared index buffer (N-1)^2 quads, three draws:
// terrain (lit, snow/vegetation/rock shading + overlays), translucent water, and diorama skirts.
import { OrbitCamera } from './camera.js';

export const OVERLAYS = ['none', 'water', 'sediment', 'snow', 'frost', 'change'];

const SHADER = /* wgsl */`
struct R {
  viewProj : mat4x4<f32>,
  camPos : vec4<f32>,     // w = vertical exaggeration
  sun : vec4<f32>,        // xyz dir, w = N
  p0 : vec4<f32>,         // cellSize, overlay mode, overlay scale, morph
  soilC : vec4<f32>,      // w = hRef (height drawn at y=0)
  vegC : vec4<f32>,       // w = floor height for skirts
  rockC : vec4<f32>,      // w = gwMax
  p1 : vec4<f32>,         // x = show water, y = time
};
@group(0) @binding(0) var<uniform> U : R;
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(5) var<storage, read> ovl : array<f32>;
@group(0) @binding(6) var<storage, read> initHeight : array<f32>;
@group(0) @binding(7) var<storage, read> groundwater : array<f32>;
@group(0) @binding(8) var<storage, read> temp : array<f32>;

fn NN() -> i32 { return i32(U.sun.w); }
fn id(x : i32, y : i32) -> u32 { let n = NN(); return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1)); }
fn terr(i : u32) -> f32 { return bedrock[i] + soil[i]; }
fn surf(i : u32) -> f32 { return terr(i) + snowSWE[i] * 3.0; }       // snow depth ~ 3x SWE
fn wpos(x : i32, y : i32, h : f32) -> vec3<f32> {
  let n = f32(NN());
  let cs = U.p0.x;
  return vec3<f32>((f32(x) - 0.5 * (n - 1.0)) * cs, (h - U.soilC.w) * U.camPos.w, (f32(y) - 0.5 * (n - 1.0)) * cs);
}

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) nrm : vec3<f32>,
  @location(2) a : vec4<f32>,     // soil, swe, water depth, overlay value
  @location(3) b : vec4<f32>,     // change since start, groundwater, temp, slope
};

@vertex fn vsTerrain(@builtin(vertex_index) vid : u32) -> VOut {
  let n = NN();
  let x = i32(vid) % n; let y = i32(vid) / n;
  let i = id(x, y);
  let h = surf(i);
  let cs = U.p0.x; let ex = U.camPos.w;
  let hl = surf(id(x - 1, y)); let hr = surf(id(x + 1, y));
  let hd = surf(id(x, y - 1)); let hu = surf(id(x, y + 1));
  let gx = (hr - hl) / (2.0 * cs); let gy = (hu - hd) / (2.0 * cs);
  var o : VOut;
  let p = wpos(x, y, h);
  o.pos = U.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  o.nrm = normalize(vec3<f32>(-gx * ex, 1.0, -gy * ex));
  o.a = vec4<f32>(soil[i], snowSWE[i], water[i], ovl[i]);
  o.b = vec4<f32>(terr(i) - initHeight[i], groundwater[i], temp[i], length(vec2<f32>(gx, gy)));
  return o;
}

fn sky(d : vec3<f32>) -> vec3<f32> {
  let t = clamp(d.y * 1.4 + 0.15, 0.0, 1.0);
  return mix(vec3<f32>(0.80, 0.86, 0.92), vec3<f32>(0.33, 0.52, 0.80), t);
}
fn ramp(t : f32, c0 : vec3<f32>, c1 : vec3<f32>, c2 : vec3<f32>) -> vec3<f32> {
  let u = clamp(t, 0.0, 1.0);
  return select(mix(c1, c2, (u - 0.5) * 2.0), mix(c0, c1, u * 2.0), u < 0.5);
}
fn fogged(c : vec3<f32>, world : vec3<f32>) -> vec3<f32> {
  let d = length(world - U.camPos.xyz);
  let f = 1.0 - exp(-d * d * 1.2e-10 / max(U.p0.x * U.p0.x / 100.0, 0.05));
  return mix(c, vec3<f32>(0.78, 0.84, 0.90), clamp(f, 0.0, 0.6));
}

@fragment fn fsTerrain(v : VOut) -> @location(0) vec4<f32> {
  let n = normalize(v.nrm);
  let soilD = v.a.x; let swe = v.a.y; let depth = v.a.z;
  let slope = v.b.w; let T = v.b.z; let gw = v.b.y;
  let steep = smoothstep(0.55, 1.1, slope);
  let soilMix = smoothstep(0.02, 0.35, soilD) * (1.0 - steep * 0.8);
  var c = mix(U.rockC.rgb, U.soilC.rgb, soilMix);
  // rock strata banding
  c *= 0.97 + 0.03 * sin(v.world.y * 0.05 / max(U.camPos.w, 0.1)) * steep;
  let wet = clamp(gw / max(U.rockC.w, 1e-3), 0.0, 1.0);
  // vegetation: needs soil, not too steep, warmth, and moisture (local groundwater + regional climate)
  let moist = clamp(U.p1.z * 0.75 + smoothstep(0.1, 0.7, wet) * 0.6, 0.0, 1.0);
  let veg = soilMix * moist * smoothstep(-6.0, 8.0, T) * (1.0 - steep);
  c = mix(c, U.vegC.rgb * (0.8 + 0.3 * wet), veg * 0.85);
  c *= 1.0 - 0.35 * smoothstep(0.0005, 0.03, depth);        // damp ground darkens
  let snowC = smoothstep(0.003, 0.04, swe);
  c = mix(c, vec3<f32>(0.93, 0.95, 0.98), snowC);
  // lighting: sun + sky hemisphere
  let L = normalize(U.sun.xyz);
  let diff = max(dot(n, L), 0.0);
  let hemi = 0.5 + 0.5 * n.y;
  var col = c * (diff * vec3<f32>(1.0, 0.96, 0.88) * 0.95 + hemi * vec3<f32>(0.30, 0.36, 0.45));
  // overlays
  let mode = i32(U.p0.y + 0.5);
  let sc = U.p0.z;
  if (mode == 1) {         // water depth
    let t = clamp(log(1.0 + v.a.w * 100.0) / log(1.0 + sc * 100.0), 0.0, 1.0);
    col = mix(col, ramp(t, vec3<f32>(0.75, 0.9, 1.0), vec3<f32>(0.1, 0.5, 0.95), vec3<f32>(0.05, 0.05, 0.45)), smoothstep(0.0, 0.05, t) * 0.85);
  } else if (mode == 2) {  // sediment (bed-equivalent, log)
    let t = clamp(log(1.0 + v.a.w * 1000.0) / log(1.0 + sc * 1000.0), 0.0, 1.0);
    col = mix(col, ramp(t, vec3<f32>(1.0, 0.95, 0.6), vec3<f32>(0.95, 0.55, 0.1), vec3<f32>(0.5, 0.15, 0.05)), smoothstep(0.0, 0.05, t) * 0.85);
  } else if (mode == 3) {  // snow SWE
    let t = clamp(v.a.w / sc, 0.0, 1.0);
    col = mix(col, ramp(t, vec3<f32>(0.8, 0.95, 1.0), vec3<f32>(0.4, 0.6, 1.0), vec3<f32>(0.5, 0.1, 0.7)), smoothstep(0.0, 0.02, t) * 0.85);
  } else if (mode == 4) {  // frost depth
    let t = clamp(v.a.w / sc, 0.0, 1.0);
    col = mix(col, ramp(t, vec3<f32>(0.7, 1.0, 1.0), vec3<f32>(0.2, 0.7, 0.9), vec3<f32>(0.1, 0.2, 0.6)), smoothstep(0.0, 0.02, t) * 0.85);
  } else if (mode == 5) {  // erosion (red) / deposition (blue) since start
    let t = clamp(v.b.x / sc, -1.0, 1.0);
    let ce = mix(vec3<f32>(0.97, 0.97, 0.95), vec3<f32>(0.8, 0.1, 0.05), clamp(-t, 0.0, 1.0));
    let cd = mix(vec3<f32>(0.97, 0.97, 0.95), vec3<f32>(0.05, 0.3, 0.85), clamp(t, 0.0, 1.0));
    let cc = select(cd, ce, t < 0.0);
    col = mix(col, cc * (0.55 + 0.45 * diff + 0.2), 0.8 * smoothstep(0.0, 0.03, abs(t)) + 0.1);
  }
  return vec4<f32>(fogged(col, v.world), 1.0);
}

// ---------------- water ----------------
struct WOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) nrm : vec3<f32>,
  @location(2) d : vec2<f32>,    // depth, muddiness
};
fn wsurf(i : u32) -> f32 { return terr(i) + water[i]; }
@vertex fn vsWater(@builtin(vertex_index) vid : u32) -> WOut {
  let n = NN();
  let x = i32(vid) % n; let y = i32(vid) / n;
  let i = id(x, y);
  let d = water[i];
  let cs = U.p0.x; let ex = U.camPos.w;
  let hs = wsurf(i);
  let gx = (wsurf(id(x + 1, y)) - wsurf(id(x - 1, y))) / (2.0 * cs);
  let gy = (wsurf(id(x, y + 1)) - wsurf(id(x, y - 1))) / (2.0 * cs);
  var o : WOut;
  let p = wpos(x, y, select(terr(i) - 1.0, hs, d > 0.003));
  o.pos = U.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  o.nrm = normalize(vec3<f32>(-gx * ex * 0.3, 1.0, -gy * ex * 0.3));
  let conc = ovl[i] / max(U.p0.w * d, 1e-6);       // ovl = sediment here
  o.d = vec2<f32>(d, clamp(conc * 25.0, 0.0, 0.85));
  return o;
}
@fragment fn fsWater(v : WOut) -> @location(0) vec4<f32> {
  if (v.d.x < 0.004 || U.p1.x < 0.5) { discard; }
  let n = normalize(v.nrm);
  let V = normalize(U.camPos.xyz - v.world);
  let L = normalize(U.sun.xyz);
  let deep = 1.0 - exp(-v.d.x * 1.2);
  var c = mix(vec3<f32>(0.18, 0.45, 0.55), vec3<f32>(0.03, 0.15, 0.32), deep);
  c = mix(c, vec3<f32>(0.45, 0.33, 0.20), v.d.y);
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  let refl = sky(reflect(-V, n));
  let H = normalize(L + V);
  let spec = pow(max(dot(n, H), 0.0), 120.0) * 0.8;
  var col = mix(c * (0.55 + 0.45 * max(dot(n, L), 0.0)), refl, fres * 0.6) + vec3<f32>(spec);
  let a = clamp(0.35 + 0.65 * smoothstep(0.004, 0.6, v.d.x) + fres * 0.3, 0.0, 0.92);
  return vec4<f32>(fogged(col, v.world), a);
}

// ---------------- skirts (diorama sides) ----------------
struct SOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) t : vec2<f32>,    // depth below surface, side shade
};
@vertex fn vsSkirt(@builtin(vertex_index) vid : u32) -> SOut {
  let n = NN();
  let segs = u32(n - 1);
  let side = vid / (segs * 6u);
  let r = vid % (segs * 6u);
  let seg = r / 6u;
  let corner = array<vec2<u32>, 6>(vec2<u32>(0u, 0u), vec2<u32>(1u, 0u), vec2<u32>(0u, 1u), vec2<u32>(1u, 0u), vec2<u32>(1u, 1u), vec2<u32>(0u, 1u))[r % 6u];
  let k = i32(seg + corner.x);
  var x = 0; var y = 0;
  if (side == 0u) { x = k; y = 0; }
  else if (side == 1u) { x = n - 1; y = k; }
  else if (side == 2u) { x = n - 1 - k; y = n - 1; }
  else { x = 0; y = n - 1 - k; }
  let top = terr(id(x, y));
  let h = select(top, U.vegC.w, corner.y == 1u);
  var o : SOut;
  let p = wpos(x, y, h);
  o.pos = U.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  o.t = vec2<f32>(top - h, 0.75 + 0.25 * f32(side % 2u));
  return o;
}
@fragment fn fsSkirt(v : SOut) -> @location(0) vec4<f32> {
  var c = U.rockC.rgb * 0.75;
  c = mix(U.soilC.rgb * 0.8, c, smoothstep(0.5, 3.0, v.t.x));
  c *= 0.85 + 0.15 * sin(v.world.y * 0.15 / max(U.camPos.w, 0.1));
  return vec4<f32>(fogged(c * v.t.y, v.world), 1.0);
}

// ---------------- sky ----------------
struct KOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vsSky(@builtin(vertex_index) vid : u32) -> KOut {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0))[vid];
  var o : KOut; o.pos = vec4<f32>(p, 1.0, 1.0); o.uv = p; return o;
}
@fragment fn fsSky(v : KOut) -> @location(0) vec4<f32> {
  let t = clamp(v.uv.y * 0.5 + 0.5, 0.0, 1.0);
  return vec4<f32>(mix(vec3<f32>(0.80, 0.86, 0.92), vec3<f32>(0.36, 0.55, 0.82), t), 1.0);
}
`;

export class Renderer {
  constructor(device, canvas, format) {
    this.device = device; this.canvas = canvas; this.format = format;
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({ device, format, alphaMode: 'opaque' });
    this.camera = new OrbitCamera(canvas);
    this.overlay = 'none';
    this.overlayScale = { none: 1, water: 2, sediment: 0.5, snow: 0.5, frost: 1.0, change: 5 };
    this.exaggeration = 1.5;
    this.showWater = true;
    this.sampleCount = 4;
    this.ubuf = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.u = new Float32Array(48);
    const entries = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }];
    for (let b = 1; b <= 8; b++) entries.push({ binding: b, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } });
    this.layout = device.createBindGroupLayout({ entries, label: 'render' });
    const module = device.createShaderModule({ code: SHADER, label: 'render' });
    module.getCompilationInfo?.().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error('[render] WGSL', m.lineNum, m.message); });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const ms = { count: this.sampleCount };
    const depth = (write = true) => ({ format: 'depth32float', depthWriteEnabled: write, depthCompare: 'less' });
    this.pTerrain = device.createRenderPipeline({
      label: 'terrain', layout: pl, multisample: ms, depthStencil: depth(),
      vertex: { module, entryPoint: 'vsTerrain' }, fragment: { module, entryPoint: 'fsTerrain', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.pSkirt = device.createRenderPipeline({
      label: 'skirt', layout: pl, multisample: ms, depthStencil: depth(),
      vertex: { module, entryPoint: 'vsSkirt' }, fragment: { module, entryPoint: 'fsSkirt', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.pWater = device.createRenderPipeline({
      label: 'water', layout: pl, multisample: ms, depthStencil: depth(false),
      vertex: { module, entryPoint: 'vsWater' },
      fragment: { module, entryPoint: 'fsWater', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const skyModule = device.createShaderModule({ code: SHADER.slice(SHADER.indexOf('// ---------------- sky')), label: 'sky' });
    this.pSky = device.createRenderPipeline({
      label: 'sky', layout: device.createPipelineLayout({ bindGroupLayouts: [] }), multisample: ms,
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
      vertex: { module: skyModule, entryPoint: 'vsSky' },
      fragment: { module: skyModule, entryPoint: 'fsSky', targets: [{ format }] },
    });
  }

  setWorld(world) {
    this.world = world;
    const N = world.N, B = world.buffers;
    // index buffer for (N-1)^2 quads
    if (this.indexN !== N) {
      this.index?.destroy();
      const q = (N - 1) * (N - 1);
      const idx = new Uint32Array(q * 6);
      let k = 0;
      for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
        const a = y * N + x, b = a + 1, c = a + N, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
      this.index = this.device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(this.index, 0, idx);
      this.indexCount = idx.length; this.indexN = N;
    }
    const mk = (ovl) => this.device.createBindGroup({
      layout: this.layout,
      entries: [this.ubuf, B.bedrock, B.soil, B.water, B.snowSWE, ovl, B.initHeight, B.groundwater, B.temp]
        .map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
    this.bg = {
      none: mk(B.water), water: mk(B.water), sediment: mk(B.sediment), snow: mk(B.snowSWE),
      frost: mk(B.frostDepth), change: mk(B.water),
    };
    this.bgWater = mk(B.sediment);
    this.camera.reset(N * world.cellSize * 0.5 * 2);
  }

  _targets() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h || !this.msaa) {
      this.canvas.width = w; this.canvas.height = h;
      this.msaa?.destroy(); this.depth?.destroy();
      this.msaa = this.device.createTexture({ size: [w, h], sampleCount: this.sampleCount, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.depth = this.device.createTexture({ size: [w, h], sampleCount: this.sampleCount, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return [w, h];
  }

  // Encodes a frame into `encoder` (caller submits, so sim + render go in one submission).
  encode(encoder, sim, timestampWrites) {
    if (!this.world) return;
    const [w, h] = this._targets();
    const { vp, eye } = this.camera.viewProj(w / h);
    const u = this.u, N = this.world.N;
    const tr = sim.terrainRange || { min: 0, max: 1, mean: 0 };
    u.set(vp, 0);
    u.set([eye[0], eye[1], eye[2], this.exaggeration], 16);
    const sun = [0.55, 0.62, 0.35];
    u.set([...sun, N], 20);
    u.set([this.world.cellSize, OVERLAYS.indexOf(this.overlay), this.overlayScale[this.overlay] || 1, sim.lastPlan?.morph || 1], 24);
    const col = sim.climate.preset.colors;
    const hRef = tr.mean;
    u.set([...col.soil, hRef], 28);
    u.set([...col.veg, tr.min - 60 - 0.04 * N * this.world.cellSize / this.exaggeration], 32);
    u.set([...col.rock, sim.climate.preset.gwMax], 36);
    const pm = sim.climate.preset.pMean * sim.climate.precipMul;
    u.set([this.showWater ? 1 : 0, performance.now() / 1000, Math.min(1, Math.max(0.05, (pm - 0.4) / 3.5)), 0], 40);
    this.device.queue.writeBuffer(this.ubuf, 0, u);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0.8, g: 0.86, b: 0.92, a: 1 } }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
      timestampWrites,
    });
    pass.setPipeline(this.pSky); pass.draw(3);
    pass.setBindGroup(0, this.bg[this.overlay] || this.bg.none);
    pass.setIndexBuffer(this.index, 'uint32');
    pass.setPipeline(this.pTerrain); pass.drawIndexed(this.indexCount);
    pass.setPipeline(this.pSkirt); pass.draw(4 * (N - 1) * 6);
    if (this.showWater) {
      pass.setBindGroup(0, this.bgWater);
      pass.setPipeline(this.pWater); pass.drawIndexed(this.indexCount);
    }
    pass.end();
  }
}
