import { PARAMS_WGSL } from './params.js';
import { strataWGSL, STRATA_PARAM_FIELDS, VOLCANIC } from './strata.js';

// Shared WGSL prelude: params uniform at @group(0) @binding(0) plus grid helpers.
// All grid kernels use 16x16 workgroups (256 threads, good occupancy on NVIDIA/AMD/Intel and
// 2D locality for the 4-neighbour stencils).
export const WG = 16;

export const COMMON_WGSL = /* wgsl */`
${PARAMS_WGSL}
@group(0) @binding(0) var<uniform> P : Params;

fn idx(x : i32, y : i32) -> u32 { return u32(y) * P.N + u32(x); }
fn cl(v : i32) -> i32 { return clamp(v, 0, i32(P.N) - 1); }
fn idxc(x : i32, y : i32) -> u32 { return idx(cl(x), cl(y)); }
// NaN/Inf -> 0 using the exponent bits (WGSL compilers may assume no NaNs, so v != v is unreliable)
fn isBad(v : f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u; }
fn finite(v : f32) -> f32 { return select(v, 0.0, isBad(v)); }
const PI : f32 = 3.14159265;
// Groundwater capacity (m of water) of a cell: thin rocky soil holds little, deep soil and
// alluvium hold more. Equals the preset's gwMax at 1 m of soil. Mirrored on the CPU by gwCapacity().
fn gwCap(soilDepth : f32) -> f32 { return P.gwMax * (0.15 + 0.85 * min(max(soilDepth, 0.0), 2.0)); }
${strataWGSL((i) => `P.${STRATA_PARAM_FIELDS[i]}`, (k) => `P.stBeds[${k}]`)}
// Layered rock at bedrock elevation z in cell (x, y): (erode multiplier, weather multiplier, cliff
// tan), including the anomalies. With rock layers off every cell is the same uniform rock as before.
fn rockStrata(z : f32, x : i32, y : i32) -> vec3<f32> {
  if (P.strataOn < 0.5) { return vec3<f32>(1.0, 1.0, P.rockTan); }
  return stProps(z, vec2<f32>(f32(x), f32(y)));
}
// What the rock does to water and heat: (dissolution multiplier, groundwater conductivity
// multiplier, ground warming deg C). Rock layers off: insoluble, plain, no heat.
fn rockExtra(z : f32, x : i32, y : i32) -> vec3<f32> {
  if (P.strataOn < 0.5) { return vec3<f32>(0.0, 1.0, 0.0); }
  let r = stRock(z, vec2<f32>(f32(x), f32(y)));
  return vec3<f32>(r.sol, r.perm, r.heat);
}
// Groundwater capacity of a cell over soluble rock: fissured, dissolved-out limestone (epikarst)
// holds up to 5x the water of plain rock, so streams have somewhere to sink into.
fn gwCapRock(soilDepth : f32, sol : f32) -> f32 { return gwCap(soilDepth) * (1.0 + 4.0 * min(max(sol, 0.0), 1.0)); }
`;

