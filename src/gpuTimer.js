// GPU pass timing with timestamp queries (when the adapter offers 'timestamp-query').
// Used by the sub-step governor: it measures the real GPU time of the sim and render passes,
// independent of vsync, queue latency or how often the browser polls for completion.
// Readback is async through a small ring of map buffers; a frame is skipped if all are busy.
export class GpuTimer {
  constructor(device) {
    this.device = device;
    this.ok = device.features.has('timestamp-query');
    this.simMs = 0; this.renderMs = 0; this.samples = 0;
    if (!this.ok) return;
    this.qs = device.createQuerySet({ type: 'timestamp', count: 4 });
    this.resolve = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.free = [0, 1, 2].map(() => device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    this.simWritten = false;
  }
  simPassTimestamps() {
    if (!this.ok) return undefined;
    this.simWritten = true;
    return { querySet: this.qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }
  renderPassTimestamps() {
    if (!this.ok) return undefined;
    return { querySet: this.qs, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 };
  }
  // call after the render pass in the frame's last encoder, before submit
  resolveInto(encoder) {
    if (!this.ok || !this.free.length) { this._pending = null; return; }
    const buf = this.free.pop();
    encoder.resolveQuerySet(this.qs, 0, 4, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, buf, 0, 32);
    this._pending = { buf, hasSim: this.simWritten };
    this.simWritten = false;
  }
  // call after submit
  collect() {
    const p = this._pending; this._pending = null;
    if (!p) return;
    p.buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigUint64Array(p.buf.getMappedRange());
      const sim = p.hasSim && t[1] > t[0] ? Number(t[1] - t[0]) / 1e6 : 0;
      const ren = t[3] > t[2] ? Number(t[3] - t[2]) / 1e6 : 0;
      p.buf.unmap();
      this.free.push(p.buf);
      if (sim < 1000 && ren < 1000) {
        const a = this.samples < 5 ? 0.5 : 0.15;
        this.simMs = this.simMs * (1 - a) + sim * a;
        this.renderMs = this.renderMs * (1 - a) + ren * a;
        this.samples++;
      }
    }).catch(() => { this.free.push(p.buf); });
  }
}
