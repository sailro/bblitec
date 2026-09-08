// Page init script for scene 180: retain the bytes the source writes into
// its text-layer uniform (`text-layer-ubo`) so the native run's uploaded
// uniform bytes can be compared to the browser's, write for write.
(() => {
  const original = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset, size) {
    if (buffer.label === "text-layer-ubo") {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const unit = data instanceof ArrayBuffer || data instanceof DataView ? 1 : data.BYTES_PER_ELEMENT;
      const begin = (dataOffset ?? 0) * unit;
      const count = size === undefined ? bytes.byteLength - begin : size * unit;
      const retained = (window.__textUniform ??= new Uint8Array(96));
      retained.set(bytes.subarray(begin, begin + count), offset);
    }
    return original.apply(this, arguments);
  };
})();
