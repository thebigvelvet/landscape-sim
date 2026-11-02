// Orbit camera: left-drag rotates, right-drag (or shift+drag) pans, wheel zooms.
// Matrices are column-major Float32Array(16), WebGPU clip space (depth 0..1).

export const mat4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = far / (near - far); m[11] = -1;
    m[14] = (far * near) / (near - far);
    return m;
  },
  lookAt(eye, target, up) {
    const z = norm(sub(eye, target));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  invert(m) {
    const inv = new Float32Array(16);
    const a = m;
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    det = det ? 1 / det : 0;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
};

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

export class OrbitCamera {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = 0.6;
    this.pitch = 0.5;
    this.dist = 8000;
    this.target = [0, 300, 0];
    this.extent = 5000;
    this.autoRotate = false;
    this.fov = (40 * Math.PI) / 180;
    this.bind();
  }

  frame(extent, heightMid) {
    this.extent = extent;
    this.dist = extent * 1.75;
    this.target = [0, heightMid, 0];
    this.yaw = 0.65;
    this.pitch = 0.52;
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      // an event brush is selected: the left button paints instead of turning the view
      if (e.button === 0 && !e.shiftKey && this.leftButtonBlocked?.()) { drag = null; return; }
      drag ={ x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey };
      c.setPointerCapture(e.pointerId);
      this.autoRotate = false;
    });
    c.addEventListener('pointerup', (e) => { drag = null; c.releasePointerCapture?.(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const s = (this.dist * 1.2) / c.clientHeight;
        // Pan in the ground plane: the land follows the mouse.
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        this.target[0] += -dx * s * rx + dy * s * fx;
        this.target[2] += -dx * s * rz + dy * s * fz;
        this.clampTarget();
      } else {
        this.yaw -= dx * 0.005;
        this.pitch = Math.min(1.45, Math.max(0.05, this.pitch + dy * 0.004));
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.min(this.extent * 4, Math.max(this.extent * 0.06, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  clampTarget() {
    const L = this.extent * 0.6;
    this.target[0] = Math.max(-L, Math.min(L, this.target[0]));
    this.target[2] = Math.max(-L, Math.min(L, this.target[2]));
  }

  update(dt) {
    if (this.autoRotate) this.yaw += dt * 0.05;
  }

  eye() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] + this.dist * Math.sin(this.pitch),
      this.target[2] + this.dist * cp * Math.cos(this.yaw),
    ];
  }

  /** shift: fraction of the canvas width covered on the left (the image centre moves right by half of it). */
  matrices(aspect, shift = 0) {
    const eye = this.eye();
    const view = mat4.lookAt(eye, this.target, [0, 1, 0]);
    const near = Math.max(2, this.dist * 0.01);
    const far = this.dist + this.extent * 4;
    const proj = mat4.perspective(this.fov, aspect, near, far);
    proj[8] = -shift; // off-centre projection (lens shift)
    const viewProj = mat4.mul(proj, view);
    return { eye, viewProj, invViewProj: mat4.invert(viewProj) };
  }
}
