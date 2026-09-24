// Page init script for scene 180: retain the bytes the source writes into
// its text-layer uniform (`text-layer-ubo`) so the native run's uploaded
// uniform bytes can be compared to the browser's, write for write.
(() => {
    const original = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (
        buffer,
        offset,
        data,
        dataOffset,
        size,
    ) {
        if (buffer.label === "text-layer-ubo") {
            const view = ArrayBuffer.isView(data);
            const bytes = view
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            // writeBuffer counts dataOffset and size in elements of a typed
            // array and in bytes otherwise.
            const unit =
                view && "BYTES_PER_ELEMENT" in data
                    ? Number(data.BYTES_PER_ELEMENT)
                    : 1;
            const begin = (dataOffset ?? 0) * unit;
            const count =
                size === undefined ? bytes.byteLength - begin : size * unit;
            const retained = (window.__textUniform ??= new Uint8Array(96));
            retained.set(bytes.subarray(begin, begin + count), offset);
        }
        return original.call(this, buffer, offset, data, dataOffset, size);
    };
})();
