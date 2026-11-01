// Lateral groundwater flow and springs (ported from the Physicist build).
//
// The column kernel fills each cell's shallow groundwater store by infiltration. Here that water
// moves sideways through the ground, downhill, as kinematic Darcy flow with the water table parallel
// to the surface:  q = K * S * b   (b = saturated thickness = groundwater / porosity).
// Water converging in hollows and valley bottoms overfills the store, and the saturation excess
// comes out at the surface as springs and seeps that feed the streams. Frozen ground stops the flow.
//
// Two race-free passes per batch: `out` writes each cell's four outgoing transfers, `apply` gathers
// its own outflow and the neighbours' matching inflow, so every cubic metre leaving one cell arrives
// in another (exact conservation). Transfers across the map edge and spring water that the routed
// solver cannot carry this frame (fraction 1 - fR) are logged as outflow.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const GROUNDWATER_PARAMS = {
  kGw: 3e-5,       // m/s hydraulic conductivity of the shallow ground (silty sand)
  gwPor: 0.3,      // porosity: m of water per m of saturated ground
};

const OUT_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> groundwater : array<f32>;
@group(0) @binding(4) var<storage, read> frostDepth : array<f32>;
@group(0) @binding(5) var<storage, read_write> gwFlux : array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let z = bedrock[i] + soil[i];
  let g = groundwater[i];
  let dx = P.cellSize;
  // neighbour order: -x, +x, -y, +y (same as the surface-water pipes)
  let nx = array<i32, 4>(x - 1, x + 1, x, x);
  let ny = array<i32, 4>(y, y, y - 1, y + 1);
  var o = vec4<f32>(0.0);
  for (var k = 0; k < 4; k++) {
    var zn = z - 0.05 * dx;                                 // outside the map: gentle drop (open boundary)
    if (nx[k] >= 0 && nx[k] < N && ny[k] >= 0 && ny[k] < N) { let j = idx(nx[k], ny[k]); zn = bedrock[j] + soil[j]; }
    let S = min(max(z - zn, 0.0) / dx, 1.0);
    o[k] = P.kGw * S * (g / P.gwPor) * P.gwDt / dx;         // depth leaving through this face over the batch
  }
  let tot = o.x + o.y + o.z + o.w;
  // never move more than half the store in one batch (stable for any batch length); frozen ground is sealed
  var sc = 0.0;
  if (tot > 0.0 && frostDepth[i] < 0.03) { sc = min(1.0, 0.5 * g / tot); }
  gwFlux[i] = finiteVec(o * sc);
}
fn finiteVec(v : vec4<f32>) -> vec4<f32> { return vec4<f32>(finite(v.x), finite(v.y), finite(v.z), finite(v.w)); }
`;

const APPLY_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> groundwater : array<f32>;
@group(0) @binding(2) var<storage, read> gwFlux : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> water : array<f32>;
@group(0) @binding(4) var<storage, read_write> acc : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> spring : array<f32>;
@group(0) @binding(6) var<storage, read> soil : array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  let o = gwFlux[i];
  var inW = 0.0; var edge = 0.0;
  // inflow from each neighbour is that neighbour's transfer through the opposite face
  if (x > 0)     { inW += gwFlux[idx(x - 1, y)].y; } else { edge += o.x; }
  if (x < N - 1) { inW += gwFlux[idx(x + 1, y)].x; } else { edge += o.y; }
  if (y > 0)     { inW += gwFlux[idx(x, y - 1)].w; } else { edge += o.z; }
  if (y < N - 1) { inW += gwFlux[idx(x, y + 1)].z; } else { edge += o.w; }
  var g = max(groundwater[i] - (o.x + o.y + o.z + o.w) + inW, 0.0);
  // springs: saturation excess emerges at the surface (capacity depends on soil depth, so water
  // also seeps out where erosion strips the soil off)
  let ex = max(g - gwCap(soil[i]), 0.0);
  g = g - ex;
  let routed = ex * P.fR;
  water[i] = water[i] + routed;
  groundwater[i] = g;
  // spring strength for display: moving average of emerging water (m/day)
  spring[i] = mix(spring[i], ex / max(P.D, 1e-3), 0.1);
  acc[i] = acc[i] + vec4<f32>(0.0, edge + (ex - routed), 0.0, 0.0);
}
`;

class GroundwaterKernel {
  constructor() { this.name = 'groundwater'; this.world = null; }
  init(device, world) {
    if (this.world === world && this.ko) return;
    this.device = device; this.world = world;
    const B = world.buffers;
    this.ko = makeKernel(device, 'groundwater.out', OUT_WGSL, ['r', 'r', 'r', 'r', 'rw']);
    this.ka = makeKernel(device, 'groundwater.apply', APPLY_WGSL, ['rw', 'r', 'rw', 'rw', 'rw', 'r']);
    this.bo = this.ko.bind(world.params.buffer, [B.bedrock, B.soil, B.groundwater, B.frostDepth, B.gwFlux]);
    this.ba = this.ka.bind(world.params.buffer, [B.groundwater, B.gwFlux, B.water, B.acc, B.spring, B.soil]);
  }
  record(pass) {
    pass.setPipeline(this.ko.pipeline); pass.setBindGroup(0, this.bo); dispatchGrid(pass, this.world.N);
    pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.ba); dispatchGrid(pass, this.world.N);
  }
  // contract-style step
  step(encoder) {
    const pass = encoder.beginComputePass({ label: 'groundwater' });
    this.record(pass);
    pass.end();
  }
}

export const groundwater = new GroundwaterKernel();
export default groundwater;
