// Small WebGPU helpers shared by the simulation and renderer.

export async function initGPU() {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
    },
  });
  // Keep the adapter alive: some Chromium builds lose the device if it is garbage collected.
  globalThis.__gpuAdapter = adapter;
  globalThis.__gpuDevice = device;
  device.lost.then((info) => console.error('WebGPU device lost:', info.message));
  device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));
  return { adapter, device };
}

// Shared WGSL helpers. Every compute kernel uses 16x16 workgroups over the N x N grid.
export const WGSL_COMMON = /* wgsl */ `
fn cl(v: i32, n: i32) -> i32 { return clamp(v, 0, n - 1); }
fn ix(x: i32, y: i32, n: i32) -> u32 { return u32(cl(y, n) * n + cl(x, n)); }
fn finiteOr(v: f32, d: f32) -> f32 {
  // NaN fails every comparison, so this rejects NaN and +-inf.
  if (v == v && abs(v) < 1e30) { return v; }
  return d;
}
`;

/**
 * Build a compute kernel family: one WGSL module, many entry points, one explicit bind group layout.
 * bindings: array of 'uniform' | 'storage' | 'read' in binding order.
 */
export function makeKernels(device, label, code, bindings, entries) {
  const module = device.createShaderModule({ label, code });
  module.getCompilationInfo?.().then((info) => {
    for (const m of info.messages) if (m.type === 'error') console.error(`[${label}] WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
  });
  const layout = device.createBindGroupLayout({
    label,
    entries: bindings.map((t, i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: t === 'uniform' ? 'uniform' : t === 'read' ? 'read-only-storage' : 'storage' },
    })),
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipes = {};
  for (const e of entries) {
    pipes[e] = device.createComputePipeline({ label: `${label}.${e}`, layout: pipelineLayout, compute: { module, entryPoint: e } });
  }
  return {
    layout,
    pipes,
    bind(buffers) {
      return device.createBindGroup({ layout, entries: buffers.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    },
  };
}

export function dispatch(encoder, pipe, bindGroup, N) {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(N / 16), Math.ceil(N / 16));
  pass.end();
}

/** A ring of uniform buffers so many steps can be encoded into one command buffer with different parameters. */
export class UniformRing {
  constructor(device, byteSize, slots = 128) {
    this.device = device;
    this.size = Math.ceil(byteSize / 16) * 16;
    this.buffers = [];
    for (let i = 0; i < slots; i++) {
      this.buffers.push(device.createBuffer({ size: this.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    this.i = 0;
    this.scratch = new ArrayBuffer(this.size);
    this.f = new Float32Array(this.scratch);
    this.u = new Uint32Array(this.scratch);
  }
  /** Write current scratch contents to the next slot; returns slot index. */
  push() {
    const slot = this.i;
    this.i = (this.i + 1) % this.buffers.length;
    this.device.queue.writeBuffer(this.buffers[slot], 0, this.scratch);
    return slot;
  }
}
