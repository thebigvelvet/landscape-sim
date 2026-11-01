// Minimal orbit camera + mat4 helpers (column-major, WebGPU clip z in [0,1]).
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}
export function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
export function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class OrbitCamera {
  constructor(canvas) {
    this.canvas = canvas;
    this.reset(5000);
    let mode = 0, lx = 0, ly = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      mode = (e.button === 2 || e.shiftKey || e.button === 1) ? 2 : 1;
      lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => { mode = 0; canvas.releasePointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (mode === 1) {
        this.yaw -= dx * 0.005;
        this.pitch = Math.min(1.5, Math.max(0.05, this.pitch + dy * 0.005));
      } else {
        const s = this.dist * 0.0015;
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        // right = (cos, 0, -sin), forward (on ground) = (-sin, 0, -cos)
        this.target[0] += (-dx * cy - dy * sy) * s;
        this.target[2] += (dx * sy - dy * cy) * s;
        const lim = this.extent * 0.75;
        this.target[0] = Math.max(-lim, Math.min(lim, this.target[0]));
        this.target[2] = Math.max(-lim, Math.min(lim, this.target[2]));
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }
  reset(extent) {
    this.extent = extent;
    this.target = [0, 0, 0];
    this.yaw = 0.7; this.pitch = 0.62;
    this.dist = extent * 1.35;
    this.minDist = extent * 0.03; this.maxDist = extent * 5;
  }
  eye() {
    const cp = Math.cos(this.pitch);
    return [this.target[0] + this.dist * cp * Math.sin(this.yaw), this.target[1] + this.dist * Math.sin(this.pitch), this.target[2] + this.dist * cp * Math.cos(this.yaw)];
  }
  viewProj(aspect) {
    const eye = this.eye();
    const near = Math.max(1, this.dist * 0.01), far = this.dist * 4 + this.extent * 3;
    return { vp: mul(perspective(0.85, aspect, near, far), lookAt(eye, this.target, [0, 1, 0])), eye };
  }
}
