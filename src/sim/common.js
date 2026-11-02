import { PARAMS_WGSL } from './params.js';
import { strataWGSL, STRATA_PARAM_FIELDS } from './strata.js';

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
// Rock at bedrock elevation z in cell (x, y): (erode multiplier, weather multiplier, cliff tan).
// With rock layers off every cell is the same uniform rock as before.
fn rockAt(z : f32, x : i32, y : i32) -> vec3<f32> {
  if (P.strataOn < 0.5) { return vec3<f32>(1.0, 1.0, P.rockTan); }
  return stProps(z, vec2<f32>(f32(x), f32(y)));
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