// Volcanic rock on top of the plateau stack (sim/volcano.js). world.volcRock holds 2 vec4 per cell:
//   [2i]   the bases of up to 4 units, bottom first (bedrock heights, m)
//   [2i+1] their type codes (strata.js VOLCANIC: 1 basalt, 2 cinders, 3 plug, 4 andesite/dacite,
//          5 ash and pumice, 6 tuff/ignimbrite, 7 explosion breccia; 0 = no unit)
// Unit k runs from its base up to the next unit's base; the top unit runs up to the rock surface.
// Below the lowest base the plateau beds apply. Erosion simply cuts down through the units: a unit
// whose base is above the rock top is gone (vrAdd tidies such units up when it next adds one).
// Kernels that call rockAt include ROCK_WGSL and declare `volcRock : array<vec4<f32>>`.
const v = (t) => VOLCANIC[t];
export const VOLC_WGSL = /* wgsl */`
fn vrProps(t : f32) -> vec3<f32> {
  if (t < 1.5) { return vec3<f32>(${v(1).erode}, ${v(1).weather}, ${v(1).cliffTan}); }
  if (t < 2.5) { return vec3<f32>(${v(2).erode}, ${v(2).weather}, ${v(2).cliffTan}); }
  if (t < 3.5) { return vec3<f32>(${v(3).erode}, ${v(3).weather}, ${v(3).cliffTan}); }
  if (t < 4.5) { return vec3<f32>(${v(4).erode}, ${v(4).weather}, ${v(4).cliffTan}); }
  if (t < 5.5) { return vec3<f32>(${v(5).erode}, ${v(5).weather}, ${v(5).cliffTan}); }
  if (t < 6.5) { return vec3<f32>(${v(6).erode}, ${v(6).weather}, ${v(6).cliffTan}); }
  return vec3<f32>(${v(7).erode}, ${v(7).weather}, ${v(7).cliffTan});
}
// index of the unit holding height z (-1: below the pile, or no pile)
fn vrUnit(z : f32, c : vec4<f32>, t : vec4<f32>) -> i32 {
  if (t.x < 0.5 || z < c.x) { return -1; }
  var k = 0;
  if (t.y > 0.5 && z >= c.y) { k = 1; }
  if (k == 1 && t.z > 0.5 && z >= c.z) { k = 2; }
  if (k == 2 && t.w > 0.5 && z >= c.w) { k = 3; }
  return k;
}
`;
export const ROCK_WGSL = VOLC_WGSL + /* wgsl */`
// Rock at bedrock elevation z in cell (x, y): volcanic units first, else the plateau beds, with a
// ~1 m blend across each base so the erosion rates do not jump.
fn rockAt(z : f32, x : i32, y : i32) -> vec3<f32> {
  let i = idx(x, y);
  let t = volcRock[2u * i + 1u];
  if (t.x < 0.5) { return rockStrata(z, x, y); }
  let c = volcRock[2u * i];
  let k = vrUnit(z, c, t);
  if (k < 0) { return rockStrata(z, x, y); }
  let below = select(rockStrata(z, x, y), vrProps(t[max(k - 1, 0)]), k > 0);
  return mix(below, vrProps(t[k]), smoothstep(0.0, 1.0, z - c[k]));
}
`;
export function gwCapacity(soilDepth, gwMax) { return gwMax * (0.15 + 0.85 * Math.min(Math.max(soilDepth, 0), 2)); }

export function dispatchGrid(pass, N) {
  const g = Math.ceil(N / WG);
  pass.dispatchWorkgroups(g, g);
}

// Helper to create a compute pipeline + bind group layout from (params + storage buffers).
// `bindings` is a list of 'r' (read-only storage) / 'rw' (storage) / 'u' (uniform) flags, binding i+1.
export function makeKernel(device, label, code, bindings, entryPoint = 'main') {
  const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }];
  bindings.forEach((m, i) => entries.push({
    binding: i + 1, visibility: GPUShaderStage.COMPUTE,
    buffer: { type: m === 'r' ? 'read-only-storage' : m === 'u' ? 'uniform' : 'storage' },
  }));
  const layout = device.createBindGroupLayout({ label, entries });
  const module = device.createShaderModule({ label, code });
  module.getCompilationInfo?.().then((info) => {
    for (const m of info.messages) if (m.type === 'error') console.error(`[${label}] WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
  });
  const pipeline = device.createComputePipeline({
    label, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint },
  });
  return {
    pipeline, layout,
    bind(paramsBuf, buffers) {
      return device.createBindGroup({
        label, layout,
        entries: [{ binding: 0, resource: { buffer: paramsBuf } }, ...buffers.map((b, i) => ({ binding: i + 1, resource: { buffer: b } }))],
      });
    },
  };
}
